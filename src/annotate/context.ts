import { readFile } from "fs/promises";
import { resolve } from "path";
import { getDb } from "../db/client";
import type { File, Symbol, FileEdge, SymbolEdge } from "../db/schema";

export interface SymbolContext {
  id: number;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  edges: SymbolEdgeContext[];
}

export interface SymbolEdgeContext {
  kind: string;
  targetSymbolName: string | null;
  targetFileName: string | null;
  externalPackage: string | null;
  // Nested edges (2nd level)
  nestedEdges?: SymbolEdgeContext[];
}

export interface FileEdgeContext {
  kind: string;
  filePath: string | null;
  externalPackage: string | null;
}

export interface AnnotationContext {
  file: {
    id: number;
    path: string;
    language: string;
    content: string;
    contentWithMarkers: string;
  };
  symbols: SymbolContext[];
  imports: FileEdgeContext[];      // Files this file imports from
  importedBy: FileEdgeContext[];   // Files that import this file
}

// Build full annotation context for a file
export async function buildAnnotationContext(
  file: File,
  rootPath: string,
  codebaseSlug: string
): Promise<AnnotationContext> {
  const sql = getDb();
  
  // Read file content
  const absolutePath = resolve(rootPath, file.relative_path);
  let content: string;
  try {
    content = await readFile(absolutePath, "utf-8");
  } catch (error) {
    content = "// File content could not be read";
  }
  
  // Get symbols for this file
  const symbols = await sql<Symbol[]>`
    SELECT * FROM symbols 
    WHERE codebase_slug = ${codebaseSlug} AND file_id = ${file.id}
    ORDER BY start_line
  `;
  
  // Get file edges (imports)
  const fileImports = await sql<(FileEdge & { from_path: string | null })[]>`
    SELECT fe.*, f.relative_path as from_path
    FROM file_edges fe
    LEFT JOIN files f ON fe.from_file_id = f.id
    WHERE fe.codebase_slug = ${codebaseSlug} AND fe.to_file_id = ${file.id}
  `;
  
  // Get file edges (imported by - files that import this file)
  const fileImportedBy = await sql<(FileEdge & { to_path: string | null })[]>`
    SELECT fe.*, f.relative_path as to_path
    FROM file_edges fe
    LEFT JOIN files f ON fe.to_file_id = f.id
    WHERE fe.codebase_slug = ${codebaseSlug} AND fe.from_file_id = ${file.id}
  `;
  
  // Build symbol contexts with edges
  const symbolContexts: SymbolContext[] = [];
  
  for (const symbol of symbols) {
    const symbolEdges = await getSymbolEdgesWithDepth(
      symbol.id,
      codebaseSlug,
      2 // depth of 2-3 levels
    );
    
    symbolContexts.push({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.start_line,
      endLine: symbol.end_line,
      edges: symbolEdges,
    });
  }
  
  // Create content with symbol markers
  const contentWithMarkers = addSymbolMarkers(content, symbolContexts);
  
  return {
    file: {
      id: file.id,
      path: file.relative_path,
      language: file.language,
      content,
      contentWithMarkers,
    },
    symbols: symbolContexts,
    imports: fileImports.map((e) => ({
      kind: e.kind,
      filePath: e.from_path,
      externalPackage: e.external_package,
    })),
    importedBy: fileImportedBy.map((e) => ({
      kind: e.kind,
      filePath: e.to_path,
      externalPackage: null,
    })),
  };
}

// Get symbol edges with nested depth
async function getSymbolEdgesWithDepth(
  symbolId: number,
  codebaseSlug: string,
  depth: number
): Promise<SymbolEdgeContext[]> {
  if (depth <= 0) return [];
  
  const sql = getDb();
  
  // Get direct edges from this symbol
  const edges = await sql<(SymbolEdge & { 
    target_name: string | null;
    target_file_path: string | null;
  })[]>`
    SELECT 
      se.*,
      s.name as target_name,
      f.relative_path as target_file_path
    FROM symbol_edges se
    LEFT JOIN symbols s ON se.to_symbol_id = s.id
    LEFT JOIN files f ON s.file_id = f.id
    WHERE se.codebase_slug = ${codebaseSlug} AND se.from_symbol_id = ${symbolId}
    LIMIT 10
  `;
  
  const edgeContexts: SymbolEdgeContext[] = [];
  
  for (const edge of edges) {
    const edgeContext: SymbolEdgeContext = {
      kind: edge.kind,
      targetSymbolName: edge.target_name,
      targetFileName: edge.target_file_path,
      externalPackage: edge.external_package,
    };
    
    // Get nested edges if we have a target symbol and depth remaining
    if (edge.to_symbol_id && depth > 1) {
      edgeContext.nestedEdges = await getSymbolEdgesWithDepth(
        edge.to_symbol_id,
        codebaseSlug,
        depth - 1
      );
    }
    
    edgeContexts.push(edgeContext);
  }
  
  return edgeContexts;
}

