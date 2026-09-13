#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SdkIndexer } from './indexer.js';

const DEFAULT_SDK = '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk';

const server = new McpServer({
  name: 'ios-sdk-mcp',
  version: '0.1.0',
});

// Build index on startup
const sdkPath = process.env.IOS_SDK_PATH || DEFAULT_SDK;
console.error(`Building SDK index from ${sdkPath}...`);
const indexer = await SdkIndexer.create();
indexer.buildIndex(sdkPath);
console.error('Index ready.');

// Tool 1: Search APIs
server.tool(
  'search_apis',
  'Search iOS SDK APIs by name, framework, or keyword',
  {
    query: z.string().describe('Search keyword (e.g. "glassEffect", "LanguageModelSession")'),
    framework: z.string().optional().describe('Filter by framework name'),
    ios_version: z.number().optional().describe('Max iOS version (e.g. 270000 for iOS 27)'),
  },
  async ({ query, framework, ios_version }) => {
    const results = indexer.search(query, framework, ios_version);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

// Tool 2: Get API detail
server.tool(
  'get_api_detail',
  'Get full details of a specific iOS SDK API',
  {
    name: z.string().describe('API name (e.g. "LanguageModelSession")'),
    framework: z.string().optional().describe('Framework name for disambiguation'),
  },
  async ({ name, framework }) => {
    const detail = indexer.getDetail(name, framework);
    if (!detail) {
      return { content: [{ type: 'text', text: `API "${name}" not found` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
  }
);

// Tool 3: List frameworks
server.tool(
  'list_frameworks',
  'List all iOS SDK frameworks with API counts',
  {
    ios_version: z.number().optional().describe('Show only frameworks available up to this version'),
    new_only: z.boolean().optional().describe('Show only new frameworks (iOS 26+)'),
  },
  async ({ ios_version, new_only }) => {
    let frameworks = indexer.listFrameworks();
    if (ios_version) frameworks = frameworks.filter(f => f.minIOSVersion <= ios_version);
    if (new_only) frameworks = frameworks.filter(f => f.isNew);
    return { content: [{ type: 'text', text: JSON.stringify(frameworks, null, 2) }] };
  }
);

// Tool 4: Get type hierarchy
server.tool(
  'get_type_hierarchy',
  'Get type hierarchy, protocols, and extensions for a type',
  {
    name: z.string().describe('Type name (e.g. "UIViewController")'),
  },
  async ({ name }) => {
    const hierarchy = indexer.getTypeHierarchy(name);
    if (!hierarchy) {
      return { content: [{ type: 'text', text: `Type "${name}" not found` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(hierarchy, null, 2) }] };
  }
);

// Tool 5: Get new APIs in a version
server.tool(
  'get_new_apis',
  'Get all APIs introduced in a specific iOS version',
  {
    ios_version: z.number().describe('iOS version (e.g. 270000 for iOS 27)'),
    framework: z.string().optional().describe('Filter by framework'),
  },
  async ({ ios_version, framework }) => {
    const results = indexer.getNewApis(ios_version, framework);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
);

// Tool 6: Get SDK stats
server.tool(
  'get_sdk_stats',
  'Get overview statistics of the indexed iOS SDK',
  {},
  async () => {
    const stats = indexer.getStats();
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ios-sdk-mcp running on stdio');
}

main().catch(console.error);
