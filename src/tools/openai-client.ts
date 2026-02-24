import OpenAI from "openai";
import { getSymbolsFromQuery, GET_SYMBOLS_FROM_QUERY_TOOL, getCodebaseRootPath } from "./symbol-search";
import type { SymbolHint } from "./symbol-search";

let openaiClient: OpenAI | null = null;

export function initOpenAI(apiKey?: string): OpenAI {
  const key = apiKey || process.env.OPENAI_API_KEY;
  
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required. " +
      "Get one at https://platform.openai.com/api-keys"
    );
  }
  
  openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
}

export function getOpenAI(): OpenAI {
  if (!openaiClient) {
    return initOpenAI();
  }
  return openaiClient;
}

export interface QueryOptions {
  query: string;
  codebaseSlug: string;
  model?: string;
  temperature?: number;
}

export interface QueryResult {
  answer: string;
  symbolsUsed: Array<{
    symbol_name: string;
    symbol_kind: string;
    file_path: string;
  }>;
}

// Execute tool call
async function executeToolCall(
  toolCall: Extract<OpenAI.Chat.Completions.ChatCompletionMessageToolCall, { type: "function" }>,
  codebaseSlug: string
): Promise<string> {
  console.log(`\n🔧 Tool Call: ${toolCall.function.name}`);
  console.log(`   Call ID: ${toolCall.id}`);
  
  if (toolCall.function.name === "get_symbols_from_query") {
    const args = JSON.parse(toolCall.function.arguments);
    
    console.log(`   Arguments:`);
    console.log(`     - codebase_slug: ${codebaseSlug} (from CLI)`);
    console.log(`     - max_results: ${args.max_results || 20}`);
    console.log(`     - path_hint_keywords: ${JSON.stringify(args.path_hint_keywords, null, 2)}`);
    
    // Get root path from codebase (use the one from CLI, not from LLM)
    console.log(`   🔍 Looking up root path for codebase: ${codebaseSlug}`);
    const rootPath = await getCodebaseRootPath(codebaseSlug);
    if (!rootPath) {
      const error = JSON.stringify({
        error: `Could not determine root path for codebase '${codebaseSlug}'. Please ensure codebase was scanned with 'codemap scan <path>'.`,
      });
      console.log(`   ❌ Error: ${error}`);
      return error;
    }
    console.log(`   ✅ Root path: ${rootPath}`);
    
    console.log(`   🔍 Executing symbol search...`);
    
    // Execute the tool (use codebaseSlug from CLI, not from LLM args)
    const results = await getSymbolsFromQuery({
      pathHintKeywords: args.path_hint_keywords,
      codebaseSlug: codebaseSlug,
      rootPath,
      maxResults: args.max_results || 20,
    });
    
    console.log(`   ✅ Found ${results.length} symbols`);
    
    // Calculate total lines
    let totalLines = 0;
    for (const result of results) {
      const lines = result.end_line - result.start_line + 1;
      totalLines += lines;
    }
    
    // Show all symbols with details
    console.log(`   📋 Symbols being returned:`);
    for (const result of results) {
      const lines = result.end_line - result.start_line + 1;
      const codeLines = result.code_snippet.split('\n').length;
      console.log(`      ${result.symbol_name} (${result.symbol_kind})`);
      console.log(`         File: ${result.file_path}`);
      console.log(`         Lines: ${result.start_line}-${result.end_line} (${lines} lines)`);
      console.log(`         Code snippet: ${codeLines} lines`);
      console.log(`         Score: ${result.score.toFixed(2)}`);
    }
    
    console.log(`   📊 Summary:`);
    console.log(`      - Total symbols: ${results.length}`);
    console.log(`      - Total symbol lines: ${totalLines}`);
    const totalCodeLines = results.reduce((sum, r) => sum + r.code_snippet.split('\n').length, 0);
    console.log(`      - Total code snippet lines: ${totalCodeLines}`);
    
    // Format results for LLM
    const formatted = JSON.stringify({
      symbols: results.map((r) => ({
        symbol_name: r.symbol_name,
        symbol_kind: r.symbol_kind,
        file_path: r.file_path,
        start_line: r.start_line,
        end_line: r.end_line,
        code_snippet: r.code_snippet,
        score: r.score,
      })),
      total_found: results.length,
    });
    
    console.log(`   📤 Returning ${results.length} symbols (${totalCodeLines} lines of code) to LLM`);
    
    return formatted;
  }
  
  const error = JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` });
  console.log(`   ❌ Error: ${error}`);
  return error;
}

// Main query function
export async function queryCodebase(options: QueryOptions): Promise<QueryResult> {
  const client = getOpenAI();
  const model = options.model || "gpt-4.1";
  
  console.log(`\n🤖 Initializing query with model: ${model}`);
  console.log(`📋 Registered tool: ${GET_SYMBOLS_FROM_QUERY_TOOL.function.name}`);
  console.log(`   Description: ${GET_SYMBOLS_FROM_QUERY_TOOL.function.description}`);
  
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a helpful code assistant that can analyze codebases. 
When a user asks a question about code, you should:
1. Analyze the query to identify relevant symbols (functions, classes, interfaces, etc.)
2. Use the get_symbols_from_query tool to find matching symbols
3. Analyze the returned code snippets
4. Answer the user's question based on the code you found

Be specific and reference the actual code when answering.`,
    },
    {
      role: "user",
      content: options.query,
    },
  ];
  
  const symbolsUsed: Array<{
    symbol_name: string;
    symbol_kind: string;
    file_path: string;
  }> = [];
  
  let maxIterations = 5; // Prevent infinite loops
  let iteration = 0;
  
  while (iteration < maxIterations) {
    console.log(`\n💬 Sending request to LLM (iteration ${iteration + 1}/${maxIterations})...`);
    
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: [
        {
          type: "function",
          function: GET_SYMBOLS_FROM_QUERY_TOOL.function,
        },
      ],
      tool_choice: "auto",
      temperature: options.temperature || 0.3,
    });
    
    const message = response.choices[0].message;
    
    // Add assistant's message to conversation
    messages.push(message);
    
    // Check if there are tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      console.log(`\n🔧 LLM requested ${message.tool_calls.length} tool call(s)`);
      
      // Filter to only function tool calls
      const functionToolCalls = message.tool_calls.filter(
        (tc): tc is Extract<typeof tc, { type: "function" }> => tc.type === "function"
      );
      
      if (functionToolCalls.length === 0) {
        console.log(`   ⚠️  No function tool calls found, skipping...`);
        iteration++;
        continue;
      }
      
      console.log(`   Executing ${functionToolCalls.length} function tool call(s)...`);
      
      // Execute all tool calls in parallel (pass codebaseSlug from CLI options)
      const toolResults = await Promise.all(
        functionToolCalls.map(async (toolCall) => {
          const result = await executeToolCall(toolCall, options.codebaseSlug);
          
          // Track symbols used
          try {
            const parsed = JSON.parse(result);
            if (parsed.symbols) {
              for (const sym of parsed.symbols) {
                symbolsUsed.push({
                  symbol_name: sym.symbol_name,
                  symbol_kind: sym.symbol_kind,
                  file_path: sym.file_path,
                });
              }
            }
          } catch {
            // Ignore parsing errors
          }
          
          return {
            role: "tool" as const,
            tool_call_id: toolCall.id,
            content: result,
          };
        })
      );
      
      console.log(`   ✅ All tool calls completed, sending results back to LLM...`);
      
      // Add tool results to conversation
      messages.push(...toolResults);
      
      iteration++;
      continue;
    }
    
    // No tool calls, we have the final answer
    if (message.content) {
      console.log(`\n✅ LLM provided final answer (no more tool calls needed)`);
      return {
        answer: message.content,
        symbolsUsed: Array.from(
          new Map(symbolsUsed.map((s) => [`${s.file_path}:${s.symbol_name}`, s])).values()
        ),
      };
    }
    
    iteration++;
  }
  
  console.log(`\n⚠️  Max iterations (${maxIterations}) reached. The model may be stuck in a loop.`);
  throw new Error("Max iterations reached. The model may be stuck in a loop.");
}

