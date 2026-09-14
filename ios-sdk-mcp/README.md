# ios-sdk-mcp

MCP server for querying iOS SDK APIs from Xcode — optimized so an AI agent understands
**what an API does, which iOS version introduced/deprecated it, and how to use it**
(version metadata + usage guides, not just names).

## Features

- Scope-aware Swift parser (`extension` availability inheritance, `open`/`nonisolated`/
  attribute prefixes, `macro`/`associatedtype`/`case`, both `@available` families)
- Inline-macro ObjC parser (`API_AVAILABLE` suffixes, `NS_ENUM` members, block `/* */` +
  `//` doc comments) — every decl captured even without availability
- Version-first schema: `introduced_in`, `deprecated_in`, `obsoleted_in`, `renamed_to`
- Docs layer: markdown knowledge (`ios27-full-knowledge.md`, Xcode AdditionalDocumentation)
  searchable via `get_guide`
- Prebuilt SQLite index → MCP startup ~0.2 s (no re-parse per launch)
- 67 unit + integration tests (`npm test`)

## Setup

```bash
npm install
npm run build
npm run build-index -- --out symbols.db   # one-time (~12 s, ~98 MB)
```

## Usage

Add to your MCP client config:

```json
{
  "mcpServers": {
    "ios-sdk": {
      "command": "node",
      "args": ["/path/to/ios-sdk-mcp/dist/index.js"],
      "env": {
        "IOS_INDEX_PATH": "/path/to/ios-sdk-mcp/symbols.db"
      }
    }
  }
}
```

Without `IOS_INDEX_PATH` the server builds the index in memory on startup
(~12 s, then works normally). Custom SDK path via `IOS_SDK_PATH`.
Rebuild the db file whenever Xcode is upgraded (`npm run build-index -- --out symbols.db`).

## Available Tools (8)

| Tool | AI answers |
|------|-------------|
| `search_apis` | Find APIs — ranked exact > prefix > contains; filters `framework`, `ios_version`, `kind` |
| `get_api_detail` | Full signature + versions + deprecation + doc comment (concrete decls rank above extensions) |
| `get_type_members` | All members of a type (methods, properties, enum cases) |
| `get_new_apis` | "What's new in iOS 26 for SwiftUI?" |
| `get_deprecated` | Deprecated/obsoleted APIs + `renamed_to` for code migration |
| `get_guide` | Usage guides + code examples from the knowledge docs |
| `list_frameworks` | Framework discovery (`new_only` for iOS 26+) |
| `get_sdk_stats` | Index stats incl. version coverage |

## Architecture

```
ios-sdk-mcp/
├── src/
│   ├── index.ts        # MCP server entry (stdio, opens symbols.db read-only)
│   ├── build-index.ts  # One-time builder: SDK + docs -> symbols.db
│   ├── indexer.ts      # SQLite store + ranked queries
│   ├── parser.ts       # Scope-aware Swift + inline-macro ObjC parsers
│   ├── parser.test.ts  # 50+ parser fixtures (attribute traps, version families)
│   ├── indexer.test.ts # Integration tests on a fixture SDK
│   └── types.ts        # Type definitions
├── RESEARCH.md         # SDK anatomy research (source of truth for parser design)
└── README.md
```

## Data Flow

```
.swiftinterface ──> swift_parser (scope stack + strip attrs + 2 @available families) ──┐
.h headers ───────> objc_parser (inline macros + preceding comments) ─────────────────┤──> symbols.db ──> MCP tools
knowledge.md + AdditionalDocumentation/*.md ──> docs_loader ──────────────────────────┘
```

Research notes: see [RESEARCH.md](RESEARCH.md).
