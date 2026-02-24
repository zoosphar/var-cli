// Type definitions for database tables

export interface Codebase {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  repo_url: string | null;
  default_branch: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CodebaseInsert {
  slug: string;
  name: string;
  description?: string | null;
  repo_url?: string | null;
  default_branch?: string | null;
}

export interface Folder {
  id: number;
  codebase_slug: string;
  parent_folder_id: number | null;
  relative_path: string;
  created_at: Date;
  updated_at: Date;
}

export interface File {
  id: number;
  codebase_slug: string;
  relative_path: string;
  language: string;
  hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface Symbol {
  id: number;
  codebase_slug: string;
  file_id: number;
  name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
  created_at: Date;
  updated_at: Date;
}

export interface FileEdge {
  id: number;
  codebase_slug: string;
  from_file_id: number | null; // null for external packages (source)
  to_file_id: number;          // the file that imports (destination)
  kind: FileEdgeKind;
  external_package: string | null; // package name for external deps
  created_at: Date;
}

export interface SymbolEdge {
  id: number;
  codebase_slug: string;
  from_symbol_id: number;
  to_symbol_id: number | null; // null for external symbols
  kind: SymbolEdgeKind;
  external_package: string | null; // package name for external deps
  external_symbol_name: string | null; // symbol name from external package
  created_at: Date;
}

// Symbol kinds we extract
export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "variable"
  | "const"
  | "interface"
  | "type"
  | "enum"
  | "export";

// File edge kinds
export type FileEdgeKind = "imports" | "re_exports";

// Symbol edge kinds
export type SymbolEdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "references"
  | "type_reference";

// Insert types (without auto-generated fields)
export interface FolderInsert {
  codebase_slug: string;
  parent_folder_id: number | null;
  relative_path: string;
}

export interface FileInsert {
  codebase_slug: string;
  relative_path: string;
  language: string;
  hash: string;
}

export interface SymbolInsert {
  codebase_slug: string;
  file_id: number;
  name: string;
  kind: SymbolKind;
  start_line: number;
  end_line: number;
}

export interface FileEdgeInsert {
  codebase_slug: string;
  from_file_id: number | null;  // null for external packages
  to_file_id: number;           // the file that imports
  kind: FileEdgeKind;
  external_package?: string | null;
}

export interface SymbolEdgeInsert {
  codebase_slug: string;
  from_symbol_id: number;
  to_symbol_id: number | null;
  kind: SymbolEdgeKind;
  external_package?: string | null;
  external_symbol_name?: string | null;
}

// Annotation types
export interface FolderAnnotation {
  id: number;
  codebase_slug: string;
  folder_id: number;
  responsibility: string;
  category: string;
  confidence: number; // 0-1 range
  model: string;
  created_at: Date;
}

export interface FileAnnotation {
  id: number;
  codebase_slug: string;
  file_id: number;
  responsibility: string;
  category: string;
  confidence: number; // 0-1 range
  model: string;
  created_at: Date;
}

export interface SymbolAnnotation {
  id: number;
  codebase_slug: string;
  symbol_id: number;
  responsibility: string;
  category: string;
  confidence: number; // 0-1 range
  model: string;
  created_at: Date;
}

// Annotation insert types
export interface FolderAnnotationInsert {
  codebase_slug: string;
  folder_id: number;
  responsibility: string;
  category: string;
  confidence: number;
  model: string;
}

export interface FileAnnotationInsert {
  codebase_slug: string;
  file_id: number;
  responsibility: string;
  category: string;
  confidence: number;
  model: string;
}

export interface SymbolAnnotationInsert {
  codebase_slug: string;
  symbol_id: number;
  responsibility: string;
  category: string;
  confidence: number;
  model: string;
}

