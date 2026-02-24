import Parser from "tree-sitter";
// @ts-ignore - tree-sitter grammars have typing issues
import TypeScript from "tree-sitter-typescript";
// @ts-ignore - tree-sitter grammars have typing issues
import JavaScript from "tree-sitter-javascript";

// Initialize parsers for each language
const tsParser = new Parser();
// @ts-ignore - type mismatch between grammar versions
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
// @ts-ignore - type mismatch between grammar versions
tsxParser.setLanguage(TypeScript.tsx);

const jsParser = new Parser();
// @ts-ignore - type mismatch between grammar versions
jsParser.setLanguage(JavaScript);

export type SupportedLanguage = "typescript" | "tsx" | "javascript" | "jsx";

export function getParser(language: string): Parser | null {
  switch (language) {
    case "typescript":
      return tsParser;
    case "tsx":
      return tsxParser;
    case "javascript":
    case "jsx":
      return jsParser;
    default:
      return null;
  }
}

export function parseCode(code: string, language: string): Parser.Tree | null {
  const parser = getParser(language);
  if (!parser) {
    return null;
  }
  return parser.parse(code);
}

export type { Parser };
export type SyntaxNode = Parser.SyntaxNode;
export type Tree = Parser.Tree;
