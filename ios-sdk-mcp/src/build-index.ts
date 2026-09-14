#!/usr/bin/env node
/**
 * One-time index builder: all platform SDKs + docs layer -> SQLite file.
 * MCP server (index.ts) opens this file read-only for instant startup.
 *
 * Usage:
 *   npm run build-index -- --out symbols.db [--platforms ios,watchos] [--docs <dir-or-md>]
 */
import * as fs from 'fs';
import { SdkIndexer } from './indexer.js';
import type { SdkPlatform } from './types.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const outPath = opt('--out') || process.env.IOS_INDEX_PATH || 'symbols.db';
const docsPath = opt('--docs') || process.env.IOS_DOCS_PATH;
const platforms = (opt('--platforms')?.split(',') ??
  process.env.PLATFORMS?.split(',') ?? undefined) as SdkPlatform[] | undefined;

const indexer = await SdkIndexer.create();
const t0 = Date.now();
const total = indexer.buildAll(platforms);
console.error(`Total: ${total} symbols`);

let docSections = 0;
const loadMd = (f: string) => {
  docSections += indexer.loadDocsFromFile(f);
};
if (docsPath) {
  if (fs.existsSync(docsPath) && fs.statSync(docsPath).isDirectory()) {
    for (const f of fs.readdirSync(docsPath).filter((f) => f.endsWith('.md'))) loadMd(`${docsPath}/${f}`);
  } else loadMd(docsPath);
} else {
  // default: repo knowledge doc next to ios-sdk-mcp/
  loadMd(new URL('../../ios27-full-knowledge.md', import.meta.url).pathname);
}
console.error(`Docs: ${docSections} sections`);
console.error(JSON.stringify(indexer.getStats(), null, 2));
indexer.save(outPath);
console.error(`Saved ${outPath} in ${Date.now() - t0}ms`);
indexer.close();