// Add markers to highlight symbols in the code
function addSymbolMarkers(content: string, symbols: SymbolContext[]): string {
  const lines = content.split("\n");
  
  // Sort symbols by start line (descending) to insert markers from bottom to top
  const sortedSymbols = [...symbols].sort((a, b) => b.startLine - a.startLine);
  
  for (const symbol of sortedSymbols) {
    const startIdx = symbol.startLine - 1; // Convert to 0-indexed
    const endIdx = symbol.endLine - 1;
    
    if (startIdx >= 0 && startIdx < lines.length) {
      // Add start marker before the symbol
      lines[startIdx] = `// >>> SYMBOL: ${symbol.name} (${symbol.kind}) <<<\n${lines[startIdx]}`;
    }
    
    if (endIdx >= 0 && endIdx < lines.length && endIdx !== startIdx) {
      // Add end marker after the symbol
      lines[endIdx] = `${lines[endIdx]}\n// >>> END: ${symbol.name} <<<`;
    }
  }
  
  return lines.join("\n");
}

// Format edges for prompt context
export function formatEdgesForPrompt(context: AnnotationContext): string {
  const parts: string[] = [];
  
  // Format imports
  if (context.imports.length > 0) {
    const importList = context.imports.map((e) => {
      if (e.externalPackage) {
        return `  - ${e.externalPackage} (external package)`;
      }
      return `  - ${e.filePath}`;
    });
    parts.push(`This file imports from:\n${importList.join("\n")}`);
  }
  
  // Format imported by
  if (context.importedBy.length > 0) {
    const importedByList = context.importedBy.map((e) => `  - ${e.filePath}`);
    parts.push(`This file is imported by:\n${importedByList.join("\n")}`);
  }
  
  // Format symbol dependencies (summarized)
  const symbolsWithEdges = context.symbols.filter((s) => s.edges.length > 0);
  if (symbolsWithEdges.length > 0) {
    const symbolDeps = symbolsWithEdges.slice(0, 5).map((s) => {
      const deps = s.edges.slice(0, 3).map((e) => {
        if (e.externalPackage) {
          return `${e.externalPackage}.${e.targetSymbolName || "?"}`;
        }
        return e.targetSymbolName || "unknown";
      });
      return `  - ${s.name} uses: ${deps.join(", ")}`;
    });
    parts.push(`Key symbol dependencies:\n${symbolDeps.join("\n")}`);
  }
  
  return parts.join("\n\n");
}

// Build context for folder annotation (aggregating child info)
export interface FolderAnnotationContext {
  folderId: number;
  path: string;
  childFiles: { path: string; category: string | null; responsibility: string | null }[];
  childFolders: { path: string; category: string | null; responsibility: string | null }[];
}

export async function buildFolderContext(
  folderId: number,
  codebaseSlug: string
): Promise<FolderAnnotationContext> {
  const sql = getDb();
  
  // Get folder info
  const [folder] = await sql<{ relative_path: string }[]>`
    SELECT relative_path FROM folders WHERE id = ${folderId}
  `;
  
  // Get child files with their annotations
  const childFiles = await sql<{
    relative_path: string;
    category: string | null;
    responsibility: string | null;
  }[]>`
    SELECT 
      f.relative_path,
      fa.category,
      fa.responsibility
    FROM files f
    LEFT JOIN file_annotations fa ON f.id = fa.file_id AND fa.codebase_slug = ${codebaseSlug}
    WHERE f.codebase_slug = ${codebaseSlug}
    AND f.relative_path LIKE ${folder.relative_path + "/%"}
    AND f.relative_path NOT LIKE ${folder.relative_path + "/%/%"}
  `;
  
  // Get child folders with their annotations
  const childFolders = await sql<{
    relative_path: string;
    category: string | null;
    responsibility: string | null;
  }[]>`
    SELECT 
      fo.relative_path,
      foa.category,
      foa.responsibility
    FROM folders fo
    LEFT JOIN folder_annotations foa ON fo.id = foa.folder_id AND foa.codebase_slug = ${codebaseSlug}
    WHERE fo.codebase_slug = ${codebaseSlug}
    AND fo.parent_folder_id = ${folderId}
  `;
  
  return {
    folderId,
    path: folder.relative_path,
    childFiles: childFiles.map((f) => ({
      path: f.relative_path,
      category: f.category,
      responsibility: f.responsibility,
    })),
    childFolders: childFolders.map((f) => ({
      path: f.relative_path,
      category: f.category,
      responsibility: f.responsibility,
    })),
  };
}

