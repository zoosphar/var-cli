#!/usr/bin/env bun
import { Command } from "commander";
import { resolve, basename } from "path";
import { readFile } from "fs/promises";
import { existsSync } from "fs";

import { getDb, closeDb } from "./db/client";
import {
  upsertCodebase,
  getCodebaseBySlug,
  clearCodebaseData,
  insertFolder,
  insertFile,
  insertSymbols,
  insertFileEdges,
  insertSymbolEdges,
  getFilesByCodebase,
  getSymbolsByCodebase,
} from "./db/queries";
import type { FolderInsert, FileInsert, SymbolInsert } from "./db/schema";

import { walkDirectory, type WalkedFile, type WalkedFolder } from "./scanner/walker";
import { generateCodebaseSlug, generateUniqueCodebaseSlug } from "./utils/slug";
import { hashContent } from "./utils/hash";

import { parseCode } from "./parser/treesitter";
import { extractSymbols } from "./parser/symbols";
import { extractImports, extractExports } from "./parser/imports";

import { createFileMap, resolveFileEdges, loadPathAliases } from "./edges/file-edges";
import { createSymbolMap, extractSymbolEdges } from "./edges/symbol-edges";
import { annotateCodebase } from "./annotate";
import { queryCodebase, initOpenAI } from "./tools/openai-client";
import { getCodebaseRootPath } from "./tools/symbol-search";

const program = new Command();

program
  .name("codemap")
  .description("CLI tool to scan codebases and build dependency graphs")
  .version("1.0.0");

