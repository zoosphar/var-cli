import type { SyntaxNode, Tree } from "./treesitter";

export interface ImportedSymbol {
  name: string;
  alias?: string; // For "import { foo as bar }"
  isDefault: boolean;
  isNamespace: boolean; // For "import * as foo"
}

export interface ExtractedImport {
  source: string; // The import path
  symbols: ImportedSymbol[];
  isTypeOnly: boolean;
  isDynamic: boolean;
  line: number;
}

export interface ExtractedExport {
  source: string | null; // null for local exports, path for re-exports
  symbols: string[];
  isDefault: boolean;
  isReExport: boolean;
  line: number;
}

export function extractImports(tree: Tree): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  
  traverseForImports(tree.rootNode, imports);
  
  return imports;
}

export function extractExports(tree: Tree): ExtractedExport[] {
  const exports: ExtractedExport[] = [];
  
  traverseForExports(tree.rootNode, exports);
  
  return exports;
}

function traverseForImports(node: SyntaxNode, imports: ExtractedImport[]): void {
  // Handle ES6 import statements
  if (node.type === "import_statement") {
    const imp = parseImportStatement(node);
    if (imp) {
      imports.push(imp);
    }
  }
  
  // Handle require() calls
  if (node.type === "call_expression") {
    const funcNode = node.childForFieldName("function");
    if (funcNode && funcNode.text === "require") {
      const argsNode = node.childForFieldName("arguments");
      if (argsNode && argsNode.childCount > 0) {
        const sourceArg = argsNode.children.find(
          (c) => c.type === "string" || c.type === "template_string"
        );
        if (sourceArg) {
          imports.push({
            source: stripQuotes(sourceArg.text),
            symbols: [], // require() doesn't have named imports
            isTypeOnly: false,
            isDynamic: false,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }
  
  // Handle dynamic import() expressions
  if (node.type === "call_expression") {
    const funcNode = node.childForFieldName("function");
    if (funcNode && funcNode.type === "import") {
      const argsNode = node.childForFieldName("arguments");
      if (argsNode && argsNode.childCount > 0) {
        const sourceArg = argsNode.children.find(
          (c) => c.type === "string" || c.type === "template_string"
        );
        if (sourceArg) {
          imports.push({
            source: stripQuotes(sourceArg.text),
            symbols: [],
            isTypeOnly: false,
            isDynamic: true,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }
  
  // Recurse into children
  for (const child of node.children) {
    traverseForImports(child, imports);
  }
}

function parseImportStatement(node: SyntaxNode): ExtractedImport | null {
  // Find the source string
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) {
    // Try to find it as a child with type "string"
    const stringNode = node.children.find((c) => c.type === "string");
    if (!stringNode) return null;
    
    return {
      source: stripQuotes(stringNode.text),
      symbols: [],
      isTypeOnly: isTypeOnlyImport(node),
      isDynamic: false,
      line: node.startPosition.row + 1,
    };
  }
  
  const source = stripQuotes(sourceNode.text);
  const symbols: ImportedSymbol[] = [];
  const isTypeOnly = isTypeOnlyImport(node);
  
  // Parse import clause
  const importClause = node.children.find(
    (c) =>
      c.type === "import_clause" ||
      c.type === "named_imports" ||
      c.type === "namespace_import"
  );
  
  if (importClause) {
    parseImportClause(importClause, symbols);
  }
  
  // Also check direct children for named_imports
  for (const child of node.children) {
    if (child.type === "named_imports") {
      parseNamedImports(child, symbols);
    }
    if (child.type === "namespace_import") {
      parseNamespaceImport(child, symbols);
    }
    if (child.type === "identifier") {
      // Default import: import foo from "..."
      symbols.push({
        name: child.text,
        isDefault: true,
        isNamespace: false,
      });
    }
  }
  
  return {
    source,
    symbols,
    isTypeOnly,
    isDynamic: false,
    line: node.startPosition.row + 1,
  };
}

function parseImportClause(node: SyntaxNode, symbols: ImportedSymbol[]): void {
  for (const child of node.children) {
    if (child.type === "identifier") {
      // Default import
      symbols.push({
        name: child.text,
        isDefault: true,
        isNamespace: false,
      });
    }
    if (child.type === "named_imports") {
      parseNamedImports(child, symbols);
    }
    if (child.type === "namespace_import") {
      parseNamespaceImport(child, symbols);
    }
  }
}

function parseNamedImports(node: SyntaxNode, symbols: ImportedSymbol[]): void {
  for (const child of node.children) {
    if (child.type === "import_specifier") {
      const nameNode = child.childForFieldName("name");
      const aliasNode = child.childForFieldName("alias");
      
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          alias: aliasNode?.text,
          isDefault: false,
          isNamespace: false,
        });
      } else {
        // Fallback: find first identifier
        const identifier = child.children.find((c) => c.type === "identifier");
        if (identifier) {
          symbols.push({
            name: identifier.text,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }
  }
}

function parseNamespaceImport(node: SyntaxNode, symbols: ImportedSymbol[]): void {
  const identifier = node.children.find((c) => c.type === "identifier");
  if (identifier) {
    symbols.push({
      name: identifier.text,
      isDefault: false,
      isNamespace: true,
    });
  }
}

function isTypeOnlyImport(node: SyntaxNode): boolean {
  // Check for "import type" syntax
  for (const child of node.children) {
    if (child.type === "type" || child.text === "type") {
      return true;
    }
  }
  return false;
}

function traverseForExports(node: SyntaxNode, exports: ExtractedExport[]): void {
  if (node.type === "export_statement") {
    const exp = parseExportStatement(node);
    if (exp) {
      exports.push(exp);
    }
  }
  
  // Recurse into children
  for (const child of node.children) {
    traverseForExports(child, exports);
  }
}

function parseExportStatement(node: SyntaxNode): ExtractedExport | null {
  const symbols: string[] = [];
  let source: string | null = null;
  let isDefault = false;
  let isReExport = false;
  
  // Check for re-export: export { foo } from "..."
  const sourceNode = node.children.find((c) => c.type === "string");
  if (sourceNode) {
    source = stripQuotes(sourceNode.text);
    isReExport = true;
  }
  
  // Check for default export
  for (const child of node.children) {
    if (child.type === "default") {
      isDefault = true;
    }
    
    // Named exports
    if (child.type === "export_clause") {
      for (const spec of child.children) {
        if (spec.type === "export_specifier") {
          const nameNode = spec.childForFieldName("name");
          if (nameNode) {
            symbols.push(nameNode.text);
          } else {
            const identifier = spec.children.find((c) => c.type === "identifier");
            if (identifier) {
              symbols.push(identifier.text);
            }
          }
        }
      }
    }
    
    // Export of declaration: export function foo() {}
    if (
      child.type === "function_declaration" ||
      child.type === "class_declaration" ||
      child.type === "interface_declaration" ||
      child.type === "type_alias_declaration" ||
      child.type === "enum_declaration"
    ) {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        symbols.push(nameNode.text);
      }
    }
    
    // Export of variable: export const foo = ...
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      for (const decl of child.children) {
        if (decl.type === "variable_declarator") {
          const nameNode = decl.childForFieldName("name");
          if (nameNode && nameNode.type === "identifier") {
            symbols.push(nameNode.text);
          }
        }
      }
    }
  }
  
  if (symbols.length === 0 && !isDefault) {
    // Check for "export * from '...'" (namespace re-export)
    const hasWildcard = node.children.some((c) => c.type === "*" || c.text === "*");
    if (hasWildcard && source) {
      return {
        source,
        symbols: ["*"],
        isDefault: false,
        isReExport: true,
        line: node.startPosition.row + 1,
      };
    }
  }
  
  if (symbols.length === 0 && !isDefault && !isReExport) {
    return null;
  }
  
  return {
    source,
    symbols,
    isDefault,
    isReExport,
    line: node.startPosition.row + 1,
  };
}

function stripQuotes(str: string): string {
  if ((str.startsWith('"') && str.endsWith('"')) ||
      (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  // Handle backticks for template strings
  if (str.startsWith("`") && str.endsWith("`")) {
    return str.slice(1, -1);
  }
  return str;
}

// Common path alias prefixes used in tsconfig.json
const PATH_ALIAS_PREFIXES = [
  "@/",    // Most common: @/ -> src/ or ./
  "~/",    // Alternative: ~/ -> src/ or ./
  "#/",    // Sometimes used
  "src/",  // Direct src reference
];

// Utility to determine if an import path is external (package) or internal (relative/alias)
export function isExternalImport(importPath: string): boolean {
  // Relative imports start with . or ..
  if (importPath.startsWith(".") || importPath.startsWith("/")) {
    return false;
  }
  
  // Check for common path aliases (like @/app, ~/components)
  for (const prefix of PATH_ALIAS_PREFIXES) {
    if (importPath.startsWith(prefix)) {
      return false; // This is a path alias, not an external package
    }
  }
  
  // Node built-ins
  if (importPath.startsWith("node:")) {
    return true;
  }
  
  // Scoped packages like @types/node, @react/... are external
  // But @/ alone is a path alias (already handled above)
  // Everything else is an external package
  return true;
}

// Check if an import uses a path alias
export function isPathAlias(importPath: string): boolean {
  for (const prefix of PATH_ALIAS_PREFIXES) {
    if (importPath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function getPackageName(importPath: string): string {
  // Handle scoped packages: @scope/package
  if (importPath.startsWith("@")) {
    const parts = importPath.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return importPath;
  }
  // Regular packages: package or package/subpath
  const firstSlash = importPath.indexOf("/");
  if (firstSlash === -1) {
    return importPath;
  }
  return importPath.slice(0, firstSlash);
}

