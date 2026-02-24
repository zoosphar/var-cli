import { getDb } from "../db/client";
import type { File, Folder, Symbol } from "../db/schema";
import {
  upsertFileAnnotation,
  upsertSymbolAnnotation,
  upsertFolderAnnotation,
  hasFileAnnotation,
  clearAnnotations,
} from "../db/annotations";
import { buildAnnotationContext, buildFolderContext } from "./context";
import { buildFileAnnotationPrompt, buildFolderAnnotationPrompt, truncateContent } from "./prompts";
import { generateJSON, getModelName, initGemini } from "./gemini";
import { parseFileAnnotationResponse, parseFolderAnnotationResponse, extractJSON } from "./parser";
import type { FileAnnotationResponse, FolderAnnotationResponse } from "./prompts";

export interface AnnotateOptions {
  force?: boolean;       // Re-annotate even if annotations exist
  maxFiles?: number;     // Limit number of files to process
  verbose?: boolean;     // Show detailed progress
  delayMs?: number;      // Delay between API calls
  folderPath?: string;   // Only annotate files in this folder
  workers?: number;      // Number of parallel workers (default: 5)
}

export interface AnnotateResult {
  filesProcessed: number;
  symbolsProcessed: number;
  foldersProcessed: number;
  errors: string[];
}

interface FileProcessResult {
  fileId: number;
  filePath: string;
  success: boolean;
  symbolsCount: number;
  error?: string;
  fileAnnotation?: { category: string; responsibility: string };
}

// Process a single file
async function processFile(
  file: File,
  rootPath: string,
  codebaseSlug: string,
  modelName: string,
  options: AnnotateOptions,
  workerId: number
): Promise<FileProcessResult> {
  const prefix = options.workers && options.workers > 1 ? `[W${workerId}]` : "";
  
  try {
    // Build context
    const context = await buildAnnotationContext(file, rootPath, codebaseSlug);
    
    // Truncate content if too long
    context.file.contentWithMarkers = truncateContent(context.file.contentWithMarkers);
    
    // Build prompt and call LLM
    const prompt = buildFileAnnotationPrompt(context);
    
    const rawResponse = await generateJSON<unknown>(prompt, {
      delayBetweenCalls: options.delayMs || 200,
    });
    
    // Parse response
    const parsed = parseFileAnnotationResponse(rawResponse);
    
    if (!parsed) {
      throw new Error("Failed to parse LLM response");
    }
    
    // Insert file annotation
    await upsertFileAnnotation({
      codebase_slug: codebaseSlug,
      file_id: file.id,
      responsibility: parsed.file.responsibility,
      category: parsed.file.category,
      confidence: parsed.file.confidence,
      model: modelName,
    });
    
    // Insert symbol annotations
    let symbolsCount = 0;
    for (const symbol of context.symbols) {
      const symbolAnnotation = parsed.symbols[symbol.name];
      
      if (symbolAnnotation) {
        await upsertSymbolAnnotation({
          codebase_slug: codebaseSlug,
          symbol_id: symbol.id,
          responsibility: symbolAnnotation.responsibility,
          category: symbolAnnotation.category,
          confidence: symbolAnnotation.confidence,
          model: modelName,
        });
        symbolsCount++;
      }
    }
    
    return {
      fileId: file.id,
      filePath: file.relative_path,
      success: true,
      symbolsCount,
      fileAnnotation: {
        category: parsed.file.category,
        responsibility: parsed.file.responsibility,
      },
    };
    
  } catch (error: any) {
    return {
      fileId: file.id,
      filePath: file.relative_path,
      success: false,
      symbolsCount: 0,
      error: error.message,
    };
  }
}

