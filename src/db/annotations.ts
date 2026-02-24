import { getDb } from "./client";
import type {
  FolderAnnotation,
  FolderAnnotationInsert,
  FileAnnotation,
  FileAnnotationInsert,
  SymbolAnnotation,
  SymbolAnnotationInsert,
} from "./schema";

// Folder annotation queries
export async function insertFolderAnnotation(
  annotation: FolderAnnotationInsert
): Promise<FolderAnnotation> {
  const sql = getDb();
  const [result] = await sql<FolderAnnotation[]>`
    INSERT INTO folder_annotations (codebase_slug, folder_id, responsibility, category, confidence, model)
    VALUES (${annotation.codebase_slug}, ${annotation.folder_id}, ${annotation.responsibility}, ${annotation.category}, ${annotation.confidence}, ${annotation.model})
    RETURNING *
  `;
  return result;
}

export async function upsertFolderAnnotation(
  annotation: FolderAnnotationInsert
): Promise<FolderAnnotation> {
  const sql = getDb();
  const [result] = await sql<FolderAnnotation[]>`
    INSERT INTO folder_annotations (codebase_slug, folder_id, responsibility, category, confidence, model)
    VALUES (${annotation.codebase_slug}, ${annotation.folder_id}, ${annotation.responsibility}, ${annotation.category}, ${annotation.confidence}, ${annotation.model})
    ON CONFLICT (codebase_slug, folder_id) DO UPDATE SET
      responsibility = EXCLUDED.responsibility,
      category = EXCLUDED.category,
      confidence = EXCLUDED.confidence,
      model = EXCLUDED.model
    RETURNING *
  `;
  return result;
}

export async function getFolderAnnotation(
  codebaseSlug: string,
  folderId: number
): Promise<FolderAnnotation | undefined> {
  const sql = getDb();
  const [result] = await sql<FolderAnnotation[]>`
    SELECT * FROM folder_annotations 
    WHERE codebase_slug = ${codebaseSlug} AND folder_id = ${folderId}
  `;
  return result;
}

export async function getFolderAnnotationsByCodebase(
  codebaseSlug: string
): Promise<FolderAnnotation[]> {
  const sql = getDb();
  return sql<FolderAnnotation[]>`
    SELECT * FROM folder_annotations WHERE codebase_slug = ${codebaseSlug}
  `;
}

// File annotation queries
export async function insertFileAnnotation(
  annotation: FileAnnotationInsert
): Promise<FileAnnotation> {
  const sql = getDb();
  const [result] = await sql<FileAnnotation[]>`
    INSERT INTO file_annotations (codebase_slug, file_id, responsibility, category, confidence, model)
    VALUES (${annotation.codebase_slug}, ${annotation.file_id}, ${annotation.responsibility}, ${annotation.category}, ${annotation.confidence}, ${annotation.model})
    RETURNING *
  `;
  return result;
}

export async function upsertFileAnnotation(
  annotation: FileAnnotationInsert
): Promise<FileAnnotation> {
  const sql = getDb();
  const [result] = await sql<FileAnnotation[]>`
    INSERT INTO file_annotations (codebase_slug, file_id, responsibility, category, confidence, model)
    VALUES (${annotation.codebase_slug}, ${annotation.file_id}, ${annotation.responsibility}, ${annotation.category}, ${annotation.confidence}, ${annotation.model})
    ON CONFLICT (codebase_slug, file_id) DO UPDATE SET
      responsibility = EXCLUDED.responsibility,
      category = EXCLUDED.category,
      confidence = EXCLUDED.confidence,
      model = EXCLUDED.model
    RETURNING *
  `;
  return result;
}

export async function getFileAnnotation(
  codebaseSlug: string,
  fileId: number
): Promise<FileAnnotation | undefined> {
  const sql = getDb();
  const [result] = await sql<FileAnnotation[]>`
    SELECT * FROM file_annotations 
    WHERE codebase_slug = ${codebaseSlug} AND file_id = ${fileId}
  `;
  return result;
}

export async function getFileAnnotationsByCodebase(
  codebaseSlug: string
): Promise<FileAnnotation[]> {
  const sql = getDb();
  return sql<FileAnnotation[]>`
    SELECT * FROM file_annotations WHERE codebase_slug = ${codebaseSlug}
  `;
}

