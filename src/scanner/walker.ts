import { readdir, stat } from "fs/promises";
import { join, relative } from "path";
import { createFilter, type Filter, type FilterOptions } from "./filter";

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  language: string;
}

export interface WalkedFolder {
  absolutePath: string;
  relativePath: string;
  parentRelativePath: string | null;
}

export interface WalkResult {
  files: WalkedFile[];
  folders: WalkedFolder[];
}

export interface WalkerOptions extends FilterOptions {
  onFile?: (file: WalkedFile) => void;
  onFolder?: (folder: WalkedFolder) => void;
}

export async function walkDirectory(
  rootPath: string,
  options: WalkerOptions = {}
): Promise<WalkResult> {
  const filter = createFilter(options);
  const files: WalkedFile[] = [];
  const folders: WalkedFolder[] = [];

  // Add root folder
  folders.push({
    absolutePath: rootPath,
    relativePath: ".",
    parentRelativePath: null,
  });

  await walkRecursive(rootPath, rootPath, filter, files, folders, options);

  return { files, folders };
}

async function walkRecursive(
  currentPath: string,
  rootPath: string,
  filter: Filter,
  files: WalkedFile[],
  folders: WalkedFolder[],
  options: WalkerOptions
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    // Skip directories we can't read
    console.warn(`Warning: Cannot read directory ${currentPath}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentPath, entry.name);
    const relativePath = relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      // Check if directory should be excluded
      if (filter.shouldExcludeDirectory(fullPath)) {
        continue;
      }

      // Get parent relative path
      const parentRelativePath = relative(rootPath, currentPath);

      const folder: WalkedFolder = {
        absolutePath: fullPath,
        relativePath,
        parentRelativePath: parentRelativePath === "" ? "." : parentRelativePath,
      };

      folders.push(folder);
      options.onFolder?.(folder);

      // Recursively walk subdirectory
      await walkRecursive(fullPath, rootPath, filter, files, folders, options);
    } else if (entry.isFile()) {
      // Check if file should be excluded
      if (filter.shouldExcludeFile(fullPath)) {
        continue;
      }

      // Check if file is supported
      if (!filter.isSupportedFile(fullPath)) {
        continue;
      }

      const file: WalkedFile = {
        absolutePath: fullPath,
        relativePath,
        language: filter.getLanguage(fullPath),
      };

      files.push(file);
      options.onFile?.(file);
    }
  }
}

export { createFilter };

