#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import {
  discoverFiles,
  listFrameworksFast,
  rgMatches,
  rgFiles,
  readWindow,
  analyzeContext,
  tokenize,
  type SdkFile,
} from './sdk.js';
import { convertLine, objcLineMap, rankHits, type ConvertedHit } from './convert.js';
import type { SdkPlatform } from './types.js';

const server = new McpServer({
  name: 'ios-sdk-mcp',
  version: '0.4.0',
});

const platformDesc =
  'Platform filter: ios (iPhone/iPad), watchos (Watch app, WidgetKit complications, ClockKit), macos, tvos, xros (visionOS). Omit to search all.';

function platsArg(platform?: string): SdkPlatform[] | undefined {
  if (!platform) return undefined;
  const p = platform.toLowerCase() as SdkPlatform;
  if (!['ios', 'watchos', 'macos', 'tvos', 'xros'].includes(p)) {
    throw new Error(`Unknown platform "${platform}". Use ios|watchos|macos|tvos|xros.`);
  }
  return [p];
}

function filesFor(framework?: string, platform?: string): SdkFile[] {
  let files = discoverFiles(platsArg(platform));
  if (framework) {
    const fw = framework.toLowerCase();
    files = files.filter((f) => f.framework.toLowerCase() === fw);
  }
  return files;
}

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf-8');
}

const objcMaps = new Map<string, Map<number, { name: string; kind: string; signature: string; parentType?: string; docComment?: string }>>();
function objcMapFor(file: SdkFile) {
  let m = objcMaps.get(file.path);
  if (!m) {
    m = objcLineMap(file, readFile);
    if (objcMaps.size > 50) objcMaps.clear();
    objcMaps.set(file.path, m);
  }
  return m;
}

/** Convert matches -> hits, gom members khi là type detail. */
function toHits(
  matches: { file: string; lineNumber: number; lineText: string }[],
  filesByPath: Map<string, SdkFile>,
  limit: number,
): ConvertedHit[] {
  const out: ConvertedHit[] = [];
  for (const m of matches) {
    if (out.length >= limit) break;
    const file = filesByPath.get(m.file);
    if (!file) continue;
    const hit =
      file.lang === 'objc'
        ? convertLine(file, m.lineNumber, m.lineText, objcMapFor(file))
        : convertLine(file, m.lineNumber, m.lineText);
    if (hit) out.push(hit);
  }
  return out;
}

