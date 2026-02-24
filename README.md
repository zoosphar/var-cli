# VAR CLI

A static analysis engine that parses TypeScript/JavaScript codebases into queryable dependency graphs, powered by Tree-sitter AST parsing and LLM-driven code annotation.

Codemap scans your source code, extracts every symbol and its relationships, stores the full dependency graph in PostgreSQL, and optionally annotates it with AI-generated metadata — turning any codebase into a structured, searchable knowledge base.

## Why Codemap?

Understanding large codebases is hard. Grep and IDE search find text matches, not meaning. Codemap solves this by building a **complete graph of your code's structure** — every class, function, type, and the relationships between them — then layering on AI-powered annotations that describe *what* each piece does and *why* it exists.

**Use cases:**
- Onboard onto unfamiliar codebases in minutes, not days
- Ask natural language questions about how systems work
- Audit dependency chains and identify tightly coupled modules
- Auto-generate architectural documentation from source code
- Power downstream tools (code review bots, migration planners, refactoring assistants)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI (Commander)                         │
│                  scan  ·  annotate  ·  query                    │
└──────────┬──────────────────┬──────────────────┬────────────────┘
           │                  │                  │
     ┌─────▼─────┐    ┌──────▼──────┐    ┌──────▼──────┐
     │  Scanner   │    │  Annotator  │    │   Query     │
     │  walker    │    │  context    │    │   Engine    │
     │  filter    │    │  prompts    │    │  (OpenAI)   │
     └─────┬─────┘    │  gemini     │    │  symbol     │
           │          │  parser     │    │  search     │
     ┌─────▼─────┐    └──────┬──────┘    └──────┬──────┘
     │  Parser   │           │                  │
     │  treesit  │           │                  │
     │  symbols  │     ┌─────▼──────────────────▼─────┐
     │  imports  │     │                              │
     └─────┬─────┘     │     PostgreSQL Database      │
           │           │                              │
     ┌─────▼─────┐     │  codebases · folders · files │
     │  Edges    │     │  symbols · file_edges        │
     │  file     ├────►│  symbol_edges · annotations  │
     │  symbol   │     │                              │
     └───────────┘     └──────────────────────────────┘
