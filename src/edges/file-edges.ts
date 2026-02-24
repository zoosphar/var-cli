import { resolve, dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
import type { ExtractedImport, ExtractedExport } from "../parser/imports";
import { isExternalImport, getPackageName, isPathAlias } from "../parser/imports";
import type { FileEdgeInsert, FileEdgeKind } from "../db/schema";
import type { File } from "../db/schema";

export interface FileEdgeInfo {
  fromFilePath: string;
  toFilePath: string | null; // null for external packages
  kind: FileEdgeKind;
  externalPackage: string | null;
}

interface FileMap {
  // Map of relative path -> file record
  byRelativePath: Map<string, File>;
  // Map of absolute path -> file record
  byAbsolutePath: Map<string, File>;
}

// Path alias configuration
export interface PathAliasConfig {
  [alias: string]: string; // e.g., "@/": "./src/" or "@/": "./"
}

// Default path alias mappings (common conventions)
const DEFAULT_PATH_ALIASES: PathAliasConfig = {
  "@/": "./",      // Most common in Next.js
  "~/": "./",      // Alternative convention
  "#/": "./",      // Less common
  "src/": "./src/",
};

export function createFileMap(files: File[], rootPath: string): FileMap {
  const byRelativePath = new Map<string, File>();
  const byAbsolutePath = new Map<string, File>();
  
  for (const file of files) {
    byRelativePath.set(file.relative_path, file);
    byAbsolutePath.set(resolve(rootPath, file.relative_path), file);
  }
  
  return { byRelativePath, byAbsolutePath };
}

// Try to load path aliases from tsconfig.json
export function loadPathAliases(rootPath: string): PathAliasConfig {
  const tsconfigPath = join(rootPath, "tsconfig.json");
  
  if (!existsSync(tsconfigPath)) {
    return DEFAULT_PATH_ALIASES;
  }
  
  try {
    const content = readFileSync(tsconfigPath, "utf-8");
    // Remove comments (simple approach - doesn't handle all edge cases)
    const jsonContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const tsconfig = JSON.parse(jsonContent);
    
    const paths = tsconfig?.compilerOptions?.paths || {};
    const baseUrl = tsconfig?.compilerOptions?.baseUrl || ".";
    
    const aliases: PathAliasConfig = {};
    
    for (const [alias, targets] of Object.entries(paths)) {
      if (Array.isArray(targets) && targets.length > 0) {
        // Convert "@/*" -> "@/" and "./*" -> "./"
        const aliasPrefix = alias.replace("*", "");
        const targetPrefix = (targets[0] as string).replace("*", "");
        aliases[aliasPrefix] = join(baseUrl, targetPrefix);
      }
    }
    
    // Merge with defaults (tsconfig takes precedence)
    return { ...DEFAULT_PATH_ALIASES, ...aliases };
  } catch (error) {
    console.warn(`Warning: Could not parse tsconfig.json: ${error}`);
    return DEFAULT_PATH_ALIASES;
  }
}

export function resolveFileEdges(
  currentFile: File,  // The file we're analyzing (contains the import statements)
  imports: ExtractedImport[],
  exports: ExtractedExport[],
  fileMap: FileMap,
  rootPath: string,
  codebaseSlug: string,
  pathAliases: PathAliasConfig = DEFAULT_PATH_ALIASES
): FileEdgeInsert[] {
  const edges: FileEdgeInsert[] = [];
  const seenEdges = new Set<string>();
  
  const currentAbsPath = resolve(rootPath, currentFile.relative_path);
  const fromDir = dirname(currentAbsPath);
  
  // Process imports
  // Edge direction: from_file_id (source/imported file) -> to_file_id (destination/importing file)
  for (const imp of imports) {
    if (isExternalImport(imp.source)) {
      // External package import
      const packageName = getPackageName(imp.source);
      const edgeKey = `null:${currentFile.id}:imports:${packageName}`;
      
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          codebase_slug: codebaseSlug,
          from_file_id: null,           // external package (no file id)
          to_file_id: currentFile.id,   // the file that imports
          kind: "imports",
          external_package: packageName,
        });
      }
    } else {
      // Internal import - resolve the path (handles both relative and aliased)
      const resolvedPath = resolveImportPath(imp.source, fromDir, rootPath, fileMap, pathAliases);
      if (resolvedPath) {
        const sourceFile = fileMap.byAbsolutePath.get(resolvedPath);
        if (sourceFile) {
          const edgeKey = `${sourceFile.id}:${currentFile.id}:imports`;
          
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            edges.push({
              codebase_slug: codebaseSlug,
              from_file_id: sourceFile.id,    // the file being imported (source)
              to_file_id: currentFile.id,     // the file that imports (destination)
              kind: "imports",
            });
          }
        }
      }
    }
  }
  
  // Process re-exports
  // Edge direction: from_file_id (source file) -> to_file_id (re-exporting file)
  for (const exp of exports) {
    if (!exp.isReExport || !exp.source) continue;
    
    if (isExternalImport(exp.source)) {
      // Re-export from external package
      const packageName = getPackageName(exp.source);
      const edgeKey = `null:${currentFile.id}:re_exports:${packageName}`;
      
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          codebase_slug: codebaseSlug,
          from_file_id: null,           // external package
          to_file_id: currentFile.id,   // the file that re-exports
          kind: "re_exports",
          external_package: packageName,
        });
      }
    } else {
      // Internal re-export
      const resolvedPath = resolveImportPath(exp.source, fromDir, rootPath, fileMap, pathAliases);
      if (resolvedPath) {
        const sourceFile = fileMap.byAbsolutePath.get(resolvedPath);
        if (sourceFile) {
          const edgeKey = `${sourceFile.id}:${currentFile.id}:re_exports`;
          
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            edges.push({
              codebase_slug: codebaseSlug,
              from_file_id: sourceFile.id,    // source file
              to_file_id: currentFile.id,     // re-exporting file
              kind: "re_exports",
            });
          }
        }
      }
    }
  }
  
  return edges;
}

// Resolve an import path to an absolute file path
function resolveImportPath(
  importPath: string,
  fromDir: string,
  rootPath: string,
  fileMap: FileMap,
  pathAliases: PathAliasConfig
): string | null {
  let resolvedPath: string;
  
  // Check if this is a path alias
  if (isPathAlias(importPath)) {
    // Find matching alias and replace it
    for (const [alias, target] of Object.entries(pathAliases)) {
      if (importPath.startsWith(alias)) {
        const relativePart = importPath.slice(alias.length);
        resolvedPath = resolve(rootPath, target, relativePart);
        break;
      }
    }
    // If no alias matched, try treating it as relative to root
    if (!resolvedPath!) {
      // Strip the alias prefix and resolve from root
      const withoutAlias = importPath.replace(/^[@~#]\//, "");
      resolvedPath = resolve(rootPath, withoutAlias);
    }
  } else {
    // Regular relative import
    resolvedPath = resolve(fromDir, importPath);
  }
  
  // Try exact match first
  if (fileMap.byAbsolutePath.has(resolvedPath)) {
    return resolvedPath;
  }
  
  // Try with extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  for (const ext of extensions) {
    const withExt = resolvedPath + ext;
    if (fileMap.byAbsolutePath.has(withExt)) {
      return withExt;
    }
  }
  
  // Try as directory with index file
  for (const ext of extensions) {
    const indexPath = join(resolvedPath, `index${ext}`);
    if (fileMap.byAbsolutePath.has(indexPath)) {
      return indexPath;
    }
  }
  
  // Path could not be resolved
  return null;
}