program
  .command("scan")
  .description("Scan a codebase and populate the database with files, symbols, and edges")
  .argument("<path>", "Path to the project directory")
  .option("-n, --name <name>", "Custom name for the codebase (defaults to directory name)")
  .option("-e, --exclude <patterns...>", "Additional directories to exclude")
  .option("--fresh", "Force a fresh scan with new unique slug (ignores existing)")
  .option("--annotate", "Run LLM annotation after scanning")
  .option("--max-files <number>", "Limit number of files to annotate", parseInt)
  .action(async (projectPath: string, options) => {
    try {
      const codebaseSlug = await scanCodebase(projectPath, options);
      
      // Run annotation if requested
      if (options.annotate && codebaseSlug) {
        console.log("\n🤖 Starting LLM annotation...");
        const annotateResult = await annotateCodebase(codebaseSlug, resolve(projectPath), {
          maxFiles: options.maxFiles,
          verbose: true,
          workers: 5,
        });
        
        console.log("\n✅ Annotation complete!");
        console.log(`   - Files annotated: ${annotateResult.filesProcessed}`);
        console.log(`   - Symbols annotated: ${annotateResult.symbolsProcessed}`);
        console.log(`   - Folders annotated: ${annotateResult.foldersProcessed}`);
        if (annotateResult.errors.length > 0) {
          console.log(`   - Errors: ${annotateResult.errors.length}`);
        }
      }
    } catch (error) {
      console.error("Error scanning codebase:", error);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

program
  .command("annotate")
  .description("Annotate a scanned codebase using LLM to infer purpose and categories")
  .argument("<codebase-slug>", "The codebase slug to annotate")
  .option("--force", "Re-annotate even if annotations exist")
  .option("--max-files <number>", "Limit number of files to process", parseInt)
  .option("--folder <path>", "Only annotate files in this folder (e.g., 'src/components')")
  .option("--workers <number>", "Number of parallel workers (default: 5)", parseInt)
  .option("-v, --verbose", "Show detailed progress")
  .action(async (codebaseSlug: string, options) => {
    try {
      // Verify codebase exists
      const codebase = await getCodebaseBySlug(codebaseSlug);
      if (!codebase) {
        console.error(`Error: Codebase '${codebaseSlug}' not found`);
        console.error("Run 'codemap scan <path>' first to create a codebase");
        process.exit(1);
      }
      
      // Get root path from codebase description (hacky but works)
      const rootPathMatch = codebase.description?.match(/Scanned from (.+)/);
      const rootPath = rootPathMatch ? rootPathMatch[1] : process.cwd();
      
      console.log(`\n🤖 Annotating codebase: ${codebaseSlug}`);
      console.log(`   Path: ${rootPath}\n`);
      
      const result = await annotateCodebase(codebaseSlug, rootPath, {
        force: options.force,
        maxFiles: options.maxFiles,
        verbose: options.verbose,
        folderPath: options.folder,
        workers: options.workers,
      });
      
      console.log("\n✅ Annotation complete!");
      console.log("   Summary:");
      console.log(`   - Files annotated: ${result.filesProcessed}`);
      console.log(`   - Symbols annotated: ${result.symbolsProcessed}`);
      console.log(`   - Folders annotated: ${result.foldersProcessed}`);
      if (result.errors.length > 0) {
        console.log(`   - Errors: ${result.errors.length}`);
      }
      console.log("");
      
    } catch (error) {
      console.error("Error annotating codebase:", error);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

program
  .command("query")
  .description("Query a codebase using AI to find and analyze relevant code")
  .argument("<codebase-slug>", "The codebase slug to query")
  .argument("[question]", "Your question about the codebase")
  .option("--api-key <key>", "OpenAI API key (or set OPENAI_API_KEY env var)")
  .option("--model <model>", "OpenAI model to use (default: gpt-4-turbo-preview)", "gpt-4.1")
  .option("--temperature <number>", "Temperature for LLM (default: 0.3)", parseFloat, 0.3)
  .option("--interactive", "Interactive mode - keep asking questions")
  .action(async (codebaseSlug: string, question: string | undefined, options) => {
    try {
      // Validate codebase slug is provided
      if (!codebaseSlug || codebaseSlug.trim() === "" || codebaseSlug === "default") {
        console.error(`Error: Codebase slug is required`);
        console.error(`Usage: codemap query <codebase-slug> [question]`);
        console.error(`   Or: codemap query <codebase-slug> --interactive`);
        console.error(`\nExample: codemap query my-project-123 "How does login work?"`);
        process.exit(1);
      }
      
      // Debug: Log what we received
      console.log(`\n🔍 Debug: Received arguments:`);
      console.log(`   codebaseSlug: "${codebaseSlug}"`);
      console.log(`   question: "${question || '(not provided)'}"`);
      console.log(`   options:`, options);
      
      // Verify codebase exists
      const codebase = await getCodebaseBySlug(codebaseSlug);
      if (!codebase) {
        console.error(`Error: Codebase '${codebaseSlug}' not found`);
        console.error("Run 'codemap scan <path>' first to create a codebase");
        process.exit(1);
      }
      
      // Verify root path can be determined
      const rootPath = await getCodebaseRootPath(codebaseSlug);
      if (!rootPath) {
        console.error(`Error: Could not determine root path for codebase '${codebaseSlug}'`);
        if (codebase.description) {
          console.error(`Codebase description: "${codebase.description}"`);
          console.error("Expected format: 'Scanned from /path/to/project'");
        } else {
          console.error("Codebase has no description. Please re-scan the codebase.");
        }
        console.error("\nTry running: codemap scan <path> --name <name>");
        process.exit(1);
      }
      
      // Initialize OpenAI
      if (options.apiKey) {
        initOpenAI(options.apiKey);
      } else {
        initOpenAI();
      }
      
      // Interactive mode
      if (options.interactive) {
        const readline = await import("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        
        const askQuestion = (): Promise<void> => {
          return new Promise((resolve) => {
            rl.question("\n💬 Your question (or 'exit' to quit): ", async (query) => {
              if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") {
                rl.close();
                resolve();
                return;
              }
              
              if (!query.trim()) {
                resolve(askQuestion());
                return;
              }
              
              try {
                console.log("\n🔍 Searching codebase...");
                const result = await queryCodebase({
                  query,
                  codebaseSlug,
                  model: options.model,
                  temperature: options.temperature,
                });
                
                console.log("\n📝 Answer:");
                console.log(result.answer);
                
                if (result.symbolsUsed.length > 0) {
                  console.log("\n📚 Symbols referenced:");
                  for (const sym of result.symbolsUsed) {
                    console.log(`   - ${sym.symbol_name} (${sym.symbol_kind}) in ${sym.file_path}`);
                  }
                }
                
                resolve(askQuestion());
              } catch (error: any) {
                console.error(`\n❌ Error: ${error.message}`);
                resolve(askQuestion());
              }
            });
          });
        };
        
        console.log(`\n🤖 Interactive query mode for: ${codebaseSlug}`);
        console.log("Ask questions about the codebase. Type 'exit' to quit.\n");
        await askQuestion();
      } else {
        // Single query mode
        if (!question) {
          console.error("Error: Question is required in non-interactive mode");
          console.error("Usage: codemap query <codebase-slug> <question>");
          console.error("Or use --interactive for interactive mode");
          process.exit(1);
        }
        
        console.log(`\n🔍 Querying codebase: ${codebaseSlug}`);
        console.log(`📝 Question: ${question}\n`);
        
        const result = await queryCodebase({
          query: question,
          codebaseSlug,
          model: options.model,
          temperature: options.temperature,
        });
        
        console.log("\n📝 Answer:");
        console.log(result.answer);
        
        if (result.symbolsUsed.length > 0) {
          console.log("\n📚 Symbols referenced:");
          for (const sym of result.symbolsUsed) {
            console.log(`   - ${sym.symbol_name} (${sym.symbol_kind}) in ${sym.file_path}`);
          }
        }
        
        console.log("");
      }
      
    } catch (error) {
      console.error("Error querying codebase:", error);
      process.exit(1);
    } finally {
      await closeDb();
    }
  });

interface ScanOptions {
  name?: string;
  exclude?: string[];
  fresh?: boolean;
  annotate?: boolean;
  maxFiles?: number;
}

async function scanCodebase(projectPath: string, options: ScanOptions): Promise<string> {
  const absolutePath = resolve(projectPath);
  
  if (!existsSync(absolutePath)) {
    throw new Error(`Project path does not exist: ${absolutePath}`);
  }
  
  // Generate slug - use unique (with timestamp) if --fresh, otherwise deterministic
  const codebaseSlug = options.fresh 
    ? generateUniqueCodebaseSlug(absolutePath, options.name)
    : generateCodebaseSlug(absolutePath, options.name);
  
  console.log(`\n📦 Scanning codebase: ${codebaseSlug}`);
  console.log(`   Path: ${absolutePath}\n`);
  
  // Initialize database connection
  const db = getDb();
  
  // Phase 0: Create or update codebase record
  const codebaseName = options.name || basename(absolutePath);
  const existingCodebase = await getCodebaseBySlug(codebaseSlug);
  
  if (existingCodebase) {
    console.log("📦 Found existing codebase, updating...");
    console.log("🧹 Clearing old data...");
    await clearCodebaseData(codebaseSlug);
  } else {
    console.log("📦 Creating new codebase record...");
  }
  
  await upsertCodebase({
    slug: codebaseSlug,
    name: codebaseName,
    description: `Scanned from ${absolutePath}`,
  });
  
  // Phase 1: Walk directory and collect files/folders
  console.log("📂 Walking directory structure...");
  const { files, folders } = await walkDirectory(absolutePath, {
    excludeDirs: options.exclude,
  });
  
  console.log(`   Found ${folders.length} folders and ${files.length} files\n`);
  
  // Phase 2: Insert folders
  console.log("💾 Inserting folders...");
  const folderPathToId = new Map<string, number>();
  
  for (const folder of folders) {
    const parentId = folder.parentRelativePath
      ? folderPathToId.get(folder.parentRelativePath) ?? null
      : null;
    
    const inserted = await insertFolder({
      codebase_slug: codebaseSlug,
      parent_folder_id: parentId,
      relative_path: folder.relativePath,
    });
    
    folderPathToId.set(folder.relativePath, inserted.id);
  }
  
  // Phase 3: Process files and extract symbols
  console.log("📝 Processing files and extracting symbols...");
  
  const fileRecords: Array<{ file: Awaited<ReturnType<typeof insertFile>>; walkedFile: WalkedFile; content: string }> = [];
  
  for (const walkedFile of files) {
    const content = await readFile(walkedFile.absolutePath, "utf-8");
    const hash = hashContent(content);
    
    const fileRecord = await insertFile({
      codebase_slug: codebaseSlug,
      relative_path: walkedFile.relativePath,
      language: walkedFile.language,
      hash,
    });
    
    fileRecords.push({ file: fileRecord, walkedFile, content });
  }
  
  // Phase 4: Extract and insert symbols for each file
  console.log("🔍 Extracting symbols...");
  let totalSymbols = 0;
  
  const allSymbolInserts: Map<number, SymbolInsert[]> = new Map();
  const parsedTrees: Map<number, ReturnType<typeof parseCode>> = new Map();
  const fileContents: Map<number, string> = new Map();
  
  for (const { file, walkedFile, content } of fileRecords) {
    const tree = parseCode(content, walkedFile.language);
    if (!tree) {
      console.warn(`   ⚠️  Could not parse: ${walkedFile.relativePath}`);
      continue;
    }
    
    parsedTrees.set(file.id, tree);
    fileContents.set(file.id, content);
    
    const extractedSymbols = extractSymbols(tree);
    
    if (extractedSymbols.length > 0) {
      const symbolInserts: SymbolInsert[] = extractedSymbols.map((sym) => ({
        codebase_slug: codebaseSlug,
        file_id: file.id,
        name: sym.name,
        kind: sym.kind,
        start_line: sym.startLine,
        end_line: sym.endLine,
      }));
      
      allSymbolInserts.set(file.id, symbolInserts);
      totalSymbols += extractedSymbols.length;
    }
  }
  
  // Batch insert all symbols
  const insertedSymbolsByFile = new Map<number, Awaited<ReturnType<typeof insertSymbols>>>();
  
  for (const [fileId, symbolInserts] of allSymbolInserts) {
    const inserted = await insertSymbols(symbolInserts);
    insertedSymbolsByFile.set(fileId, inserted);
  }
  
  console.log(`   Extracted ${totalSymbols} symbols\n`);
  
  // Phase 5: Create file edges
  console.log("🔗 Resolving file dependencies...");
  
  // Get all inserted files
  const allFiles = await getFilesByCodebase(codebaseSlug);
  const fileMap = createFileMap(allFiles, absolutePath);
  
  // Load path aliases from tsconfig.json
  const pathAliases = loadPathAliases(absolutePath);
  console.log(`   Loaded path aliases: ${Object.keys(pathAliases).join(", ")}`);
  
  let totalFileEdges = 0;
  
  for (const { file, walkedFile } of fileRecords) {
    const tree = parsedTrees.get(file.id);
    if (!tree) continue;
    
    const imports = extractImports(tree);
    const exports = extractExports(tree);
    
    const fileEdges = resolveFileEdges(file, imports, exports, fileMap, absolutePath, codebaseSlug, pathAliases);
    
    if (fileEdges.length > 0) {
      await insertFileEdges(fileEdges);
      totalFileEdges += fileEdges.length;
    }
  }
  
  console.log(`   Created ${totalFileEdges} file edges\n`);
  
  // Phase 6: Create symbol edges
  console.log("🔗 Resolving symbol dependencies...");
  
  // Get all inserted symbols
  const allSymbols = await getSymbolsByCodebase(codebaseSlug);
  const symbolMap = createSymbolMap(allSymbols);
  
  let totalSymbolEdges = 0;
  
  for (const { file, walkedFile } of fileRecords) {
    const tree = parsedTrees.get(file.id);
    if (!tree) continue;
    
    const fileSymbols = symbolMap.byFileId.get(file.id) || [];
    if (fileSymbols.length === 0) continue;
    
    const imports = extractImports(tree);
    const symbolEdges = extractSymbolEdges(tree, fileSymbols, imports, symbolMap, codebaseSlug);
    
    if (symbolEdges.length > 0) {
      await insertSymbolEdges(symbolEdges);
      totalSymbolEdges += symbolEdges.length;
    }
  }
  
  console.log(`   Created ${totalSymbolEdges} symbol edges\n`);
  
  // Summary
  console.log("✅ Scan complete!");
  console.log("   Summary:");
  console.log(`   - Codebase slug: ${codebaseSlug}`);
  console.log(`   - Folders: ${folders.length}`);
  console.log(`   - Files: ${files.length}`);
  console.log(`   - Symbols: ${totalSymbols}`);
  console.log(`   - File edges: ${totalFileEdges}`);
  console.log(`   - Symbol edges: ${totalSymbolEdges}`);
  console.log("");
  
  return codebaseSlug;
}

program.parse();

