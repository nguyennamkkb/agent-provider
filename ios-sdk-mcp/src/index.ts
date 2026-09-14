#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { SdkIndexer, SDK_PATHS } from './indexer.js';
import type { SdkPlatform } from './types.js';

const server = new McpServer({
  name: 'ios-sdk-mcp',
  version: '0.3.0',
});

const indexPath = process.env.IOS_INDEX_PATH; // persistent multi-platform cache

console.error('Opening SDK index...');
const indexer = await SdkIndexer.create(indexPath);

if (indexer.isEmpty()) {
  console.error('Empty index, building from all platform SDKs (one-time, ~1 min)...');
  indexer.buildAll();
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
console.error(`SDKs: ${JSON.stringify(Object.keys(SDK_PATHS))}`);
console.error('Index ready.');

const platformDesc =
  'Platform filter: ios (iPhone/iPad), watchos (Watch app, WidgetKit complications, ClockKit), macos, tvos, xros (visionOS). Omit to search all.';

// search_apis: ranked (exact > prefix > contains), deduped across platforms
server.tool(
  'search_apis',
  'Search Apple SDK APIs by name, framework, or keyword. Ranked: exact match first. Same API on many platforms is merged with a platforms list.',
  {
    query: z.string().describe('Search keyword (e.g. "glassEffect", "WKInterfaceController", "TimelineEntry")'),
    framework: z.string().optional().describe('Filter by framework name'),
    ios_version: z.number().optional().describe('Only APIs available in this iOS version (e.g. 260000 for iOS 26)'),
    kind: z.string().optional().describe('Filter by kind: class, struct, enum, protocol, func, var, macro, typealias, case'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ query, framework, ios_version, kind, platform }) => {
    const results = indexer.search(query, framework, ios_version, kind, 50, platform);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

// get_api_detail
server.tool(
  'get_api_detail',
  'Get full details of a specific Apple SDK API: signature, platforms, versions, deprecation, plus its member list (methods/properties/inits) so you know what to explore next',
  {
    name: z.string().describe('API name (e.g. "WKInterfaceController", "TimelineEntry")'),
    framework: z.string().optional().describe('Framework name for disambiguation'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed members (default false)'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ name, framework, include_internal, platform }) => {
    const detail = indexer.getDetail(name, framework, include_internal ?? false, platform as SdkPlatform | undefined);
    if (!detail) {
      return { content: [{ type: 'text', text: `API "${name}" not found` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
  },
);

// get_type_members
server.tool(
  'get_type_members',
  'List all members of a type (methods, properties, cases) via parent_type',
  {
    name: z.string().describe('Type name, short or qualified (e.g. "View" or "SwiftUICore.View")'),
    framework: z.string().optional().describe('Filter by framework'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed Apple APIs (default false)'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ name, framework, include_internal, platform }) => {
    const members = indexer.getTypeMembers(name, framework, 200, include_internal ?? false, platform);
    if (members.length === 0) {
      return { content: [{ type: 'text', text: `No members found for type "${name}"` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(members, null, 2) }] };
  },
);

// list_frameworks
server.tool(
  'list_frameworks',
  'List all Apple SDK frameworks with API counts and the platforms each exists on',
  {
    ios_version: z.number().optional().describe('Show only frameworks available up to this version'),
    new_only: z.boolean().optional().describe('Show only new frameworks (iOS 26+)'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ ios_version, new_only, platform }) => {
    let frameworks = indexer.listFrameworks(platform);
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
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ ios_version, framework, platform }) => {
    const results = indexer.getNewApis(ios_version, framework, platform);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

// get_deprecated
server.tool(
  'get_deprecated',
  'Get deprecated/obsoleted/unavailable APIs with renamed_to for code migration',
  {
    ios_version: z.number().describe('iOS version to check against (e.g. 260000)'),
    framework: z.string().optional().describe('Filter by framework'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ ios_version, framework, platform }) => {
    const results = indexer.getDeprecated(ios_version, framework, platform);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  },
);

// get_guide: usage guides from docs layer
server.tool(
  'get_guide',
  'Get usage guides and code examples for a topic or API from the knowledge docs',
  {
    query: z.string().describe('Topic or API name (e.g. "Liquid Glass", "WidgetKit", "TimelineEntry", "Watch app")'),
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
  'Get overview statistics of the indexed Apple SDKs (coverage, kinds, languages, platforms)',
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
