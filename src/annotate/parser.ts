import type { FileAnnotationResponse, FolderAnnotationResponse, CATEGORIES } from "./prompts";

// Validate and normalize a category
export function normalizeCategory(category: string): string {
  const validCategories = [
    "api", "ui", "component", "utility", "config", "data",
    "hook", "service", "type", "test", "style", "store",
    "middleware", "lib"
  ];
  
  const normalized = category.toLowerCase().trim();
  
  if (validCategories.includes(normalized)) {
    return normalized;
  }
  
  // Try to map common alternatives
  const categoryMap: Record<string, string> = {
    "components": "component",
    "utils": "utility",
    "utilities": "utility",
    "helper": "utility",
    "helpers": "utility",
    "types": "type",
    "interface": "type",
    "interfaces": "type",
    "services": "service",
    "apis": "api",
    "endpoint": "api",
    "endpoints": "api",
    "route": "api",
    "routes": "api",
    "page": "ui",
    "pages": "ui",
    "view": "ui",
    "views": "ui",
    "hooks": "hook",
    "tests": "test",
    "spec": "test",
    "styles": "style",
    "css": "style",
    "scss": "style",
    "state": "store",
    "redux": "store",
    "zustand": "store",
    "library": "lib",
    "shared": "lib",
    "common": "lib",
    "configuration": "config",
    "settings": "config",
    "model": "data",
    "models": "data",
    "schema": "data",
    "schemas": "data",
  };
  
  if (categoryMap[normalized]) {
    return categoryMap[normalized];
  }
  
  // Default to utility if unknown
  return "utility";
}

// Validate and normalize confidence score
export function normalizeConfidence(confidence: unknown): number {
  if (typeof confidence === "number") {
    return Math.max(0, Math.min(1, confidence));
  }
  
  if (typeof confidence === "string") {
    const parsed = parseFloat(confidence);
    if (!isNaN(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  
  // Default confidence
  return 0.5;
}

// Parse and validate file annotation response
export function parseFileAnnotationResponse(
  response: unknown
): FileAnnotationResponse | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  
  const obj = response as Record<string, unknown>;
  
  // Validate file annotation
  if (!obj.file || typeof obj.file !== "object") {
    return null;
  }
  
  const fileObj = obj.file as Record<string, unknown>;
  
  const file = {
    responsibility: String(fileObj.responsibility || "Unknown purpose"),
    category: normalizeCategory(String(fileObj.category || "utility")),
    confidence: normalizeConfidence(fileObj.confidence),
  };
  
  // Validate symbols
  const symbols: FileAnnotationResponse["symbols"] = {};
  
  if (obj.symbols && typeof obj.symbols === "object") {
    const symbolsObj = obj.symbols as Record<string, unknown>;
    
    for (const [name, value] of Object.entries(symbolsObj)) {
      if (value && typeof value === "object") {
        const symbolObj = value as Record<string, unknown>;
        symbols[name] = {
          responsibility: String(symbolObj.responsibility || "Unknown purpose"),
          category: normalizeCategory(String(symbolObj.category || "utility")),
          confidence: normalizeConfidence(symbolObj.confidence),
        };
      }
    }
  }
  
  return { file, symbols };
}

// Parse and validate folder annotation response
export function parseFolderAnnotationResponse(
  response: unknown
): FolderAnnotationResponse | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  
  const obj = response as Record<string, unknown>;
  
  return {
    responsibility: String(obj.responsibility || "Unknown purpose"),
    category: normalizeCategory(String(obj.category || "utility")),
    confidence: normalizeConfidence(obj.confidence),
  };
}

// Extract JSON from a potentially messy LLM response
export function extractJSON(text: string): unknown {
  // Try to parse as-is first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to extraction
  }
  
  // Remove markdown code blocks
  let cleaned = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Continue
    }
  }
  
  // Try to find JSON object
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // Continue
    }
  }
  
  // Try to fix common JSON issues
  cleaned = text
    .replace(/,\s*}/g, "}") // Remove trailing commas
    .replace(/,\s*]/g, "]")
    .replace(/'/g, '"') // Replace single quotes
    .replace(/(\w+):/g, '"$1":') // Quote unquoted keys
    .replace(/:\s*'([^']*)'/g, ': "$1"'); // Quote single-quoted values
  
  const fixedMatch = cleaned.match(/\{[\s\S]*\}/);
  if (fixedMatch) {
    try {
      return JSON.parse(fixedMatch[0]);
    } catch {
      // Give up
    }
  }
  
  return null;
}