function filesByPath(files: SdkFile[]): Map<string, SdkFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/** Đọc members trong block scope chứa 1 decl (scope-aware, không đoán theo tên). */
async function readScopeMembers(
  top: ConvertedHit,
  includeInternal: boolean,
): Promise<ConvertedHit[]> {
  const { fileLines } = await import('./sdk.js');
  const lines = fileLines(top.filePath);
  // Đi ngược từ decl tìm dòng mở scope gần nhất chứa nó.
  let openerIdx = -1;
  let depth = 0;
  for (let i = top.lineNumber - 1; i >= Math.max(0, top.lineNumber - 400); i--) {
    const t = (lines[i] ?? '').trim();
    const noStr = t.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const opens = (noStr.match(/\{/g) || []).length;
    const closes = (noStr.match(/\}/g) || []).length;
    depth += closes - opens;
    if (depth < 0) {
      openerIdx = i;
      break;
    }
    if (depth === 0 && /(^|[\s*])(extension|@interface|@protocol)\b/.test(t)) {
      openerIdx = i;
      break;
    }
    // struct/class/enum 1 dòng có `{` mở scope của chính decl (type detail):
    // decl của type nằm ở top.lineNumber nên opener của members là chính nó.
  }
  // Nếu decl của type nằm đúng ở top.lineNumber, members bắt đầu từ dòng SAU nó.
  // (opener search ở trên chỉ dùng cho extension rows / decl lồng nhau.)
  const isTypeDecl = ['struct', 'class', 'enum', 'protocol'].includes(top.kind);
  const startLine = isTypeDecl ? top.lineNumber : (openerIdx >= 0 ? openerIdx + 1 : top.lineNumber);
  // Type decl (struct/class/enum/protocol): members là các dòng trong block của nó.
  // Extension row: members nằm trong các extension cùng tên (gom tất cả).
  const isType = ['struct', 'class', 'enum', 'protocol'].includes(top.kind);
  const scopeNames = isType
    ? [top.name, top.name.split('.').pop()!]
    : [top.parentType ?? top.name, top.name];
  const file: SdkFile = {
    path: top.filePath, framework: top.framework, platform: top.platform, lang: top.lang,
  };
  const map = top.lang === 'objc' ? objcMapFor(file) : undefined;
  const out: ConvertedHit[] = [];
  // Quét từ dòng sau decl (type) / sau opener (extension) tới `}` cân bằng.
  // Đếm brace từ dòng decl của type: `struct X ... {` -> d=1, member ở d>=1,
  // `}` về 0 = hết scope. Getter/setter lồng (d=2) bỏ qua (không phải member).
  let d = 0;
  if (isTypeDecl) {
    const declNoStr = ((lines[top.lineNumber - 1] ?? '').trim()).replace(/"(?:[^"\\]|\\.)*"/g, '""');
    d = (declNoStr.match(/\{/g) || []).length - (declNoStr.match(/\}/g) || []).length;
    if (d <= 0) d = 1; // decl xuống dòng `{`? hiếm — coi như trong scope
  }
  const endAt = isType ? lines.length : Math.min(lines.length, startLine - 1 + 2000);
  for (let i = startLine; i < endAt; i++) {
    const raw = lines[i] ?? '';
    const t = raw.trim();
    const noStr = t.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (isType) {
      d += (noStr.match(/\{/g) || []).length - (noStr.match(/\}/g) || []).length;
      if (d <= 0) break; // `}` đóng scope type
      if (d > 1) continue; // getter/setter/closure lồng — không phải member trực tiếp
    }
    if (!t) continue;
    const hit = convertLine(file, i + 1, raw, map);
    if (!hit) continue;
    if (hit.kind === 'extension') continue;
    if (!includeInternal && hit.name.startsWith('_')) continue;
    // Member của scope này: check bằng convert + parentType, fallback: dòng trong
    // block type mà convert không gắn parent (bare protocol members đã có parent).
    const inScope = scopeNames.some(
      (s) => hit.parentType === s || hit.parentType === top.name,
    );
    if (inScope) {
      if (hit.name === top.name && hit.kind === top.kind) continue;
      out.push(hit);
    } else if (isType && top.lang === 'swift' && d === 1 && ['func', 'var', 'init', 'operator', 'typealias', 'associatedtype', 'macro', 'case'].includes(hit.kind)) {
      // Dòng public trong block type nhưng convert chưa gắn parent (hiếm): gắn tay.
      out.push({ ...hit, parentType: top.name });
    }
    if (out.length >= 20) break;
  }
  // Extension row: gom members từ mọi extension cùng tên trong file.
  if (!isType) {
    const extMembers: ConvertedHit[] = [];
    for (let i = 0; i < lines.length && extMembers.length < 20; i++) {
      const t = (lines[i] ?? '').trim();
      const m = t.match(/^extension\s+([^\s{]+)/);
      if (!m) continue;
      const en = m[1].replace(/<.*>$/, '');
      if (en !== top.name && en !== top.parentType && !en.endsWith(`.${top.name.split('.').pop()!}`)) continue;
      // đọc block extension này
      let dd = 0;
      for (let j = i; j < lines.length && extMembers.length < 20; j++) {
        const r2 = lines[j] ?? '';
        const n2 = r2.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        dd += (n2.match(/\{/g) || []).length - (n2.match(/\}/g) || []).length;
        if (j === i) continue;
        if (dd <= 0) break;
        const h = convertLine(file, j + 1, r2, map);
        if (h && h.kind !== 'extension' && (includeInternal || !h.name.startsWith('_'))) {
          extMembers.push(h);
        }
      }
    }
    return extMembers.slice(0, 20);
  }
  return out.slice(0, 20);
}

