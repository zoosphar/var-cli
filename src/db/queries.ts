import { getDb } from "./client";
import type {
  Codebase,
  CodebaseInsert,
  Folder,
  FolderInsert,
  File,
  FileInsert,
  Symbol,
  SymbolInsert,
  FileEdge,
  FileEdgeInsert,
  SymbolEdge,
  SymbolEdgeInsert,
} from "./schema";

// Codebase queries
export async function insertCodebase(codebase: CodebaseInsert): Promise<Codebase> {
  const sql = getDb();
  const [result] = await sql<Codebase[]>`
    INSERT INTO codebases (slug, name, description, repo_url, default_branch)
    VALUES (${codebase.slug}, ${codebase.name}, ${codebase.description ?? null}, ${codebase.repo_url ?? null}, ${codebase.default_branch ?? null})
    RETURNING *
  `;
  return result;
}

export async function upsertCodebase(codebase: CodebaseInsert): Promise<Codebase> {
  const sql = getDb();
  const [result] = await sql<Codebase[]>`
    INSERT INTO codebases (slug, name, description, repo_url, default_branch)
    VALUES (${codebase.slug}, ${codebase.name}, ${codebase.description ?? null}, ${codebase.repo_url ?? null}, ${codebase.default_branch ?? null})
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      repo_url = EXCLUDED.repo_url,
      default_branch = EXCLUDED.default_branch,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `;
  return result;
}

export async function getCodebaseBySlug(slug: string): Promise<Codebase | undefined> {
  const sql = getDb();
  const [result] = await sql<Codebase[]>`
    SELECT * FROM codebases WHERE slug = ${slug}
  `;
  return result;
}

// Folder queries
export async function insertFolder(folder: FolderInsert): Promise<Folder> {
  const sql = getDb();
  const [result] = await sql<Folder[]>`
    INSERT INTO folders (codebase_slug, parent_folder_id, relative_path)
    VALUES (${folder.codebase_slug}, ${folder.parent_folder_id}, ${folder.relative_path})
    RETURNING *
  `;
  return result;
}

export async function insertFolders(folders: FolderInsert[]): Promise<Folder[]> {
  if (folders.length === 0) return [];
  const results: Folder[] = [];
  for (const folder of folders) {
    const result = await insertFolder(folder);
    results.push(result);
  }
  return results;
}

export async function getFolderByPath(
  codebaseSlug: string,
  relativePath: string
): Promise<Folder | undefined> {
  const sql = getDb();
  const [result] = await sql<Folder[]>`
    SELECT * FROM folders 
    WHERE codebase_slug = ${codebaseSlug} AND relative_path = ${relativePath}
  `;
  return result;
}

// File queries
export async function insertFile(file: FileInsert): Promise<File> {
  const sql = getDb();
  const [result] = await sql<File[]>`
    INSERT INTO files (codebase_slug, relative_path, language, hash)
    VALUES (${file.codebase_slug}, ${file.relative_path}, ${file.language}, ${file.hash})
    RETURNING *
  `;
  return result;
}

export async function insertFiles(files: FileInsert[]): Promise<File[]> {
  if (files.length === 0) return [];
  const results: File[] = [];
  for (const file of files) {
    const result = await insertFile(file);
    results.push(result);
  }
  return results;
}

export async function getFileByPath(
  codebaseSlug: string,
  relativePath: string
): Promise<File | undefined> {
  const sql = getDb();
  const [result] = await sql<File[]>`
    SELECT * FROM files 
    WHERE codebase_slug = ${codebaseSlug} AND relative_path = ${relativePath}
  `;
  return result;
}

export async function getFilesByCodebase(codebaseSlug: string): Promise<File[]> {
  const sql = getDb();
  return sql<File[]>`
    SELECT * FROM files WHERE codebase_slug = ${codebaseSlug}
  `;
}

