import type { SyntaxNode, Tree } from "../parser/treesitter";
import type { ExtractedImport } from "../parser/imports";
import { isExternalImport, getPackageName } from "../parser/imports";
import type { Symbol, SymbolEdgeInsert, SymbolEdgeKind } from "../db/schema";

export interface SymbolEdgeInfo {
  fromSymbolId: number;
  toSymbolId: number | null;
  kind: SymbolEdgeKind;
  externalPackage: string | null;
  externalSymbolName: string | null;
}

interface SymbolMap {
  // Map of symbol name -> symbol record (for current file)
  byName: Map<string, Symbol>;
  // Map of file_id -> symbols in that file
  byFileId: Map<number, Symbol[]>;
}

interface ImportedSymbolInfo {
  localName: string;
  originalName: string;
  sourceFile: number | null; // null for external
  externalPackage: string | null;
}

export function createSymbolMap(symbols: Symbol[]): SymbolMap {
  const byName = new Map<string, Symbol>();
  const byFileId = new Map<number, Symbol[]>();
  
  for (const symbol of symbols) {
    byName.set(symbol.name, symbol);
    
    const fileSymbols = byFileId.get(symbol.file_id) || [];
    fileSymbols.push(symbol);
    byFileId.set(symbol.file_id, fileSymbols);
  }
  
  return { byName, byFileId };
}

// Build a map of imported symbols for a file
export function buildImportedSymbolsMap(
  imports: ExtractedImport[],
  symbolMap: SymbolMap,
  filePathToId: Map<string, number>
): Map<string, ImportedSymbolInfo> {
  const importedSymbols = new Map<string, ImportedSymbolInfo>();
  
  for (const imp of imports) {
    const isExternal = isExternalImport(imp.source);
    const packageName = isExternal ? getPackageName(imp.source) : null;
    
    for (const sym of imp.symbols) {
      const localName = sym.alias || sym.name;
      
      importedSymbols.set(localName, {
        localName,
        originalName: sym.name,
        sourceFile: null, // Will be resolved later if needed
        externalPackage: packageName,
      });
    }
  }
  
  return importedSymbols;
}

// Extract symbol edges from AST
export function extractSymbolEdges(
  tree: Tree,
  fileSymbols: Symbol[],
  imports: ExtractedImport[],
  allSymbols: SymbolMap,
  codebaseSlug: string
): SymbolEdgeInsert[] {
  const edges: SymbolEdgeInsert[] = [];
  const seenEdges = new Set<string>();
  
  // Build map of local symbol names
  const localSymbolsByName = new Map<string, Symbol>();
  for (const sym of fileSymbols) {
    localSymbolsByName.set(sym.name, sym);
  }
  
  // Build map of imported symbols
  const importedSymbols = new Map<string, { originalName: string; externalPackage: string | null }>();
  for (const imp of imports) {
    const isExternal = isExternalImport(imp.source);
    const packageName = isExternal ? getPackageName(imp.source) : null;
    
    for (const sym of imp.symbols) {
      const localName = sym.alias || sym.name;
      importedSymbols.set(localName, {
        originalName: sym.name,
        externalPackage: packageName,
      });
    }
  }
  
  // Traverse AST to find relationships
  traverseForEdges(
    tree.rootNode,
    fileSymbols,
    localSymbolsByName,
    importedSymbols,
    allSymbols,
    edges,
    seenEdges,
    codebaseSlug
  );
  
  return edges;
}

function traverseForEdges(
  node: SyntaxNode,
  fileSymbols: Symbol[],
  localSymbols: Map<string, Symbol>,
  importedSymbols: Map<string, { originalName: string; externalPackage: string | null }>,
  allSymbols: SymbolMap,
  edges: SymbolEdgeInsert[],
  seenEdges: Set<string>,
  codebaseSlug: string
): void {
  // Handle class heritage (extends, implements)
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    extractClassEdges(node, localSymbols, importedSymbols, allSymbols, edges, seenEdges, codebaseSlug);
  }
  
  // Handle function calls
  if (node.type === "call_expression") {
    extractCallEdges(node, localSymbols, importedSymbols, allSymbols, edges, seenEdges, codebaseSlug);
  }
  
  // Handle type references
  if (node.type === "type_annotation" || node.type === "type_reference") {
    extractTypeReferenceEdges(node, localSymbols, importedSymbols, allSymbols, edges, seenEdges, codebaseSlug);
  }
  
  // Handle identifier references (variable usage)
  if (node.type === "identifier" && isReferenceContext(node)) {
    extractReferenceEdges(node, localSymbols, importedSymbols, allSymbols, edges, seenEdges, codebaseSlug);
  }
  
  // Recurse
  for (const child of node.children) {
    traverseForEdges(child, fileSymbols, localSymbols, importedSymbols, allSymbols, edges, seenEdges, codebaseSlug);
  }
}

