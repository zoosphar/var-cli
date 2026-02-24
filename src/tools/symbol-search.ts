import { getDb } from "../db/client";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Symbol, File } from "../db/schema";

export interface SymbolSearchResult {
  symbol_name: string;
  symbol_kind: "enum" | "class" | "variable" | "interface" | "type" | "const" | "method" | "function" | "export";
  file_path: string;
  start_line: number;
  end_line: number;
  code_snippet: string;
  score: number;
  name_score: number;
  inbound_score: number;
  outbound_score: number;
  proximity_score: number;
}

// Scoring weights
const ALPHA = 3.0;  // semantic relevance (name_score)
const BETA = 2.0;   // structural importance (fanin_score)
const GAMMA = 2.5;  // closeness (proximity_score)
const DELTA = 1.0;  // avoid glue domination (fanout_penalty)

// OpenAI tool definition
export const GET_SYMBOLS_FROM_QUERY_TOOL = {
  type: "function" as const,
  function: {
    name: "get_symbols_from_query",
    description: "Extract and score symbols from the codebase based on path hints provided by the LLM. The LLM should analyze the user query and provide an array of symbol name hints and their expected kinds. The codebase is already determined by the user's command, so you don't need to specify it.",
    parameters: {
      type: "object",
      properties: {
        path_hint_keywords: {
          type: "array",
          description: "Array of symbol hints extracted from the user query",
          items: {
            type: "object",
            properties: {
              symbol_name_hint: {
                type: "string",
                description: "A keyword or partial name hint for the symbol (e.g., 'login', 'user', 'auth', 'Button')",
              },
              symbol_kind: {
                type: "string",
                enum: ["enum", "class", "variable", "interface", "type", "const", "method", "function", "export"],
                description: "The expected kind of symbol",
              },
            },
            required: ["symbol_name_hint", "symbol_kind"],
          },
        },
        codebase_slug: {
          type: "string",
          description: "The codebase slug to search within",
        },
        max_results: {
          type: "number",
          description: "Maximum number of symbols to return (default: 5)",
          default: 5,
        },
      },
      required: ["path_hint_keywords"],
    },
  },
};

export interface SymbolHint {
  symbol_name_hint: string;
  symbol_kind: "enum" | "class" | "variable" | "interface" | "type" | "const" | "method" | "function" | "export";
}

export interface SymbolSearchOptions {
  pathHintKeywords: SymbolHint[];
  codebaseSlug: string;
  rootPath: string;
  maxResults?: number;
}


// Calculate name score based on keyword matching
function calculateNameScore(symbolName: string, keywords: string[]): number {
  const nameLower = symbolName.toLowerCase();
  let score = 0;
  
  for (const keyword of keywords) {
    // Exact match
    if (nameLower === keyword) {
      score += 10;
    }
    // Starts with keyword
    else if (nameLower.startsWith(keyword)) {
      score += 7;
    }
    // Ends with keyword
    else if (nameLower.endsWith(keyword)) {
      score += 6;
    }
    // Contains keyword
    else if (nameLower.includes(keyword)) {
      score += 4;
    }
    // Partial match (camelCase/PascalCase)
    else if (nameLower.includes(keyword.charAt(0).toUpperCase() + keyword.slice(1))) {
      score += 3;
    }
  }
  
  // Normalize to 0-1 range
  return Math.min(1, score / 10);
}

// Calculate inbound score (fan-in)
async function calculateInboundScore(
  symbolId: number,
  codebaseSlug: string,
  seedSymbolIds: Set<number>
): Promise<number> {
  const sql = getDb();
  
  // Get absolute inbound count
  const [absResult] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count
    FROM symbol_edges
    WHERE codebase_slug = ${codebaseSlug} AND to_symbol_id = ${symbolId}
  `;
  const absoluteInbound = parseInt(absResult.count, 10);
  
  // Get relative inbound (edges from seed symbols)
  const seedIdsArray = Array.from(seedSymbolIds);
  const [relResult] = seedIdsArray.length > 0
    ? await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM symbol_edges
        WHERE codebase_slug = ${codebaseSlug} 
          AND to_symbol_id = ${symbolId}
          AND from_symbol_id = ANY(${seedIdsArray})
      `
    : [{ count: "0" }];
  const relativeInbound = parseInt(relResult.count, 10);
  
  // Calculate inbound score
  const inboundScore = 
    0.2 * Math.log(1 + absoluteInbound) +
    0.8 * Math.log(1 + relativeInbound);
  
  return inboundScore;
}

