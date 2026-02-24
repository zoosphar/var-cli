import type { AnnotationContext, FolderAnnotationContext } from "./context";
import { formatEdgesForPrompt } from "./context";

// Categories that the LLM can assign
export const CATEGORIES = [
  "api",        // API routes, endpoints, controllers
  "ui",         // UI components, views, pages
  "component",  // Reusable components
  "utility",    // Helper functions, utilities
  "config",     // Configuration files
  "data",       // Data models, schemas, types
  "hook",       // React hooks, custom hooks
  "service",    // Business logic, services
  "type",       // Type definitions, interfaces
  "test",       // Test files
  "style",      // Styling, CSS, themes
  "store",      // State management
  "middleware", // Middleware, interceptors
  "lib",        // Library code, shared modules
] as const;

export type Category = (typeof CATEGORIES)[number];

// Response format for file + symbols annotation
export interface FileAnnotationResponse {
  file: {
    responsibility: string;
    category: string;
    confidence: number;
  };
  symbols: Record<
    string,
    {
      responsibility: string;
      category: string;
      confidence: number;
    }
  >;
}

// Response format for folder annotation
export interface FolderAnnotationResponse {
  responsibility: string;
  category: string;
  confidence: number;
}

// Build prompt for annotating a file and its symbols
export function buildFileAnnotationPrompt(context: AnnotationContext): string {
  const symbolList = context.symbols
    .map((s) => `- ${s.name} (${s.kind}, lines ${s.startLine}-${s.endLine})`)
    .join("\n");

  const edgesContext = formatEdgesForPrompt(context);

  return `You are a senior software engineer analyzing code to understand its purpose and structure.

Analyze the following ${context.file.language} file and provide annotations for the file itself and each symbol (function, class, etc.) within it.

FILE: ${context.file.path}
LANGUAGE: ${context.file.language}

${edgesContext ? `CONTEXT:\n${edgesContext}\n` : ""}
SYMBOLS IN THIS FILE:
${symbolList || "No symbols extracted"}

FILE CONTENT (with symbol markers):
\`\`\`${context.file.language}
${context.file.contentWithMarkers}
\`\`\`

For the file and EACH marked symbol (>>> SYMBOL: name <<<), provide:
1. responsibility: A concise 1-2 sentence description of what it does
2. category: One of [${CATEGORIES.join(", ")}]
3. confidence: A number from 0 to 1 indicating how confident you are (1 = very confident)

IMPORTANT:
- Be specific about what each symbol does, not just its type
- Consider the context (imports, what uses it) when determining purpose
- For React components, describe what UI they render
- For hooks, describe what state/effect they manage
- For utilities, describe what transformation/operation they perform

Respond with ONLY valid JSON in this exact format:
{
  "file": {
    "responsibility": "Brief description of the file's purpose",
    "category": "category_name",
    "confidence": 0.9
  },
  "symbols": {
    "symbolName1": {
      "responsibility": "What this symbol does",
      "category": "category_name",
      "confidence": 0.85
    },
    "symbolName2": {
      "responsibility": "What this symbol does",
      "category": "category_name",
      "confidence": 0.8
    }
  }
}`;
}

// Build prompt for annotating a folder based on its contents
export function buildFolderAnnotationPrompt(
  context: FolderAnnotationContext
): string {
  const filesList = context.childFiles
    .map((f) => {
      const cat = f.category ? ` [${f.category}]` : "";
      const resp = f.responsibility ? `: ${f.responsibility}` : "";
      return `- ${f.path}${cat}${resp}`;
    })
    .join("\n");

  const foldersList = context.childFolders
    .map((f) => {
      const cat = f.category ? ` [${f.category}]` : "";
      const resp = f.responsibility ? `: ${f.responsibility}` : "";
      return `- ${f.path}${cat}${resp}`;
    })
    .join("\n");

  return `You are a senior software engineer analyzing a codebase structure.

Based on the contents of a folder, determine its overall purpose and category.

FOLDER: ${context.path}

${
  context.childFiles.length > 0
    ? `FILES IN THIS FOLDER:\n${filesList}\n`
    : "No files in this folder.\n"
}
${
  context.childFolders.length > 0
    ? `SUBFOLDERS:\n${foldersList}\n`
    : ""
}

Based on the files and subfolders, determine:
1. responsibility: A concise description of what this folder/module is for (1-2 sentences)
2. category: The primary category from [${CATEGORIES.join(", ")}]
3. confidence: How confident you are (0-1)

Consider:
- The naming convention of the folder
- The types of files it contains
- The categories of its children (if available)
- Common patterns (e.g., "components" folder = component, "api" folder = api)

Respond with ONLY valid JSON:
{
  "responsibility": "What this folder is for",
  "category": "category_name",
  "confidence": 0.9
}`;
}

// Truncate content if too long (to stay within token limits)
export function truncateContent(content: string, maxLines: number = 500): string {
  const lines = content.split("\n");
  
  if (lines.length <= maxLines) {
    return content;
  }
  
  // Keep first portion and last portion
  const keepStart = Math.floor(maxLines * 0.7);
  const keepEnd = Math.floor(maxLines * 0.3);
  
  const startLines = lines.slice(0, keepStart);
  const endLines = lines.slice(-keepEnd);
  
  return [
    ...startLines,
    "",
    `// ... ${lines.length - keepStart - keepEnd} lines truncated ...`,
    "",
    ...endLines,
  ].join("\n");
}