// --- search_apis: rg trực tiếp + convert ------------------------------------
server.tool(
  'search_apis',
  'Search Apple SDK APIs by name or keyword, directly in Xcode SDK sources. Case-insensitive; multi-word queries match tokens. Returns converted API objects with signature, versions, framework, platform, file + line.',
  {
    query: z.string().describe('Search keyword (e.g. "ScrollView", "scroll view", "TimelineEntry", "WKInterfaceController")'),
    framework: z.string().optional().describe('Filter by framework name (e.g. "SwiftUI", "WatchKit")'),
    kind: z.string().optional().describe('Filter by kind: class, struct, enum, protocol, func, var, macro, typealias, case, init, operator'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max results (default 20, max 100)'),
  },
  async ({ query, framework, kind, platform, limit }) => {
    const files = filesFor(framework, platform);
    const toks = tokenize(query);
    if (toks.length === 0) {
      return { content: [{ type: 'text', text: 'Empty query (need >=2 alphanumerics per token).' }] };
    }
    // Phase 1: token dài nhất (selective nhất) để lấy candidates nhanh.
    const main = [...toks].sort((a, b) => b.length - a.length)[0];
    const rest = toks.filter((t) => t !== main);
    const n = Math.min(Math.max(limit ?? 20, 1), 100);
    const matches = await rgMatches(main, files, Math.min(n * 10, 500));
    const byPath = filesByPath(files);
    let hits = toHits(matches, byPath, n * 5);
    // Phase 2: các token còn lại phải khớp cùng dòng HOẶC cùng file context.
    if (rest.length > 0) {
      hits = hits.filter((h) => {
        const hay = `${h.name} ${h.signature} ${h.parentType ?? ''}`.toLowerCase();
        return rest.every((t) => hay.includes(t));
      });
    }
    if (kind) hits = hits.filter((h) => h.kind === kind);
    hits = rankHits(hits, query).slice(0, n);
    return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
  },
);

// --- get_api_detail: locate decl + members + context -------------------------
server.tool(
  'get_api_detail',
  'Get full details of an Apple SDK API: signature, versions, deprecation, doc comment, file+line, plus its member list so you know what to explore next. Reads directly from SDK sources.',
  {
    name: z.string().describe('API name (e.g. "ScrollView", "WKInterfaceController", "TimelineEntry")'),
    framework: z.string().optional().describe('Framework name for disambiguation'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed members (default false)'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ name, framework, include_internal, platform }) => {
    const files = filesFor(framework, platform);
    // Locate: ưu tiên decl line (`struct Name`, `@interface Name`, `func Name`...)
    const declPat = ` ${name}`;
    const matches = await rgMatches(declPat, files, 60);
    const byPath = filesByPath(files);
    const cands = toHits(matches, byPath, 60).filter(
      (h) => h.name === name || h.name.endsWith(`.${name}`),
    );
    if (cands.length === 0) {
      return { content: [{ type: 'text', text: `API "${name}" not found` }] };
    }
    const ranked = rankHits(cands, name);
    const top = ranked[0];
    const ctx = analyzeContext(top.filePath, top.lineNumber);
    const detail = {
      ...top,
      ...(ctx.availLines.length > 0 && !top.availability ? { availability: ctx.availLines.join('; ') } : {}),
      ...(ctx.introducedIn !== null && top.introducedIn === undefined ? { introducedIn: ctx.introducedIn } : {}),
      ...(ctx.deprecatedIn !== null && top.deprecatedIn === undefined ? { deprecatedIn: ctx.deprecatedIn } : {}),
      ...(ctx.renamedTo && !top.renamedTo ? { renamedTo: ctx.renamedTo } : {}),
      ...(ctx.unavailable && !top.unavailable ? { unavailable: true } : {}),
      ...(ctx.docComment && !top.docComment ? { docComment: ctx.docComment } : {}),
    };
    // Members: đọc TRỰC TIẾP block scope trong file của decl (không rg theo tên —
    // rg theo tên lẫn parentType qualified/không-qualified và dính scope khác).
    // Tìm dòng mở scope chứa top.lineNumber: đi ngược tìm `struct/class/enum X {`
    // hoặc `extension ...Name... {` gần nhất, rồi đọc tới `}` cân bằng.
    const members = await readScopeMembers(top, include_internal ?? false);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...detail, members, memberCount: members.length }, null, 2) }],
    };
  },
);