function extractClassEdges(
  node: SyntaxNode,
  localSymbols: Map<string, Symbol>,
  importedSymbols: Map<string, { originalName: string; externalPackage: string | null }>,
  allSymbols: SymbolMap,
  edges: SymbolEdgeInsert[],
  seenEdges: Set<string>,
  codebaseSlug: string
): void {
  const className = node.childForFieldName("name")?.text;
  if (!className) return;
  
  const classSymbol = localSymbols.get(className);
  if (!classSymbol) return;
  
  // Find extends clause
  const heritageClause = node.children.find((c) => c.type === "class_heritage");
  if (!heritageClause) return;
  
  for (const child of heritageClause.children) {
    // extends
    if (child.type === "extends_clause") {
      const extendsType = child.children.find(
        (c) => c.type === "identifier" || c.type === "member_expression"
      );
      if (extendsType) {
        const typeName = getTypeName(extendsType);
        addSymbolEdge(
          classSymbol,
          typeName,
          "extends",
          localSymbols,
          importedSymbols,
          allSymbols,
          edges,
          seenEdges,
          codebaseSlug
        );
      }
    }
    
    // implements
    if (child.type === "implements_clause") {
      for (const impl of child.children) {
        if (impl.type === "identifier" || impl.type === "generic_type") {
          const typeName = getTypeName(impl);
          addSymbolEdge(
            classSymbol,
            typeName,
            "implements",
            localSymbols,
            importedSymbols,
            allSymbols,
            edges,
            seenEdges,
            codebaseSlug
          );
        }
      }
    }
  }
}

function extractCallEdges(
  node: SyntaxNode,
  localSymbols: Map<string, Symbol>,
  importedSymbols: Map<string, { originalName: string; externalPackage: string | null }>,
  allSymbols: SymbolMap,
  edges: SymbolEdgeInsert[],
  seenEdges: Set<string>,
  codebaseSlug: string
): void {
  const funcNode = node.childForFieldName("function");
  if (!funcNode) return;
  
  // Get the calling context (which symbol contains this call)
  const containingSymbol = findContainingSymbol(node, localSymbols);
  if (!containingSymbol) return;
  
  // Get the called function name
  let calledName: string | null = null;
  if (funcNode.type === "identifier") {
    calledName = funcNode.text;
  } else if (funcNode.type === "member_expression") {
    // For method calls like obj.method(), get the method name
    const property = funcNode.childForFieldName("property");
    if (property) {
      calledName = property.text;
    }
  }
  
  if (calledName) {
    addSymbolEdge(
      containingSymbol,
      calledName,
      "calls",
      localSymbols,
      importedSymbols,
      allSymbols,
      edges,
      seenEdges,
      codebaseSlug
    );
  }
}

function extractTypeReferenceEdges(
  node: SyntaxNode,
  localSymbols: Map<string, Symbol>,
  importedSymbols: Map<string, { originalName: string; externalPackage: string | null }>,
  allSymbols: SymbolMap,
  edges: SymbolEdgeInsert[],
  seenEdges: Set<string>,
  codebaseSlug: string
): void {
  const containingSymbol = findContainingSymbol(node, localSymbols);
  if (!containingSymbol) return;
  
  // Find type identifiers
  const typeId = findTypeIdentifier(node);
  if (typeId) {
    addSymbolEdge(
      containingSymbol,
      typeId,
      "type_reference",
      localSymbols,
      importedSymbols,
      allSymbols,
      edges,
      seenEdges,
      codebaseSlug
    );
  }
}

function extractReferenceEdges(
  node: SyntaxNode,
  localSymbols: Map<string, Symbol>,
  importedSymbols: Map<string, { originalName: string; externalPackage: string | null }>,
  allSymbols: SymbolMap,
  edges: SymbolEdgeInsert[],
  seenEdges: Set<string>,
  codebaseSlug: string
): void {
  const containingSymbol = findContainingSymbol(node, localSymbols);
  if (!containingSymbol) return;
  
  const refName = node.text;
  
  // Skip if it's the symbol itself
  if (refName === containingSymbol.name) return;
  
  // Skip if it's a property access (handled by member_expression)
  if (node.parent?.type === "member_expression") {
    const obj = node.parent.childForFieldName("object");
    if (obj !== node) return; // This is the property, not the object
  }
  
  addSymbolEdge(
    containingSymbol,
    refName,
    "references",
    localSymbols,
    importedSymbols,
    allSymbols,
    edges,
    seenEdges,
    codebaseSlug
  );
}

