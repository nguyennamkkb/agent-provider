#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { SdkIndexer } from './indexer.js';

const DEFAULT_SDK = '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk';

const server = new McpServer({
  name: 'ios-sdk-mcp',
  version: '0.2.0',
});

const sdkPath = process.env.IOS_SDK_PATH || DEFAULT_SDK;
const indexPath = process.env.IOS_INDEX_PATH; // optional persistent cache

console.error(`Opening SDK index (sdk=${sdkPath})...`);
const indexer = await SdkIndexer.create(indexPath);

if (indexer.isEmpty()) {
  console.error('Empty index, building from SDK (one-time, ~seconds)...');
  indexer.buildIndex(sdkPath);
  // Docs layer: usage guides / examples (RESEARCH.md section 5)
  const docsEnv = process.env.IOS_DOCS_PATH;
  const repoKnowledge = fileURLToPath(new URL('../../ios27-full-knowledge.md', import.meta.url));
  const candidates = docsEnv ? [docsEnv] : [repoKnowledge];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      for (const f of fs.readdirSync(c).filter((f) => f.endsWith('.md'))) {
        const n = indexer.loadDocsFromFile(`${c}/${f}`);
        console.error(`Loaded ${n} doc sections from ${f}`);
      }
    } else {
      const n = indexer.loadDocsFromFile(c);
      if (n > 0) console.error(`Loaded ${n} doc sections from ${c}`);
    }
  }
  if (indexPath) {
    indexer.save(indexPath);
    console.error(`Index cached at ${indexPath}`);
  }
}
console.error('Index ready.');

// search_apis: ranked (exact > prefix > contains)
server.tool(
  'search_apis',
  'Search iOS SDK APIs by name, framework, or keyword. Ranked: exact match first.',
  {
    query: z.string().describe('Search keyword (e.g. "glassEffect", "LanguageModelSession")'),
    framework: z.string().optional().describe('Filter by framework name'),
    ios_version: z.number().optional().describe('Only APIs available in this iOS version (e.g. 260000 for iOS 26)'),
    kind: z.string().optional().describe('Filter by kind: class, struct, enum, protocol, func, var, macro, typealias, case'),
  },
  async ({ query, framework, ios_version, kind }) => {
    const results = indexer.search(query, framework, ios_version, kind);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

// get_api_detail
server.tool(
  'get_api_detail',
  'Get full details of a specific iOS SDK API: signature, versions, deprecation, plus its member list (methods/properties/inits) so you know what to explore next',
  {
    name: z.string().describe('API name (e.g. "LanguageModelSession")'),
    framework: z.string().optional().describe('Framework name for disambiguation'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed members (default false)'),
  },
  async ({ name, framework, include_internal }) => {
    const detail = indexer.getDetail(name, framework, include_internal ?? false);
    if (!detail) {
      return { content: [{ type: 'text', text: `API "${name}" not found` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
  },
);

// get_type_members (replaces get_type_hierarchy)
server.tool(
  'get_type_members',
  'List all members of a type (methods, properties, cases) via parent_type',
  {
    name: z.string().describe('Type name, short or qualified (e.g. "View" or "SwiftUICore.View")'),
    framework: z.string().optional().describe('Filter by framework'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed Apple APIs (default false)'),
  },
  async ({ name, framework, include_internal }) => {
    const members = indexer.getTypeMembers(name, framework, 200, include_internal ?? false);
    if (members.length === 0) {
      return { content: [{ type: 'text', text: `No members found for type "${name}"` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(members, null, 2) }] };
  },
);

// list_frameworks
server.tool(
  'list_frameworks',
  'List all iOS SDK frameworks with API counts',
  {
    ios_version: z.number().optional().describe('Show only frameworks available up to this version'),
    new_only: z.boolean().optional().describe('Show only new frameworks (iOS 26+)'),
  },
  async ({ ios_version, new_only }) => {
    let frameworks = indexer.listFrameworks();
    if (ios_version) frameworks = frameworks.filter((f) => f.minIOSVersion <= ios_version);
    if (new_only) frameworks = frameworks.filter((f) => f.isNew);
    return { content: [{ type: 'text', text: JSON.stringify(frameworks, null, 2) }] };
  },
);

// get_new_apis
server.tool(
  'get_new_apis',
  'Get all APIs introduced in a specific iOS version',
  {
    ios_version: z.number().describe('iOS version (e.g. 260000 for iOS 26)'),
    framework: z.string().optional().describe('Filter by framework'),
  },
  async ({ ios_version, framework }) => {
    const results = indexer.getNewApis(ios_version, framework);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

// get_deprecated (new)
server.tool(
  'get_deprecated',
  'Get deprecated/obsoleted/unavailable APIs with renamed_to for code migration',
  {
    ios_version: z.number().describe('iOS version to check against (e.g. 260000)'),
    framework: z.string().optional().describe('Filter by framework'),
  },
  async ({ ios_version, framework }) => {
    const results = indexer.getDeprecated(ios_version, framework);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

// get_guide (new): usage guides from docs layer
server.tool(
  'get_guide',
  'Get usage guides and code examples for a topic or API from the knowledge docs',
  {
    query: z.string().describe('Topic or API name (e.g. "Liquid Glass", "FoundationModels", "glassEffect")'),
  },
  async ({ query }) => {
    const guides = indexer.getGuide(query);
    if (guides.length === 0) {
      return { content: [{ type: 'text', text: `No guides found for "${query}"` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(guides, null, 2) }] };
  },
);

// get_sdk_stats
server.tool(
  'get_sdk_stats',
  'Get overview statistics of the indexed iOS SDK (coverage, kinds, languages)',
  {},
  async () => {
    const stats = indexer.getStats();
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ios-sdk-mcp running on stdio');
}

main().catch(console.error);
