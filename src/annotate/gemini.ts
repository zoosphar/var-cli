import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

const MODEL_NAME = "gemini-2.5-flash";
const FALLBACK_MODEL = "gemini-1.5-pro";

let genAI: GoogleGenerativeAI | null = null;
let model: GenerativeModel | null = null;

interface GeminiConfig {
  apiKey?: string;
  model?: string;
}

export function initGemini(config: GeminiConfig = {}): GenerativeModel {
  const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is required. " +
      "Get one at https://makersuite.google.com/app/apikey"
    );
  }
  
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ 
    model: config.model || MODEL_NAME,
    generationConfig: {
      temperature: 0.2, // Low temperature for more consistent/factual output
      topP: 0.8,
      maxOutputTokens: 8192,
    },
  });
  
  return model;
}

export function getModel(): GenerativeModel {
  if (!model) {
    return initGemini();
  }
  return model;
}

export interface GenerateOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  delayBetweenCalls?: number;
}

const DEFAULT_OPTIONS: GenerateOptions = {
  maxRetries: 3,
  retryDelayMs: 1000,
  delayBetweenCalls: 200,
};

// Rate limiting state
let lastCallTime = 0;

async function waitForRateLimit(delayMs: number): Promise<void> {
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  
  if (timeSinceLastCall < delayMs) {
    await sleep(delayMs - timeSinceLastCall);
  }
  
  lastCallTime = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateContent(
  prompt: string,
  options: GenerateOptions = {}
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const geminiModel = getModel();
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < opts.maxRetries!; attempt++) {
    try {
      // Wait for rate limit
      await waitForRateLimit(opts.delayBetweenCalls!);
      
      const result = await geminiModel.generateContent(prompt);
      const response = result.response;
      const text = response.text();
      
      return text;
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a rate limit error (429)
      if (error.status === 429 || error.message?.includes("429")) {
        const delay = opts.retryDelayMs! * Math.pow(2, attempt);
        console.warn(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`);
        await sleep(delay);
        continue;
      }
      
      // Check for quota exceeded
      if (error.message?.includes("quota") || error.message?.includes("RESOURCE_EXHAUSTED")) {
        throw new Error("API quota exceeded. Please try again later or check your billing.");
      }
      
      // For other errors, retry with backoff
      if (attempt < opts.maxRetries! - 1) {
        const delay = opts.retryDelayMs! * Math.pow(2, attempt);
        console.warn(`Error: ${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`);
        await sleep(delay);
        continue;
      }
    }
  }
  
  throw lastError || new Error("Failed to generate content after retries");
}

export async function generateJSON<T>(
  prompt: string,
  options: GenerateOptions = {}
): Promise<T> {
  const response = await generateContent(prompt, options);
  
  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = response;
  
  // Remove markdown code blocks if present
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }
  
  // Try to parse JSON
  try {
    return JSON.parse(jsonStr) as T;
  } catch (error) {
    // Try to find JSON object in the response
    const objectMatch = response.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]) as T;
      } catch {
        // Fall through to error
      }
    }
    
    throw new Error(`Failed to parse JSON response: ${response.slice(0, 200)}...`);
  }
}

export function getModelName(): string {
  return MODEL_NAME;
}