```

**Pipeline:** Scan → Parse → Store → Resolve Edges → Annotate → Query

| Phase | What happens | Output |
|-------|-------------|--------|
| **Scan** | Recursively walk directories, apply exclusion filters | File & folder inventory |
| **Parse** | Tree-sitter AST analysis on every file | Symbols + imports/exports |
| **Store** | Batch insert into PostgreSQL | Persisted graph nodes |
| **Edges** | Resolve file-to-file and symbol-to-symbol relationships | Dependency edges |
| **Annotate** | LLM generates purpose, category, confidence per symbol | Annotation metadata |
| **Query** | Natural language search over the graph via GPT-4 tool calling | Answers with source refs |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun / Node.js |
| Language | TypeScript 5.7 |
| AST Parsing | Tree-sitter (JS/TS/TSX grammars) |
| Database | PostgreSQL |
| CLI Framework | Commander |
| Annotation LLM | Google Gemini 2.5 Flash |
| Query LLM | OpenAI GPT-4.1 |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- PostgreSQL >= 14
- API keys for Gemini and/or OpenAI (optional, only needed for `annotate` and `query`)

### Install

```bash
git clone <repo-url>
cd codemap-cli
bun install
```

### Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:

| Variable | Required for | Description |
|----------|-------------|-------------|
| `DATABASE_URL` | All commands | PostgreSQL connection string |
| `GEMINI_API_KEY` | `annotate` | Google Generative AI API key |
| `OPENAI_API_KEY` | `query` | OpenAI API key |

### Create the Database

```bash
createdb var_codemap
```

Then run the schema migration:

```sql
-- Codebases
CREATE TABLE codebases (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  root_path TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Folders
CREATE TABLE folders (
  id SERIAL PRIMARY KEY,
  codebase_slug VARCHAR(255) NOT NULL,
  parent_folder_id INTEGER REFERENCES folders(id),
  relative_path TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Files
CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  codebase_slug VARCHAR(255) NOT NULL,
  relative_path TEXT NOT NULL,
  language VARCHAR(50) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Symbols
CREATE TABLE symbols (
  id SERIAL PRIMARY KEY,
  codebase_slug VARCHAR(255) NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id),
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(50) NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- File-level dependency edges
CREATE TABLE file_edges (
  id SERIAL PRIMARY KEY,
  codebase_slug VARCHAR(255) NOT NULL,
  from_file_id INTEGER NOT NULL REFERENCES files(id),
  to_file_id INTEGER REFERENCES files(id),
  kind VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Symbol-level dependency edges
CREATE TABLE symbol_edges (
  id SERIAL PRIMARY KEY,
  codebase_slug VARCHAR(255) NOT NULL,
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id),
  to_symbol_id INTEGER REFERENCES symbols(id),
  kind VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_folders_codebase ON folders(codebase_slug);
CREATE INDEX idx_files_codebase ON files(codebase_slug);
CREATE INDEX idx_symbols_codebase ON symbols(codebase_slug);
CREATE INDEX idx_symbols_file ON symbols(file_id);
CREATE INDEX idx_file_edges_codebase ON file_edges(codebase_slug);
CREATE INDEX idx_file_edges_from ON file_edges(from_file_id);
CREATE INDEX idx_file_edges_to ON file_edges(to_file_id);
CREATE INDEX idx_symbol_edges_codebase ON symbol_edges(codebase_slug);
CREATE INDEX idx_symbol_edges_from ON symbol_edges(from_symbol_id);
CREATE INDEX idx_symbol_edges_to ON symbol_edges(to_symbol_id);
```

## Usage

### `scan` — Build the dependency graph

Scans a codebase, extracts all symbols and relationships, and persists them to PostgreSQL.

```bash
# Scan a project
codemap scan /path/to/project

# Custom name
codemap scan /path/to/project --name "my-api"

# Exclude additional directories
codemap scan /path/to/project --exclude tests fixtures e2e

# Force a fresh scan (new slug with timestamp)
codemap scan /path/to/project --fresh

# Scan and immediately annotate with AI
codemap scan /path/to/project --annotate --max-files 50
```

**Options:**

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Custom codebase name (defaults to directory name) |
| `-e, --exclude <patterns...>` | Additional directories to exclude from scan |
| `--fresh` | Generate a unique slug with timestamp |
| `--annotate` | Run LLM annotation immediately after scanning |
| `--max-files <n>` | Limit annotation to first N files |

**Example output:**

```
Scanning codebase: my-api
   Path: /Users/you/projects/my-api

Walking directory structure...
   Found 42 folders and 187 files

Inserting folders...
Processing files and extracting symbols...
   Extracted 2,341 symbols

Resolving file dependencies...
   Created 612 file edges

Resolving symbol dependencies...
   Created 1,847 symbol edges

Scan complete!
   Codebase slug: my-api
   Folders: 42
   Files: 187
   Symbols: 2,341
   File edges: 612
   Symbol edges: 1,847
```

### `annotate` — AI-powered code annotation

Generates structured metadata for every file and symbol using Google Gemini. Each annotation includes a responsibility summary, a category tag, and a confidence score.

```bash
# Annotate a previously scanned codebase
codemap annotate my-api

# Re-annotate (overwrite existing annotations)
codemap annotate my-api --force

# Annotate only a specific folder
codemap annotate my-api --folder src/services

# Control parallelism
codemap annotate my-api --workers 10

# Limit scope
codemap annotate my-api --max-files 20 --verbose
```

**Options:**

| Flag | Description |
|------|-------------|
| `--force` | Re-annotate even if annotations already exist |
| `--max-files <n>` | Limit number of files to process |
| `--folder <path>` | Only annotate files under this relative path |
| `--workers <n>` | Number of parallel LLM requests (default: 5) |
| `-v, --verbose` | Show detailed progress per file |

**Annotation categories:** `api`, `ui`, `component`, `utility`, `config`, `data`, `service`, `middleware`, `model`, `test`, `style`, `build`

### `query` — Ask questions about your codebase

Uses OpenAI GPT-4 with tool calling to search the dependency graph and answer natural language questions about your code.

```bash
# One-off question
codemap query my-api "How does authentication work?"

# Interactive mode (continuous Q&A)
codemap query my-api --interactive

# Use a specific model
codemap query my-api "What calls the PaymentService?" --model gpt-4.1
```

**Options:**

| Flag | Description |
|------|-------------|
| `--api-key <key>` | OpenAI API key (overrides env var) |
| `--model <model>` | OpenAI model to use (default: `gpt-4.1`) |
| `--temperature <n>` | LLM temperature (default: `0.3`) |
| `--interactive` | Enter continuous Q&A mode |

**How it works under the hood:**

1. Your question is sent to GPT-4 along with the codebase's top-level symbol index
2. The LLM uses tool calling to invoke a `get_symbols_from_query` function
3. Symbols are scored by name relevance, structural importance, and proximity
4. Top 20 matching symbols (with full source code) are returned to the LLM
5. The LLM synthesizes a final answer with file paths and line references

## Data Model

### Symbol Kinds

| Kind | Description | Example |
|------|-------------|---------|
| `class` | Class declarations | `class UserService {}` |
| `function` | Function declarations & arrow functions | `function validate() {}` |
| `method` | Class methods | `getUser() {}` |
| `variable` | Mutable bindings | `let count = 0` |
| `const` | Immutable bindings | `const API_URL = "..."` |
| `interface` | Interface declarations | `interface User {}` |
| `type` | Type aliases | `type ID = string` |
| `enum` | Enum declarations | `enum Status {}` |

### Edge Kinds

**File edges** — relationships between files:

| Kind | Meaning |
|------|---------|
| `imports` | File A imports from File B |
| `re_exports` | File A re-exports from File B |

**Symbol edges** — relationships between symbols:

| Kind | Meaning |
|------|---------|
| `imports` | Symbol A is imported as Symbol B |
| `calls` | Function A invokes Function B |
| `extends` | Class A extends Class B |
| `implements` | Class A implements Interface B |
| `references` | Symbol A references Symbol B |
| `type_reference` | Symbol A uses a type from Symbol B |

## Default Exclusions

**Directories:** `node_modules`, `.git`, `dist`, `build`, `.next`, `.nuxt`, `.output`, `.cache`, `.turbo`, `coverage`, `.nyc_output`, `__pycache__`, `.venv`, `venv`, `.idea`, `.vscode`

**Files:** `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `.DS_Store`, `Thumbs.db`

**Supported extensions:** `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`

## Development

```bash
# Run in dev mode
bun run dev scan /path/to/project

# Type check
bun run typecheck

# Build for production
bun run build
```

## Project Structure

```
src/
├── index.ts              # CLI entry point and command definitions
├── scanner/
│   ├── walker.ts         # Recursive directory traversal
│   └── filter.ts         # File/directory exclusion rules
├── parser/
│   ├── treesitter.ts     # Tree-sitter initialization
│   ├── symbols.ts        # Symbol extraction from ASTs
│   └── imports.ts        # Import/export statement parsing
├── edges/
│   ├── file-edges.ts     # File-to-file dependency resolution
│   └── symbol-edges.ts   # Symbol-to-symbol relationship extraction
├── db/
│   ├── client.ts         # PostgreSQL connection
│   ├── schema.ts         # TypeScript type definitions
│   ├── queries.ts        # CRUD operations
│   └── annotations.ts    # Annotation persistence
├── annotate/
│   ├── index.ts          # Annotation orchestrator
│   ├── context.ts        # Context builder for LLM prompts
│   ├── gemini.ts         # Google Gemini API client
│   ├── prompts.ts        # Prompt templates
│   └── parser.ts         # LLM response parser
├── tools/
│   ├── openai-client.ts  # OpenAI GPT integration
│   └── symbol-search.ts  # Symbol scoring and retrieval
└── utils/
    ├── slug.ts           # Codebase slug generation
    └── hash.ts           # SHA-256 content hashing
```

## License

MIT
