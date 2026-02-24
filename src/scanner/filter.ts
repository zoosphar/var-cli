import { basename } from "path";

// Default directories to exclude
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

// Default files to exclude
const EXCLUDED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  ".DS_Store",
  "Thumbs.db",
]);

// Supported file extensions for TS/JS
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

export interface FilterOptions {
  excludeDirs?: string[];
  excludeFiles?: string[];
  includeExtensions?: string[];
}

export function createFilter(options: FilterOptions = {}) {
  const excludedDirs = new Set([
    ...EXCLUDED_DIRECTORIES,
    ...(options.excludeDirs || []),
  ]);

  const excludedFiles = new Set([
    ...EXCLUDED_FILES,
    ...(options.excludeFiles || []),
  ]);

  const supportedExtensions =
    options.includeExtensions && options.includeExtensions.length > 0
      ? new Set(options.includeExtensions)
      : SUPPORTED_EXTENSIONS;

  return {
    shouldExcludeDirectory(dirPath: string): boolean {
      const dirName = basename(dirPath);
      return excludedDirs.has(dirName) || dirName.startsWith(".");
    },

    shouldExcludeFile(filePath: string): boolean {
      const fileName = basename(filePath);
      return excludedFiles.has(fileName);
    },

    isSupportedFile(filePath: string): boolean {
      const ext = getExtension(filePath);
      return supportedExtensions.has(ext);
    },

    getLanguage(filePath: string): string {
      const ext = getExtension(filePath);
      switch (ext) {
        case ".ts":
        case ".mts":
        case ".cts":
          return "typescript";
        case ".tsx":
          return "tsx";
        case ".js":
        case ".mjs":
        case ".cjs":
          return "javascript";
        case ".jsx":
          return "jsx";
        default:
          return "unknown";
      }
    },
  };
}

function getExtension(filePath: string): string {
  const fileName = basename(filePath);
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) return "";
  return fileName.slice(lastDot).toLowerCase();
}

export type Filter = ReturnType<typeof createFilter>;