// Symbol queries
export async function insertSymbol(symbol: SymbolInsert): Promise<Symbol> {
  const sql = getDb();
  const [result] = await sql<Symbol[]>`
    INSERT INTO symbols (codebase_slug, file_id, name, kind, start_line, end_line)
    VALUES (${symbol.codebase_slug}, ${symbol.file_id}, ${symbol.name}, ${symbol.kind}, ${symbol.start_line}, ${symbol.end_line})
    RETURNING *
  `;
  return result;
}

export async function insertSymbols(symbols: SymbolInsert[]): Promise<Symbol[]> {
  if (symbols.length === 0) return [];
  const results: Symbol[] = [];
  for (const symbol of symbols) {
    const result = await insertSymbol(symbol);
    results.push(result);
  }
  return results;
}

export async function getSymbolsByFile(fileId: number): Promise<Symbol[]> {
  const sql = getDb();
  return sql<Symbol[]>`
    SELECT * FROM symbols WHERE file_id = ${fileId}
  `;
}

export async function getSymbolByName(
  codebaseSlug: string,
  name: string
): Promise<Symbol | undefined> {
  const sql = getDb();
  const [result] = await sql<Symbol[]>`
    SELECT * FROM symbols 
    WHERE codebase_slug = ${codebaseSlug} AND name = ${name}
    LIMIT 1
  `;
  return result;
}

export async function getSymbolsByCodebase(codebaseSlug: string): Promise<Symbol[]> {
  const sql = getDb();
  return sql<Symbol[]>`
    SELECT * FROM symbols WHERE codebase_slug = ${codebaseSlug}
  `;
}

// File edge queries
export async function insertFileEdge(edge: FileEdgeInsert): Promise<FileEdge> {
  const sql = getDb();
  const [result] = await sql<FileEdge[]>`
    INSERT INTO file_edges (codebase_slug, from_file_id, to_file_id, kind, external_package)
    VALUES (${edge.codebase_slug}, ${edge.from_file_id}, ${edge.to_file_id}, ${edge.kind}, ${edge.external_package ?? null})
    RETURNING *
  `;
  return result;
}

export async function insertFileEdges(edges: FileEdgeInsert[]): Promise<FileEdge[]> {
  if (edges.length === 0) return [];
  const results: FileEdge[] = [];
  for (const edge of edges) {
    const result = await insertFileEdge(edge);
    results.push(result);
  }
  return results;
}

// Symbol edge queries
export async function insertSymbolEdge(edge: SymbolEdgeInsert): Promise<SymbolEdge> {
  const sql = getDb();
  const [result] = await sql<SymbolEdge[]>`
    INSERT INTO symbol_edges (codebase_slug, from_symbol_id, to_symbol_id, kind, external_package, external_symbol_name)
    VALUES (${edge.codebase_slug}, ${edge.from_symbol_id}, ${edge.to_symbol_id}, ${edge.kind}, ${edge.external_package ?? null}, ${edge.external_symbol_name ?? null})
    RETURNING *
  `;
  return result;
}

export async function insertSymbolEdges(edges: SymbolEdgeInsert[]): Promise<SymbolEdge[]> {
  if (edges.length === 0) return [];
  const results: SymbolEdge[] = [];
  for (const edge of edges) {
    const result = await insertSymbolEdge(edge);
    results.push(result);
  }
  return results;
}

// Cleanup queries (useful for re-scanning)
// Deletes all data for a codebase but keeps the codebase record itself
export async function clearCodebaseData(codebaseSlug: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM symbol_edges WHERE codebase_slug = ${codebaseSlug}`;
  await sql`DELETE FROM file_edges WHERE codebase_slug = ${codebaseSlug}`;
  await sql`DELETE FROM symbols WHERE codebase_slug = ${codebaseSlug}`;
  await sql`DELETE FROM files WHERE codebase_slug = ${codebaseSlug}`;
  await sql`DELETE FROM folders WHERE codebase_slug = ${codebaseSlug}`;
}

// Deletes codebase and all its data completely
export async function deleteCodebase(codebaseSlug: string): Promise<void> {
  const sql = getDb();
  await clearCodebaseData(codebaseSlug);
  await sql`DELETE FROM codebases WHERE slug = ${codebaseSlug}`;
}
