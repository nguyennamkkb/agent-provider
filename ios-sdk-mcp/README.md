# ios-sdk-mcp

MCP server for querying iOS SDK APIs from Xcode.

## Features

- Index all `.swiftinterface` and `.h` files from Xcode SDK
- Full-text search with SQLite
- API detail lookup
- Framework listing
- Type hierarchy traversal
- New API discovery by iOS version

## Setup

```bash
npm install
npm run build
```

## Usage

Add to your MCP client config:

```json
{
  "mcpServers": {
    "ios-sdk": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

Or with custom SDK path:

```json
{
  "mcpServers": {
    "ios-sdk": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "IOS_SDK_PATH": "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk"
      }
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_apis` | Search iOS SDK APIs by name, framework, or keyword |
| `get_api_detail` | Get full API signature and metadata |
| `list_frameworks` | List all frameworks with API counts |
| `get_type_hierarchy` | Get type inheritance and extensions |
| `get_new_apis` | Get all new APIs in a specific iOS version |
| `get_sdk_stats` | Get SDK overview statistics |

## Architecture

```
ios-sdk-mcp/
├── src/
│   ├── index.ts        # MCP server entry (stdio transport)
│   ├── indexer.ts      # SQLite index builder
│   ├── parser.ts       # SwiftInterface + ObjC header parser
│   └── types.ts        # Type definitions
├── package.json
├── tsconfig.json
└── README.md
```

## How It Works

1. **Startup**: Scan Xcode SDK path, parse all `.swiftinterface` and `.h` files
2. **Index**: Store API symbols in SQLite with metadata (name, kind, framework, availability)
3. **Query**: Expose 6 MCP tools for searching, filtering, and traversing the SDK

## Data Flow

```
Xcode SDK (.swiftinterface + .h)
  → Parser (regex-based extraction)
  → SQLite (in-memory index)
  → MCP Tools (search, detail, hierarchy, stats)
```