function addSymbolEdge(
  fromSymbol: Symbol,
  toName: string,
  kind: SymbolEdgeKind,
  localSymbols: Map<string, Symbol>,
  importedSymbols: Map<string, { originalName: string; externalPackage: string | null }>,
  allSymbols: SymbolMap,
  edges: SymbolEdgeInsert[],
  seenEdges: Set<string>,
  codebaseSlug: string
): void {
  // Check if it's a local symbol
  const localTarget = localSymbols.get(toName);
  if (localTarget && localTarget.id !== fromSymbol.id) {
    const edgeKey = `${fromSymbol.id}:${localTarget.id}:${kind}`;
    if (!seenEdges.has(edgeKey)) {
      seenEdges.add(edgeKey);
      edges.push({
        codebase_slug: codebaseSlug,
        from_symbol_id: fromSymbol.id,
        to_symbol_id: localTarget.id,
        kind,
      });
    }
    return;
  }
  
  // Check if it's an imported symbol
  const imported = importedSymbols.get(toName);
  if (imported) {
    // Try to find the original symbol in the codebase
    const originalSymbol = allSymbols.byName.get(imported.originalName);
    
    if (originalSymbol) {
      const edgeKey = `${fromSymbol.id}:${originalSymbol.id}:${kind}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          codebase_slug: codebaseSlug,
          from_symbol_id: fromSymbol.id,
          to_symbol_id: originalSymbol.id,
          kind,
        });
      }
    } else if (imported.externalPackage) {
      // External symbol
      const edgeKey = `${fromSymbol.id}:null:${kind}:${imported.externalPackage}:${imported.originalName}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          codebase_slug: codebaseSlug,
          from_symbol_id: fromSymbol.id,
          to_symbol_id: null,
          kind,
          external_package: imported.externalPackage,
          external_symbol_name: imported.originalName,
        });
      }
    }
  }
}

function findContainingSymbol(node: SyntaxNode, localSymbols: Map<string, Symbol>): Symbol | null {
  let current: SyntaxNode | null = node;
  
  while (current) {
    // Check if this node is a symbol declaration
    if (isSymbolDeclaration(current)) {
      const name = getDeclarationName(current);
      if (name) {
        const symbol = localSymbols.get(name);
        if (symbol) {
          return symbol;
        }
      }
    }
    current = current.parent;
  }
  
  return null;
}

function isSymbolDeclaration(node: SyntaxNode): boolean {
  const declarationTypes = [
    "function_declaration",
    "class_declaration",
    "method_definition",
    "arrow_function",
    "variable_declarator",
    "interface_declaration",
    "type_alias_declaration",
  ];
  return declarationTypes.includes(node.type);
}

function getDeclarationName(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;
  
  // For arrow functions assigned to variables
  if (node.type === "variable_declarator") {
    const name = node.childForFieldName("name");
    if (name?.type === "identifier") {
      return name.text;
    }
  }
  
  return null;
}

function getTypeName(node: SyntaxNode): string {
  if (node.type === "identifier") {
    return node.text;
  }
  if (node.type === "generic_type") {
    const name = node.children.find((c) => c.type === "identifier" || c.type === "type_identifier");
    return name?.text || "";
  }
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property");
    return property?.text || "";
  }
  return node.text;
}

function findTypeIdentifier(node: SyntaxNode): string | null {
  if (node.type === "identifier" || node.type === "type_identifier") {
    return node.text;
  }
  
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "type_identifier") {
      return child.text;
    }
    if (child.type === "generic_type") {
      const name = child.children.find((c) => c.type === "identifier" || c.type === "type_identifier");
      if (name) return name.text;
    }
  }
  
  return null;
}

function isReferenceContext(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  
  // Skip if it's a declaration name
  if (parent.childForFieldName("name") === node) {
    return false;
  }
  
  // Skip import specifiers
  if (parent.type === "import_specifier" || parent.type === "import_clause") {
    return false;
  }
  
  // Skip export specifiers
  if (parent.type === "export_specifier") {
    return false;
  }
  
  // Skip property definitions
  if (parent.type === "pair" && parent.childForFieldName("key") === node) {
    return false;
  }
  
  // Skip type annotations (handled separately)
  if (parent.type === "type_annotation" || parent.type === "type_reference") {
    return false;
  }
  
  return true;
}

