import type { SyntaxNode, Tree } from "./treesitter";
import type { SymbolKind } from "../db/schema";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

// Tree-sitter node types for different symbol kinds
const SYMBOL_NODE_TYPES: Record<string, SymbolKind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  function_declaration: "function",
  generator_function_declaration: "function",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
};

export function extractSymbols(tree: Tree): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const visited = new Set<number>();

  traverseNode(tree.rootNode, symbols, visited, false);

  return symbols;
}

function traverseNode(
  node: SyntaxNode,
  symbols: ExtractedSymbol[],
  visited: Set<number>,
  isExported: boolean
): void {
  // Prevent duplicate processing
  if (visited.has(node.id)) {
    return;
  }
  visited.add(node.id);

  // Check if this is an export statement
  if (node.type === "export_statement" || node.type === "export_default_clause") {
    // Process children as exported
    for (const child of node.children) {
      traverseNode(child, symbols, visited, true);
    }
    return;
  }

  // Check for declaration types
  if (SYMBOL_NODE_TYPES[node.type]) {
    const symbol = extractDeclarationSymbol(node, SYMBOL_NODE_TYPES[node.type], isExported);
    if (symbol) {
      symbols.push(symbol);
    }
    // Continue to find nested symbols (e.g., methods in classes)
    for (const child of node.children) {
      traverseNode(child, symbols, visited, false);
    }
    return;
  }

  // Handle variable declarations (const, let, var)
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    const declarationKind = getVariableDeclarationKind(node);
    for (const child of node.children) {
      if (child.type === "variable_declarator") {
        const symbol = extractVariableSymbol(child, declarationKind, isExported);
        if (symbol) {
          symbols.push(symbol);
        }
      }
    }
    return;
  }

  // Handle method definitions in classes
  if (node.type === "method_definition" || node.type === "public_field_definition") {
    const symbol = extractMethodSymbol(node);
    if (symbol) {
      symbols.push(symbol);
    }
    return;
  }

  // Handle arrow functions assigned to variables (already handled via variable_declarator)
  // But check for arrow function parameters
  if (node.type === "arrow_function") {
    // Arrow functions are typically handled as part of variable declarations
    // Skip standalone arrow functions
  }

  // Recurse into children
  for (const child of node.children) {
    traverseNode(child, symbols, visited, isExported);
  }
}

function extractDeclarationSymbol(
  node: SyntaxNode,
  kind: SymbolKind,
  isExported: boolean
): ExtractedSymbol | null {
  // Find the name identifier
  const nameNode = node.childForFieldName("name");
  if (!nameNode) {
    return null;
  }

  return {
    name: nameNode.text,
    kind,
    startLine: node.startPosition.row + 1, // Convert to 1-based
    endLine: node.endPosition.row + 1,
    isExported,
  };
}

function getVariableDeclarationKind(node: SyntaxNode): SymbolKind {
  // Check the first child for the keyword (const, let, var)
  for (const child of node.children) {
    if (child.type === "const") {
      return "const";
    }
    if (child.type === "let" || child.type === "var") {
      return "variable";
    }
  }
  // Default to variable if unknown
  return "variable";
}

function extractVariableSymbol(
  node: SyntaxNode,
  kind: SymbolKind,
  isExported: boolean
): ExtractedSymbol | null {
  // Find the name identifier
  const nameNode = node.childForFieldName("name");
  if (!nameNode) {
    return null;
  }

  // Skip if the name is a pattern (destructuring)
  if (nameNode.type !== "identifier") {
    return null;
  }

  // Check if the value is a function/arrow function
  const valueNode = node.childForFieldName("value");
  let actualKind = kind;
  if (valueNode) {
    if (valueNode.type === "arrow_function" || valueNode.type === "function") {
      actualKind = "function";
    }
  }

  return {
    name: nameNode.text,
    kind: actualKind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported,
  };
}

function extractMethodSymbol(node: SyntaxNode): ExtractedSymbol | null {
  // Find the name identifier
  const nameNode = node.childForFieldName("name");
  if (!nameNode) {
    return null;
  }

  return {
    name: nameNode.text,
    kind: "method",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    isExported: false, // Methods inherit export status from their class
  };
}

// Helper to check if a node is exported
export function isNodeExported(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  
  return parent.type === "export_statement" || parent.type === "export_default_clause";
}