export async function hasFileAnnotation(
  codebaseSlug: string,
  fileId: number
): Promise<boolean> {
  const sql = getDb();
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count FROM file_annotations 
    WHERE codebase_slug = ${codebaseSlug} AND file_id = ${fileId}
  `;
  return parseInt(result.count, 10) > 0;
}

// Symbol annotation queries
export async function insertSymbolAnnotation(
  annotation: SymbolAnnotationInsert
): Promise<SymbolAnnotation> {
  const sql = getDb();
  const [result] = await sql<SymbolAnnotation[]>`
    INSERT INTO symbol_annotations (codebase_slug, symbol_id, responsibility, category, confidence, model)
    VALUES (${annotation.codebase_slug}, ${annotation.symbol_id}, ${annotation.responsibility}, ${annotation.category}, ${annotation.confidence}, ${annotation.model})
    RETURNING *
  `;
  return result;
}

export async function upsertSymbolAnnotation(
  annotation: SymbolAnnotationInsert
): Promise<SymbolAnnotation> {
  const sql = getDb();
  const [result] = await sql<SymbolAnnotation[]>`
    INSERT INTO symbol_annotations (codebase_slug, symbol_id, responsibility, category, confidence, model)
    VALUES (${annotation.codebase_slug}, ${annotation.symbol_id}, ${annotation.responsibility}, ${annotation.category}, ${annotation.confidence}, ${annotation.model})
    ON CONFLICT (codebase_slug, symbol_id) DO UPDATE SET
      responsibility = EXCLUDED.responsibility,
      category = EXCLUDED.category,
      confidence = EXCLUDED.confidence,
      model = EXCLUDED.model
    RETURNING *
  `;
  return result;
}

export async function insertSymbolAnnotations(
  annotations: SymbolAnnotationInsert[]
): Promise<SymbolAnnotation[]> {
  if (annotations.length === 0) return [];
  const results: SymbolAnnotation[] = [];
  for (const annotation of annotations) {
    const result = await insertSymbolAnnotation(annotation);
    results.push(result);
  }
  return results;
}

export async function getSymbolAnnotation(
  codebaseSlug: string,
  symbolId: number
): Promise<SymbolAnnotation | undefined> {
  const sql = getDb();
  const [result] = await sql<SymbolAnnotation[]>`
    SELECT * FROM symbol_annotations 
    WHERE codebase_slug = ${codebaseSlug} AND symbol_id = ${symbolId}
  `;
  return result;
}

export async function getSymbolAnnotationsByCodebase(
  codebaseSlug: string
): Promise<SymbolAnnotation[]> {
  const sql = getDb();
  return sql<SymbolAnnotation[]>`
    SELECT * FROM symbol_annotations WHERE codebase_slug = ${codebaseSlug}
  `;
}

export async function getSymbolAnnotationsByFile(
  codebaseSlug: string,
  fileId: number
): Promise<SymbolAnnotation[]> {
  const sql = getDb();
  return sql<SymbolAnnotation[]>`
    SELECT sa.* FROM symbol_annotations sa
    JOIN symbols s ON sa.symbol_id = s.id
    WHERE sa.codebase_slug = ${codebaseSlug} AND s.file_id = ${fileId}
  `;
}

// Cleanup queries
export async function clearAnnotations(codebaseSlug: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM symbol_annotations WHERE codebase_slug = ${codebaseSlug}`;
  await sql`DELETE FROM file_annotations WHERE codebase_slug = ${codebaseSlug}`;
  await sql`DELETE FROM folder_annotations WHERE codebase_slug = ${codebaseSlug}`;
}

export async function clearFileAnnotation(
  codebaseSlug: string,
  fileId: number
): Promise<void> {
  const sql = getDb();
  // Also clear symbol annotations for symbols in this file
  await sql`
    DELETE FROM symbol_annotations 
    WHERE codebase_slug = ${codebaseSlug} 
    AND symbol_id IN (SELECT id FROM symbols WHERE file_id = ${fileId})
  `;
  await sql`DELETE FROM file_annotations WHERE codebase_slug = ${codebaseSlug} AND file_id = ${fileId}`;
}