// --- get_type_members ---------------------------------------------------------
server.tool(
  'get_type_members',
  'List all members of a type (methods, properties, cases). Reads directly from SDK sources via parent scope.',
  {
    name: z.string().describe('Type name, short or qualified (e.g. "Text", "WKInterfaceController")'),
    framework: z.string().optional().describe('Filter by framework'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed Apple APIs (default false)'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ name, framework, include_internal, platform }) => {
    const files = filesFor(framework, platform);
    const short = name.includes('.') ? name.split('.').pop()! : name;
    const matches = await rgMatches(short, files, 400);
    const byPath = filesByPath(files);
    let members = toHits(matches, byPath, 400).filter(
      (h) => h.parentType === name || h.parentType === short || h.parentType?.endsWith(`.${short}`),
    );
    members = members
      .filter((h) => (include_internal ? true : !h.name.startsWith('_')))
      .filter((h) => h.kind !== 'extension');
    if (members.length === 0) {
      return { content: [{ type: 'text', text: `No members found for type "${name}"` }] };
    }
    const seen = new Set<string>();
    const deduped = members.filter((h) => {
      const k = `${h.kind}:${h.name}:${h.signature}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { content: [{ type: 'text', text: JSON.stringify(rankHits(deduped, name).slice(0, 200), null, 2) }] };
  },
);

// --- read_source: đọc source gốc quanh API ------------------------------------
server.tool(
  'read_source',
  'Read raw SDK source lines around an API declaration (file + line context). Use after search_apis/get_api_detail to see the original @available lines, comments, and neighboring declarations.',
  {
    file: z.string().describe('Absolute SDK file path (from search_apis/detail filePath)'),
    line: z.number().describe('1-indexed line number'),
    before: z.number().optional().describe('Lines before (default 5, max 30)'),
    after: z.number().optional().describe('Lines after (default 15, max 60)'),
  },
  async ({ file, line, before, after }) => {
    if (!file.startsWith('/Applications/Xcode.app/')) {
      return { content: [{ type: 'text', text: 'Refusing to read outside Xcode.app SDKs.' }] };
    }
    const { readWindow } = await import('./sdk.js');
    const b = Math.min(Math.max(before ?? 5, 0), 30);
    const a = Math.min(Math.max(after ?? 15, 0), 60);
    const win = readWindow(file, line, b, a);
    const numbered = win
      .map((text, i) => `${line - b + i}: ${text}`)
      .join('\n');
    return { content: [{ type: 'text', text: numbered }] };
  },
);

// --- grep_sdk: ripgrep thô -----------------------------------------------------
server.tool(
  'grep_sdk',
  'Raw case-insensitive fixed-string search over Xcode SDK sources (.swiftinterface + .h). Returns file + line + text. Use for broad exploration; prefer search_apis for converted API objects.',
  {
    pattern: z.string().describe('Fixed string to search (e.g. "deprecated: 26.0", "ScrollView")'),
    framework: z.string().optional().describe('Filter by framework'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max matches (default 30, max 200)'),
  },
  async ({ pattern, framework, platform, limit }) => {
    const files = filesFor(framework, platform);
    const n = Math.min(Math.max(limit ?? 30, 1), 200);
    const matches = await rgMatches(pattern, files, n);
    return { content: [{ type: 'text', text: JSON.stringify(matches, null, 2) }] };
  },
);

// --- list_frameworks: từ discovery (không parse) -------------------------------
server.tool(
  'list_frameworks',
  'List all Apple SDK frameworks and the platforms each exists on (from SDK directory scan, no parsing).',
  {
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ platform }) => {
    const fws = listFrameworksFast(platsArg(platform)).sort((a, b) => a.name.localeCompare(b.name));
    return { content: [{ type: 'text', text: JSON.stringify(fws, null, 2) }] };
  },
);

// --- get_new_apis: rg introduced/version ---------------------------------------
server.tool(
  'get_new_apis',
  'Find APIs introduced in a given version by scanning @available/API_AVAILABLE lines directly in SDK sources (e.g. version "26.0" for iOS 26).',
  {
    version: z.string().describe('Version string, e.g. "26.0", "18.0", "11.0"'),
    framework: z.string().optional().describe('Filter by framework'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ version, framework, platform }) => {
    const files = filesFor(framework, platform);
    const v = version.trim();
    const patterns = [`introduced: ${v}`, `iOS ${v}`, `ios(${v}`, `(${v.split('.').join('_')}`, ` ${v},`];
    const seen = new Map<string, { file: string; lineNumber: number; lineText: string }>();
    for (const p of patterns) {
      for (const m of await rgMatches(p, files, 120)) {
        const k = `${m.file}:${m.lineNumber}`;
        if (!seen.has(k)) seen.set(k, m);
      }
    }
    const out = [...seen.values()].slice(0, 200);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

// --- get_deprecated: rg deprecated/renamed --------------------------------------
server.tool(
  'get_deprecated',
  'Find deprecated/unavailable APIs by scanning deprecation markers directly in SDK sources, with renamed replacements.',
  {
    query: z.string().optional().describe('Optional keyword to narrow (e.g. "Text", "foregroundColor"). Omit for a broad scan (capped).'),
    framework: z.string().optional().describe('Filter by framework'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ query, framework, platform }) => {
    const files = filesFor(framework, platform);
    const markers = ['deprecated:', 'API_DEPRECATED', 'NS_DEPRECATED', 'unavailable'];
    const seen = new Map<string, { file: string; lineNumber: number; lineText: string }>();
    for (const mk of markers) {
      const pat = query ? `${mk}` : mk;
      void pat;
      for (const m of await rgMatches(mk, files, 60)) {
        if (query && !m.lineText.toLowerCase().includes(query.toLowerCase())) {
          // lọc thô: cần query trong dòng marker HOẶC dòng decl kề sau
          const { readWindow } = await import('./sdk.js');
          const win = readWindow(m.file, m.lineNumber, 0, 2).join('\n').toLowerCase();
          if (!win.includes(query.toLowerCase())) continue;
        }
        const k = `${m.file}:${m.lineNumber}`;
        if (!seen.has(k)) seen.set(k, m);
        if (seen.size >= 200) break;
      }
      if (seen.size >= 200) break;
    }
    return { content: [{ type: 'text', text: JSON.stringify([...seen.values()].slice(0, 200), null, 2) }] };
  },
);

// --- get_sdk_stats --------------------------------------------------------------
server.tool(
  'get_sdk_stats',
  'SDK corpus statistics: file counts per platform (no index needed).',
  {},
  async () => {
    const all = discoverFiles();
    const byPlatform: Record<string, number> = {};
    const byLang: Record<string, number> = {};
    const fwSet = new Set<string>();
    for (const f of all) {
      byPlatform[f.platform] = (byPlatform[f.platform] ?? 0) + 1;
      byLang[f.lang] = (byLang[f.lang] ?? 0) + 1;
      fwSet.add(`${f.platform}:${f.framework}`);
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          { totalFiles: all.length, byPlatform, byLang, frameworkSlots: fwSet.size },
          null,
          2,
        ),
      }],
    };
  },
);

// --- get_guide: đọc trực tiếp markdown docs (không SQLite) -------------------------
server.tool(
  'get_guide',
  'Get usage guides and code examples for a topic or API from the knowledge docs (ios27-full-knowledge.md). Reads markdown directly, no index.',
  {
    query: z.string().describe('Topic or API name (e.g. "Liquid Glass", "WidgetKit", "TimelineEntry")'),
  },
  async ({ query }) => {
    const { fileURLToPath } = await import('url');
    const repoKnowledge = fileURLToPath(new URL('../../ios27-full-knowledge.md', import.meta.url));
    const mdFiles: string[] = [];
    if (fs.existsSync(repoKnowledge)) mdFiles.push(repoKnowledge);
    const docsEnv = process.env.IOS_DOCS_PATH;
    if (docsEnv && fs.existsSync(docsEnv)) {
      if (fs.statSync(docsEnv).isDirectory()) {
        for (const f of fs.readdirSync(docsEnv).filter((f) => f.endsWith('.md'))) {
          mdFiles.push(`${docsEnv}/${f}`);
        }
      } else mdFiles.push(docsEnv);
    }
    const q = query.toLowerCase();
    const out: { topic: string; snippet: string }[] = [];
    for (const mf of mdFiles) {
      const content = fs.readFileSync(mf, 'utf-8');
      for (const sec of content.split(/^(?=#{2,3}\s+)/m)) {
        const m = sec.match(/^#{2,3}\s+(.+?)\s*\n([\s\S]*)$/);
        if (!m) continue;
        const topic = `${mf.split('/').pop()}: ${m[1].trim()}`;
        const body = m[2].trim();
        if (!body) continue;
        if (topic.toLowerCase().includes(q) || body.toLowerCase().includes(q)) {
          out.push({ topic: topic.slice(0, 300), snippet: body.slice(0, 3000) });
          if (out.length >= 3) break;
        }
      }
      if (out.length >= 3) break;
    }
    if (out.length === 0) {
      return { content: [{ type: 'text', text: `No guides found for "${query}"` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ios-sdk-mcp running on stdio (direct SDK mode, no index)');
}

main().catch(console.error);