// Calculate outbound score (fan-out)
async function calculateOutboundScore(
  symbolId: number,
  codebaseSlug: string
): Promise<number> {
  const sql = getDb();
  
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count
    FROM symbol_edges
    WHERE codebase_slug = ${codebaseSlug} AND from_symbol_id = ${symbolId}
  `;
  
  return parseInt(result.count, 10);
}

// Calculate proximity score (distance from seed symbols)
async function calculateProximityScore(
  symbolId: number,
  seedSymbolIds: Set<number>,
  codebaseSlug: string
): Promise<number> {
  if (seedSymbolIds.size === 0) return 0;
  
  const sql = getDb();
  
  // Find minimum distance from any seed symbol using BFS-like approach
  // We'll use symbol_edges to traverse
  const visited = new Set<number>();
  const queue: Array<{ id: number; distance: number }> = [];
  
  // Initialize queue with seed symbols
  for (const seedId of seedSymbolIds) {
    queue.push({ id: seedId, distance: 0 });
    visited.add(seedId);
  }
  
  // BFS to find shortest path
  while (queue.length > 0) {
    const { id, distance } = queue.shift()!;
    
    if (id === symbolId) {
      return 1 / (1 + distance);
    }
    
    // Get neighbors (symbols connected via edges)
    const neighbors = await sql<{ to_symbol_id: number | null }[]>`
      SELECT DISTINCT to_symbol_id
      FROM symbol_edges
      WHERE codebase_slug = ${codebaseSlug} 
        AND from_symbol_id = ${id}
        AND to_symbol_id IS NOT NULL
      LIMIT 20
    `;
    
    for (const neighbor of neighbors) {
      if (neighbor.to_symbol_id && !visited.has(neighbor.to_symbol_id)) {
        visited.add(neighbor.to_symbol_id);
        queue.push({ id: neighbor.to_symbol_id, distance: distance + 1 });
      }
    }
    
    // Limit search depth
    if (distance > 5) break;
  }
  
  // If not found, return low score
  return 0.1;
}

// Calculate name score for a symbol based on hints
function calculateNameScoreFromHints(
  symbolName: string,
  symbolKind: string,
  hints: SymbolHint[]
): number {
  let maxScore = 0;
  
  for (const hint of hints) {
    // Check if kind matches
    const kindMatch = symbolKind === hint.symbol_kind ? 1.0 : 0.0;
    
    // Calculate name match score
    const nameScore = calculateNameScore(symbolName, [hint.symbol_name_hint]);
    
    // Combined score (kind match is important)
    const combinedScore = (kindMatch * 0.4) + (nameScore * 0.6);
    maxScore = Math.max(maxScore, combinedScore);
  }
  
  return maxScore;
}

// Main function to search and score symbols
export async function getSymbolsFromQuery(
  options: SymbolSearchOptions
): Promise<SymbolSearchResult[]> {
  const { pathHintKeywords, codebaseSlug, rootPath, maxResults = 20 } = options;
  const sql = getDb();
  
  if (pathHintKeywords.length === 0) {
    return [];
  }
  
  // Get all symbols with file info, optionally filtered by kind
  const kindFilters = pathHintKeywords.map(h => h.symbol_kind);
  const uniqueKinds = [...new Set(kindFilters)];
  
  let allSymbols: (Symbol & { file_path: string })[];
  
  if (uniqueKinds.length > 0 && uniqueKinds.length < 9) {
    // Filter by kind if hints specify kinds
    allSymbols = await sql<(Symbol & { file_path: string })[]>`
      SELECT s.*, f.relative_path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.codebase_slug = ${codebaseSlug}
        AND s.kind = ANY(${uniqueKinds})
    `;
  } else {
    // Get all symbols if no kind filter or all kinds specified
    allSymbols = await sql<(Symbol & { file_path: string })[]>`
      SELECT s.*, f.relative_path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.codebase_slug = ${codebaseSlug}
    `;
  }
  
  // Calculate name scores and find seed symbols (high name score)
  const symbolScores = new Map<number, {
    symbol: Symbol & { file_path: string };
    nameScore: number;
  }>();
  
  const seedSymbolIds = new Set<number>();
  
  for (const symbol of allSymbols) {
    const nameScore = calculateNameScoreFromHints(symbol.name, symbol.kind, pathHintKeywords);
    symbolScores.set(symbol.id, { symbol, nameScore });
    
    // Seed symbols are those with high name score (> 0.5)
    if (nameScore > 0.5) {
      seedSymbolIds.add(symbol.id);
    }
  }
  
  // Calculate all scores for each symbol
  const results: Array<SymbolSearchResult & { finalScore: number }> = [];
  
  for (const [symbolId, { symbol, nameScore }] of symbolScores) {
    const inboundScore = await calculateInboundScore(symbolId, codebaseSlug, seedSymbolIds);
    const outboundCount = await calculateOutboundScore(symbolId, codebaseSlug);
    const proximityScore = await calculateProximityScore(symbolId, seedSymbolIds, codebaseSlug);
    
    // Calculate final score
    const finalScore =
      ALPHA * nameScore +
      BETA * Math.log(1 + inboundScore) / 10 + // Normalize inbound
      GAMMA * proximityScore -
      DELTA * Math.log(1 + outboundCount) / 10; // Normalize outbound

    const THRESHOLD = 4;

    if (finalScore < THRESHOLD) {
      continue;
    }

    // Read code snippet
    let codeSnippet = "";
    try {
      const filePath = resolve(rootPath, symbol.file_path);
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const snippetLines = lines.slice(
        Math.max(0, symbol.start_line - 1),
        Math.min(lines.length, symbol.end_line)
      );
      codeSnippet = snippetLines.join("\n");
    } catch (error) {
      codeSnippet = "// Code snippet unavailable";
    }
    
    results.push({
      symbol_name: symbol.name,
      symbol_kind: symbol.kind as SymbolSearchResult["symbol_kind"],
      file_path: symbol.file_path,
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      code_snippet: codeSnippet,
      score: finalScore,
      name_score: nameScore,
      inbound_score: inboundScore,
      outbound_score: outboundCount,
      proximity_score: proximityScore,
      finalScore,
    });
  }
  
  // Sort by final score and return top results
  results.sort((a, b) => b.finalScore - a.finalScore);
  
  return results.slice(0, maxResults).map(({ finalScore, ...rest }) => rest);
}

// Helper to format results for OpenAI function calling
export function formatSymbolSearchResults(results: SymbolSearchResult[]): string {
  if (results.length === 0) {
    return "No symbols found matching the query.";
  }
  
  return results.map((result, idx) => {
    return `[${idx + 1}] ${result.symbol_name} (${result.symbol_kind})
  File: ${result.file_path}
  Lines: ${result.start_line}-${result.end_line}
  Score: ${result.score.toFixed(2)}
  Code:
${result.code_snippet}
---`;
  }).join("\n\n");
}

// Helper to get root path from codebase
export async function getCodebaseRootPath(codebaseSlug: string): Promise<string | null> {
  const sql = getDb();
  const [codebase] = await sql<{ description: string | null }[]>`
    SELECT description FROM codebases WHERE slug = ${codebaseSlug}
  `;
  
  if (!codebase) {
    console.error(`   ❌ Codebase '${codebaseSlug}' not found in database`);
    return null;
  }
  
  if (!codebase.description) {
    console.error(`   ❌ Codebase '${codebaseSlug}' has no description`);
    return null;
  }
  
  // Try to match "Scanned from <path>"
  const match = codebase.description.match(/Scanned from (.+)/);
  if (match) {
    return match[1];
  }
  
  // If no match, log the actual description for debugging
  console.error(`   ❌ Could not extract path from description: "${codebase.description}"`);
  console.error(`   Expected format: "Scanned from /path/to/project"`);
  return null;
}