// Split array into chunks
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Main annotation function
export async function annotateCodebase(
  codebaseSlug: string,
  rootPath: string,
  options: AnnotateOptions = {}
): Promise<AnnotateResult> {
  const sql = getDb();
  const modelName = getModelName();
  const numWorkers = options.workers || 5;
  
  // Initialize Gemini
  initGemini();
  
  const result: AnnotateResult = {
    filesProcessed: 0,
    symbolsProcessed: 0,
    foldersProcessed: 0,
    errors: [],
  };
  
  // Clear existing annotations if force is set
  if (options.force) {
    console.log("🧹 Clearing existing annotations...");
    await clearAnnotations(codebaseSlug);
  }
  
  // Get files for this codebase (optionally filtered by folder)
  let allFiles: File[];
  
  if (options.folderPath) {
    const folderPattern = options.folderPath.endsWith('/') 
      ? options.folderPath 
      : options.folderPath + '/';
    
    allFiles = await sql<File[]>`
      SELECT * FROM files 
      WHERE codebase_slug = ${codebaseSlug}
      AND (relative_path LIKE ${folderPattern + '%'} OR relative_path LIKE ${options.folderPath})
      ORDER BY relative_path
    `;
    console.log(`\n📁 Filtering to folder: ${options.folderPath}`);
  } else {
    allFiles = await sql<File[]>`
      SELECT * FROM files 
      WHERE codebase_slug = ${codebaseSlug}
      ORDER BY relative_path
    `;
  }
  
  // Filter out already annotated files if not forcing
  let filesToProcess: File[] = [];
  if (!options.force) {
    for (const file of allFiles) {
      const exists = await hasFileAnnotation(codebaseSlug, file.id);
      if (!exists) {
        filesToProcess.push(file);
      }
    }
    if (filesToProcess.length < allFiles.length) {
      console.log(`   Skipping ${allFiles.length - filesToProcess.length} already annotated files`);
    }
  } else {
    filesToProcess = [...allFiles];
  }
  
  // Limit files if specified
  const files = (options.maxFiles && options.maxFiles > 0)
    ? filesToProcess.slice(0, options.maxFiles)
    : filesToProcess;
  
  console.log(`📝 Annotating ${files.length} files with ${numWorkers} parallel workers...`);
  
  // Split files into batches for parallel processing
  const batches = chunkArray(files, numWorkers);
  let processedCount = 0;
  
  for (const batch of batches) {
    // Process batch in parallel
    const promises = batch.map((file, idx) => 
      processFile(file, rootPath, codebaseSlug, modelName, options, idx + 1)
    );
    
    const results = await Promise.all(promises);
    
    // Process results
    for (const fileResult of results) {
      processedCount++;
      const progress = `[${processedCount}/${files.length}]`;
      
      if (fileResult.success) {
        result.filesProcessed++;
        result.symbolsProcessed += fileResult.symbolsCount;
        
        if (options.verbose && fileResult.fileAnnotation) {
          console.log(`${progress} ✓ ${fileResult.filePath}`);
          console.log(`       ${fileResult.fileAnnotation.category} | ${fileResult.fileAnnotation.responsibility.slice(0, 50)}...`);
          console.log(`       Symbols: ${fileResult.symbolsCount}`);
        } else {
          console.log(`${progress} ✓ ${fileResult.filePath} (${fileResult.symbolsCount} symbols)`);
        }
      } else {
        result.errors.push(`${fileResult.filePath}: ${fileResult.error}`);
        console.log(`${progress} ✗ ${fileResult.filePath}: ${fileResult.error}`);
      }
    }
  }
  
  // Process folders (bottom-up)
  if (options.folderPath) {
    console.log("\n📁 Skipping folder annotation (single folder mode)");
  } else {
    console.log("\n📁 Annotating folders...");
    
    const folders = await sql<Folder[]>`
      SELECT * FROM folders 
      WHERE codebase_slug = ${codebaseSlug}
      ORDER BY LENGTH(relative_path) DESC
    `;
    
    // Process folders in parallel batches too
    const folderBatches = chunkArray([...folders], numWorkers);
    
    for (const batch of folderBatches) {
      const folderPromises = batch.map(async (folder) => {
        try {
          const folderContext = await buildFolderContext(folder.id, codebaseSlug);
          
          // Skip empty folders
          if (folderContext.childFiles.length === 0 && folderContext.childFolders.length === 0) {
            return { folder, success: true, skipped: true };
          }
          
          const prompt = buildFolderAnnotationPrompt(folderContext);
          
          const rawResponse = await generateJSON<unknown>(prompt, {
            delayBetweenCalls: options.delayMs || 200,
          });
          
          const parsed = parseFolderAnnotationResponse(rawResponse);
          
          if (!parsed) {
            throw new Error("Failed to parse folder annotation response");
          }
          
          await upsertFolderAnnotation({
            codebase_slug: codebaseSlug,
            folder_id: folder.id,
            responsibility: parsed.responsibility,
            category: parsed.category,
            confidence: parsed.confidence,
            model: modelName,
          });
          
          return { folder, success: true, parsed };
          
        } catch (error: any) {
          return { folder, success: false, error: error.message };
        }
      });
      
      const folderResults = await Promise.all(folderPromises);
      
      for (const folderResult of folderResults) {
        if (folderResult.success && !folderResult.skipped) {
          result.foldersProcessed++;
          if (options.verbose && folderResult.parsed) {
            console.log(`   ✓ ${folderResult.folder.relative_path}: ${folderResult.parsed.category}`);
          }
        } else if (!folderResult.success) {
          result.errors.push(`Folder ${folderResult.folder.relative_path}: ${folderResult.error}`);
          if (options.verbose) {
            console.error(`   ✗ ${folderResult.folder.relative_path}: ${folderResult.error}`);
          }
        }
      }
    }
  }
  
  return result;
}

// Export for use in CLI
export { initGemini } from "./gemini";
