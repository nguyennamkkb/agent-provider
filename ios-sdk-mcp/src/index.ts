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
import {
  ensureIface,
  ensureIfacesFor,
  withCachedIfaces,
  isCachePath,
  cacheRoot,
} from './iface.js';
import {
  packList,
  packMembers,
  trimAvailability,
  declFromMarker,
  isRealDeprecation,
} from './pack.js';
import type { SdkPlatform } from './types.js';

const server = new McpServer({
  name: 'ios-sdk-mcp',
  version: '0.5.0',
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
  // Framework nào đã có generated interface trong cache thì đọc bản ĐÓ thay cho
  // .swiftinterface: cùng decl nhưng kèm doc comment. Chỉ dùng cache sẵn có,
  // không sinh mới ở đây (search rộng phải nhanh).
  return withCachedIfaces(files);
}

/** Như filesFor nhưng SINH generated interface cho framework được chỉ định.
 * Dùng cho các tool trả tài liệu (detail/members) — chịu ~1-3s lần đầu/module. */
async function filesForDocs(framework?: string, platform?: string): Promise<SdkFile[]> {
  const base = discoverFiles(platsArg(platform));
  if (framework) {
    const fw = framework.toLowerCase();
    const mine = base.filter((f) => f.framework.toLowerCase() === fw);
    const plats = new Set(mine.filter((f) => f.lang === 'swift').map((f) => f.platform));
    const real = mine.find((f) => f.lang === 'swift')?.framework ?? framework;
    await Promise.all([...plats].map((p) => ensureIface(real, p)));
    return withCachedIfaces(mine);
  }
  return withCachedIfaces(base);
}

/**
 * Rút doc xuống ABSTRACT (đoạn đầu, tới dòng trống đầu tiên) cho các tool trả
 * DANH SÁCH. Doc Apple dài 2-6KB/symbol: 20 hit × full doc là ~50KB JSON, ngập
 * context của agent mà không giúp chọn API. get_api_detail vẫn trả full.
 */
function abstractOf(doc: string | undefined, max = 240): string | undefined {
  if (!doc) return undefined;
  const first = doc.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function withAbstract<T extends { docComment?: string }>(h: T): T {
  const a = abstractOf(h.docComment);
  return a ? { ...h, docComment: a } : h;
}

/** Regex bắt DÒNG KHAI BÁO của 1 tên (Swift + ObjC), dùng cho locate.
 * `rgMatches(" Name")` cũ chỉ lấy 60 match thô: với tên phổ biến (`Text`) 60
 * match đầu toàn comment/param nên trượt hết dòng decl -> "not found". */
function declRegex(name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kw = 'struct|class|enum|protocol|actor|typealias|macro|func|var|let|extension';
  return `(\\b(${kw})|@(interface|protocol))\\s+${esc}\\b`;
}

/** Locate decl của `name`: decl-anchored trước, fallback substring cũ. */
async function locateDecl(
  name: string,
  files: SdkFile[],
  byPath: Map<string, SdkFile>,
): Promise<ConvertedHit[]> {
  const { rgRegex } = await import('./sdk.js');
  const short = name.includes('.') ? name.split('.').pop()! : name;
  const keep = (h: ConvertedHit) =>
    h.name === name || h.name === short || h.name.endsWith(`.${short}`);
  let cands = toHits(await rgRegex(declRegex(short), files, 200, true), byPath, 200).filter(keep);
  if (cands.length === 0) {
    cands = toHits(await rgMatches(` ${short}`, files, 60), byPath, 60).filter(keep);
  }
  return cands;
}

/**
 * Nâng 1 hit lên bản CÓ DOC: sinh generated interface của framework rồi tìm lại
 * đúng decl trong đó. Trả null nếu module không sinh được (ObjC-only...) hoặc
 * không tìm thấy decl tương ứng — caller giữ hit cũ.
 */
async function withDocs(top: ConvertedHit): Promise<ConvertedHit | null> {
  if (top.lang !== 'swift') return null;
  if (isCachePath(top.filePath)) return null; // đã là generated interface
  const p = await ensureIface(top.framework, top.platform);
  if (!p) return null;
  const { fileLines } = await import('./sdk.js');
  let lines: string[];
  try {
    lines = fileLines(p);
  } catch {
    return null;
  }
  const file: SdkFile = {
    path: p, framework: top.framework, platform: top.platform, lang: 'swift',
  };
  const short = top.name.split('.').pop()!;
  let fallback: ConvertedHit | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    // Rẻ trước, convert sau: file 140k dòng, convertLine mỗi dòng quá đắt.
    if (!raw.includes(short)) continue;
    const hit = convertLine(file, i + 1, raw);
    if (!hit) continue;
    if (hit.name !== top.name && hit.name !== short) continue;
    if (hit.kind === top.kind) return hit;
    if (!fallback) fallback = hit;
  }
  return fallback;
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
  const seen = new Set<string>(); // dedup cross-platform: cùng API 5 SDK -> 1 hit
  for (const m of matches) {
    if (out.length >= limit) break;
    const file = filesByPath.get(m.file);
    if (!file) continue;
    const hit =
      file.lang === 'objc'
        ? convertLine(file, m.lineNumber, m.lineText, objcMapFor(file))
        : convertLine(file, m.lineNumber, m.lineText);
    if (!hit) continue;
    // Key dedup: name+kind+framework+signature (khác parent/signature = API khác).
    // Platform giữ lại ở hit đầu (phase sau gộp platforms nếu cần).
    const k = `${hit.kind}:${hit.name}@${hit.framework}:${hit.signature}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(hit);
  }
  return out;
}

function filesByPath(files: SdkFile[]): Map<string, SdkFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/** Đọc members trong block scope chứa 1 decl (scope-aware, không đoán theo tên).
 * Export để get_type_members dùng chung (không lặp logic). */
export async function readScopeMembers(
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
  // d = số scope đang mở (decl `struct X {` -> d=1). Convert dòng ở d==1 TRƯỚC
  // khi cộng brace của chính nó — nếu không, dòng `public var axes {` vừa khai
  // báo member vừa đẩy d lên 2 sẽ bị bỏ qua nhầm. `get`/`set` ở d==2 thì skip.
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
    // Chỉ convert khi đang ở scope trực tiếp (d==1). Ngoài scope lồng
    // (getter/setter/closure, d>=2): cập nhật depth, bỏ qua.
    // Đóng scope type (d<=0): break. Convert TRƯỚC khi cộng brace của dòng
    // hiện tại — nếu không, dòng `public var axes {` vừa khai member vừa đẩy
    // d lên 2 sẽ bị skip nhầm.
    const atDirect = isType ? d === 1 : true;
    if (!t) {
      if (isType) d += (noStr.match(/\{/g) || []).length - (noStr.match(/\}/g) || []).length;
      continue;
    }
    if (/^(get|set|willSet|didSet)\b/.test(t)) {
      if (isType) d += (noStr.match(/\{/g) || []).length - (noStr.match(/\}/g) || []).length;
      continue;
    }
    const hit = atDirect ? convertLine(file, i + 1, raw, map) : null;
    if (isType) {
      d += (noStr.match(/\{/g) || []).length - (noStr.match(/\}/g) || []).length;
      if (d <= 0) break;
    }
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
    } else if (isType && top.lang === 'swift' && ['func', 'var', 'init', 'operator', 'typealias', 'associatedtype', 'macro', 'case'].includes(hit.kind)) {
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

/**
 * Members khai báo trong `extension <Type>` khắp file (Swift).
 * readScopeMembers chỉ đọc block của chính decl; với type Swift thì đó mới là
 * phần nhỏ — modifiers/tiện ích của Apple nằm ở extension.
 */
export async function readExtensionMembers(
  type: ConvertedHit,
  includeInternal: boolean,
  limit = 200,
): Promise<ConvertedHit[]> {
  const { fileLines } = await import('./sdk.js');
  let lines: string[];
  try {
    lines = fileLines(type.filePath);
  } catch {
    return [];
  }
  const short = type.name.split('.').pop()!;
  const file: SdkFile = {
    path: type.filePath, framework: type.framework, platform: type.platform, lang: type.lang,
  };
  const out: ConvertedHit[] = [];
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const t = (lines[i] ?? '').trim();
    const m = t.match(/^extension\s+([^\s:{]+)/);
    if (!m) continue;
    const en = m[1].replace(/<.*>$/, '');
    if (en !== type.name && en !== short && !en.endsWith(`.${short}`)) continue;
    let d = 0;
    for (let j = i; j < lines.length && out.length < limit; j++) {
      const raw = lines[j] ?? '';
      const noStr = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const opens = (noStr.match(/\{/g) || []).length;
      const closes = (noStr.match(/\}/g) || []).length;
      // Convert TRƯỚC khi cộng brace của dòng hiện tại (dòng `public func x() {`
      // vừa khai báo member vừa mở scope con).
      if (j > i && d === 1 && !/^(get|set|willSet|didSet)\b/.test(raw.trim())) {
        const h = convertLine(file, j + 1, raw);
        if (h && h.kind !== 'extension' && (includeInternal || !h.name.startsWith('_'))) {
          out.push({ ...h, parentType: type.name });
        }
      }
      d += opens - closes;
      if (j > i && d <= 0) {
        i = j; // nhảy qua block đã đọc
        break;
      }
    }
  }
  return out;
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
    verbose: z.boolean().optional().describe('Return full fields without hoisting/compaction (default false)'),
  },
  async ({ query, framework, kind, platform, limit, verbose }) => {
    const files = filesFor(framework, platform);
    const toks = tokenize(query);
    if (toks.length === 0) {
      return { content: [{ type: 'text', text: 'Empty query (need >=2 alphanumerics per token).' }] };
    }
    // Phase 1 (3-pass, dừng sớm khi đủ decl tốt — pull() đếm THẬT bằng
    // convertLine, không heuristic). Rẻ vì dừng ở pass A cho query tốt.
    // A. Decl-anchored case-sensitive (`struct Text`, `@interface Foo`):
    //    trúng dòng khai báo, không dính comment/param. ~300ms toàn corpus.
    // B. Word-boundary (`\bText\b`): thêm `TextField` dùng từ Text...
    // C. Substring + NOCASE: vét khi thiếu (lowercase query, framework lạ).
    const n = Math.min(Math.max(limit ?? 20, 1), 100);
    const rawToks = query.split(/[^A-Za-z0-9_]+/).filter((t) => t.length >= 2);
    const mainRaw = [...rawToks].sort((a, b) => b.length - a.length)[0] ?? toks[0];
    const rest = toks.filter((t) => t !== mainRaw.toLowerCase());
    const { rgMatchesCase, rgRegex } = await import('./sdk.js');
    const { convertLine: convertEarly } = await import('./convert.js');
    const byPathEarly = filesByPath(files);
    // wantConvertOK: dừng pass khi convertOK (KHÔNG underscore) đạt ngưỡng.
    // BUG ĐÃ GẶP: floor 12 + decl-anchored pass A cho `Text` ra 27 matches
    // nhưng chỉ 15 convertOK (12 còn lại là `struct Text` ở platform khác bị
    // dedup? không — countConvertOK đếm TRƯỚC dedup nên 27 matches -> 27 OK?)
    // Thực tế debug: pass A 27 matches, conv=27, exact=27 -> stop đúng.
    // Nếu MCP vẫn ra rác => pull chain đã chạy thêm pass B/C/D (xem log).
    // TẠM: nới -m pass A lên 200, floor theo n để ít pass hơn.
    const wantConvertOK = Math.max(n * 5, 20);
    const seen = new Set<string>();
    let matches: { file: string; lineNumber: number; lineText: string }[] = [];
    // Đếm THẬT bằng convertLine (rẻ ~5ms/300 matches): dừng khi đủ decl tốt.
    // Đếm regex heuristic trước đây sai (comment `Text combine` cũng tính).
    const countConvertOK = (
      ms: { file: string; lineNumber: number; lineText: string }[],
    ): number => {
      let c = 0;
      for (const m of ms) {
        const file = byPathEarly.get(m.file);
        if (!file) continue;
        const h = file.lang === 'objc'
          ? convertEarly(file, m.lineNumber, m.lineText, objcMapFor(file))
          : convertEarly(file, m.lineNumber, m.lineText);
        if (h && !h.name.startsWith('_')) c++;
      }
      return c;
    };
    const pull = async (
      fn: () => Promise<{ file: string; lineNumber: number; lineText: string }[]>,
    ): Promise<boolean> => {
      // true = đã đủ decl tốt, dừng.
      if (countConvertOK(matches) >= wantConvertOK) return true;
      for (const m of await fn()) {
        const k = `${m.file}:${m.lineNumber}`;
        if (!seen.has(k)) {
          seen.add(k);
          matches.push(m);
        }
      }
      return countConvertOK(matches) >= wantConvertOK;
    };
    // Pass A: decl-anchored regex — trúng thẳng dòng khai báo (`struct Text`,
    // `@interface Foo`), không dính comment (`Text combine...`) hay param
    // (`valueDescription: Text`). Rẻ (~10-30ms).
    const esc = mainRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declPat = `(struct|class|enum|protocol|actor|func|var|let|init|typealias|associatedtype|macro|@interface|@protocol|@property)\s+${esc}\\b`;
    const debugLog = (...a: unknown[]) => {
      if (process.env.IOS_DEBUG) console.error('[search]', ...a);
    };
    const pullLogged = async (
      label: string,
      fn: () => Promise<{ file: string; lineNumber: number; lineText: string }[]>,
    ): Promise<boolean> => {
      const r = await pull(fn);
      debugLog(`pass ${label}: stop=${r} matches=${matches.length}`);
      return r;
    };
    if (!(await pullLogged('A-decl', () => rgRegex(declPat, files, 200, true)))) {
      if (!(await pullLogged('B-word', () => rgRegex(`\\b${esc}\\b`, files, 200, true)))) {
        if (!(await pullLogged('C-sub', () => rgMatchesCase(mainRaw, files, 400, true)))) {
          await pullLogged('D-nocase', () => rgMatchesCase(mainRaw.toLowerCase(), files, 400, false));
        }
      }
    }
    const main = mainRaw;
    const byPath = filesByPath(files);
    // Rank trên toàn bộ matches rồi mới slice.
    let hits = toHits(matches, byPath, matches.length);
    // Phase 2 (multi-word recall): token còn lại phải khớp name/signature.
    // Với query 1 từ, rest rỗng NHƯNG vẫn phải loại row rác: row mà query chỉ
    // xuất hiện trong params/body signature (VD `value: Text` param) mà name
    // không chứa query -> loại. Đây là chỗ `value@Charts` lọt top `Text`.
    {
      const q = main.toLowerCase();
      hits = hits.filter((h) => {
        const hay = `${h.name} ${h.signature} ${h.parentType ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
        if (rest.length > 0 && !rest.every((t) => hay.includes(t))) return false;
        return true;
      });
    }
    if (kind) hits = hits.filter((h) => h.kind === kind);
    hits = rankHits(hits, query).slice(0, n).map(withAbstract);
    const packed = packList(hits, verbose ?? false);
    return { content: [{ type: 'text', text: JSON.stringify(packed, null, 2) }] };
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
    verbose: z.boolean().optional().describe('Return full fields without hoisting/compaction (default false)'),
  },
  async ({ name, framework, include_internal, platform, verbose }) => {
    const files = await filesForDocs(framework, platform);
    const byPath = filesByPath(files);
    const cands = await locateDecl(name, files, byPath);
    if (cands.length === 0) {
      return { content: [{ type: 'text', text: `API "${name}" not found` }] };
    }
    const ranked = rankHits(cands, name);
    // Không truyền framework -> files vẫn là .swiftinterface (không doc).
    // Biết framework của top rồi thì sinh generated interface và dùng bản đó:
    // doc comment + members đều lấy từ nguồn có tài liệu.
    const top = (await withDocs(ranked[0])) ?? ranked[0];
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
    // Member kế thừa framework/platform/lang/file/availability của cha -> bỏ
    // (xem packMembers). `memberCount` bỏ luôn: đã là members.length.
    const body = verbose
      ? { ...detail, members, memberCount: members.length }
      : { ...trimAvailability(detail), members: packMembers(detail, members, false) };
    return {
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
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
    verbose: z.boolean().optional().describe('Return full fields without hoisting/compaction (default false)'),
  },
  async ({ name, framework, include_internal, platform, verbose }) => {
    const files = await filesForDocs(framework, platform);
    const short = name.includes('.') ? name.split('.').pop()! : name;
    // Tìm type decl trước để lấy đúng file chứa nó (tránh rg 400 dòng rác từ
    // các file khác rồi lọc parentType — convertLine không gắn parent cho
    // member (chỉ parser full-file mới biết scope), nên lọc parentType rỗng).
    const byPath = filesByPath(files);
    const decls = await locateDecl(name, files, byPath);
    const typeDeclRaw = rankHits(decls, short).find((h) =>
      ['struct', 'class', 'enum', 'protocol'].includes(h.kind),
    ) ?? rankHits(decls, short)[0];
    // Đọc members từ generated interface -> mỗi member kèm doc comment của nó.
    const typeDecl = typeDeclRaw ? ((await withDocs(typeDeclRaw)) ?? typeDeclRaw) : typeDeclRaw;
    let members: ConvertedHit[] = [];
    if (typeDecl) {
      members = await readScopeMembers(typeDecl, include_internal ?? false);
    }
    if (members.length === 0) {
      // Fallback cũ: rg theo tên + lọc parentType (cho ObjC @interface scope
      // mà convertLine đã gắn parent qua objcLineMap).
      const matches = await rgMatches(short, files, 400);
      members = toHits(matches, byPath, 400).filter(
        (h) => h.parentType === name || h.parentType === short || h.parentType?.endsWith(`.${short}`),
      );
    }
    // Type Swift: phần lớn API nằm trong `extension X { ... }` rải khắp file
    // (Text có ~10 member trong body nhưng hàng trăm modifier ở extension).
    // Đọc scope của decl thôi là bỏ sót gần hết -> gom thêm các extension cùng tên.
    if (typeDecl && typeDecl.lang === 'swift') {
      members = members.concat(await readExtensionMembers(typeDecl, include_internal ?? false));
    }
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
    const out = rankHits(deduped, name).slice(0, 200).map(withAbstract);
    if (verbose) {
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }
    // Header mang field chung của type; member chỉ giữ phần riêng.
    const head = typeDecl ?? out[0];
    const body = {
      type: head.name,
      framework: head.framework,
      platform: head.platform,
      lang: head.lang,
      filePath: head.filePath,
      count: out.length,
      members: packMembers(head, out, false),
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
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
    // Cho phép cả cache generated-interface (filePath của hit có doc trỏ vào đó).
    if (!file.startsWith('/Applications/Xcode.app/') && !isCachePath(file)) {
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

// --- prewarm_docs: sinh trước generated interface ------------------------------
server.tool(
  'prewarm_docs',
  'Generate and cache Swift documentation sources (Xcode "generated interface") for frameworks, so later searches return doc comments without delay. Runs ~1-3s per framework; results are cached on disk per Xcode build.',
  {
    frameworks: z.array(z.string()).optional().describe('Frameworks to prewarm (e.g. ["SwiftUI","WidgetKit"]). Omit to prewarm every Swift framework — slow, minutes.'),
    platform: z.string().optional().describe(platformDesc),
  },
  async ({ frameworks, platform }) => {
    let files = discoverFiles(platsArg(platform)).filter((f) => f.lang === 'swift');
    if (frameworks && frameworks.length > 0) {
      const want = new Set(frameworks.map((f) => f.toLowerCase()));
      files = files.filter((f) => want.has(f.framework.toLowerCase()));
    }
    if (files.length === 0) {
      return { content: [{ type: 'text', text: 'No Swift frameworks matched.' }] };
    }
    const t0 = Date.now();
    const res = await ensureIfacesFor(files);
    const ok = res.filter((r) => r.ok);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          cacheDir: cacheRoot(),
          requested: res.length,
          generated: ok.length,
          failed: res.filter((r) => !r.ok).map((r) => `${r.platform}/${r.framework}`).slice(0, 50),
          elapsedMs: Date.now() - t0,
        }, null, 2),
      }],
    };
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
    // Path lặp ở mọi match nhưng thường chỉ 1-3 file -> bảng id.
    const paths = [...new Set(matches.map((m) => m.file))];
    const idOf = new Map(paths.map((p, i) => [p, i + 1]));
    const body = paths.length === 1
      ? { file: paths[0], count: matches.length, matches: matches.map((m) => ({ line: m.lineNumber, text: m.lineText })) }
      : {
        files: Object.fromEntries(paths.map((p, i) => [i + 1, p])),
        count: matches.length,
        matches: matches.map((m) => ({ file: idOf.get(m.file), line: m.lineNumber, text: m.lineText })),
      };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  },
);

// --- list_frameworks: từ discovery (không parse) -------------------------------
server.tool(
  'list_frameworks',
  'List all Apple SDK frameworks and the platforms each exists on (from SDK directory scan, no parsing).',
  {
    platform: z.string().optional().describe(platformDesc),
    include_private: z.boolean().optional().describe('Include Apple-internal _-prefixed frameworks (default false)'),
  },
  async ({ platform, include_private }) => {
    let fws = listFrameworksFast(platsArg(platform)).sort((a, b) => a.name.localeCompare(b.name));
    // `_AppIntents_SwiftUI` & co: internal của Apple, agent không dùng được.
    if (!include_private) fws = fws.filter((f) => !f.name.startsWith('_'));
    return { content: [{ type: 'text', text: JSON.stringify({ count: fws.length, frameworks: fws }, null, 2) }] };
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
    limit: z.number().optional().describe('Max APIs (default 40, max 200)'),
    verbose: z.boolean().optional().describe('Return full fields without hoisting/compaction (default false)'),
  },
  async ({ version, framework, platform, limit, verbose }) => {
    const files = filesFor(framework, platform);
    const byPath = filesByPath(files);
    const v = version.trim();
    const n = Math.min(Math.max(limit ?? 40, 1), 200);
    const patterns = [`introduced: ${v}`, `iOS ${v}`, `ios(${v}`, `(${v.split('.').join('_')}`, ` ${v},`];
    const seen = new Map<string, { file: string; lineNumber: number; lineText: string }>();
    for (const p of patterns) {
      for (const m of await rgMatches(p, files, 120)) {
        const k = `${m.file}:${m.lineNumber}`;
        if (!seen.has(k)) seen.set(k, m);
      }
    }
    // Dòng marker -> API thật (tên + kind + signature + version).
    const { fileLines } = await import('./sdk.js');
    const hits: ConvertedHit[] = [];
    const dedup = new Set<string>();
    for (const m of seen.values()) {
      const file = byPath.get(m.file);
      if (!file) continue;
      const hit = declFromMarker(
        file, m.lineNumber, fileLines(m.file),
        file.lang === 'objc' ? objcMapFor(file) : undefined,
      );
      if (!hit) continue;
      const k = `${hit.kind}:${hit.name}@${hit.framework}:${hit.signature}`;
      if (dedup.has(k)) continue;
      dedup.add(k);
      hits.push(withAbstract(hit));
      if (hits.length >= n) break;
    }
    const packed = packList(rankHits(hits, version), verbose ?? false);
    return { content: [{ type: 'text', text: JSON.stringify(packed, null, 2) }] };
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
    limit: z.number().optional().describe('Max APIs (default 40, max 200)'),
    verbose: z.boolean().optional().describe('Return full fields without hoisting/compaction (default false)'),
  },
  async ({ query, framework, platform, limit, verbose }) => {
    const files = filesFor(framework, platform);
    const byPath = filesByPath(files);
    const n = Math.min(Math.max(limit ?? 40, 1), 200);
    const markers = ['deprecated:', 'API_DEPRECATED', 'NS_DEPRECATED', 'unavailable'];
    const seen = new Map<string, { file: string; lineNumber: number; lineText: string }>();
    for (const mk of markers) {
      for (const m of await rgMatches(mk, files, 60)) {
        // Sentinel `deprecated: 100000.0` = CHƯA deprecated -> loại.
        if (!isRealDeprecation(m.lineText)) continue;
        if (query && !m.lineText.toLowerCase().includes(query.toLowerCase())) {
          // lọc thô: cần query trong dòng marker HOẶC dòng decl kề sau
          const { readWindow } = await import('./sdk.js');
          const win = readWindow(m.file, m.lineNumber, 0, 2).join('\n').toLowerCase();
          if (!win.includes(query.toLowerCase())) continue;
        }
        const k = `${m.file}:${m.lineNumber}`;
        if (!seen.has(k)) seen.set(k, m);
        if (seen.size >= 300) break;
      }
      if (seen.size >= 300) break;
    }
    const { fileLines } = await import('./sdk.js');
    const hits: ConvertedHit[] = [];
    const dedup = new Set<string>();
    for (const m of seen.values()) {
      const file = byPath.get(m.file);
      if (!file) continue;
      const hit = declFromMarker(
        file, m.lineNumber, fileLines(m.file),
        file.lang === 'objc' ? objcMapFor(file) : undefined,
      );
      if (!hit) continue;
      const k = `${hit.kind}:${hit.name}@${hit.framework}:${hit.signature}`;
      if (dedup.has(k)) continue;
      dedup.add(k);
      hits.push(withAbstract(hit));
      if (hits.length >= n) break;
    }
    const packed = packList(query ? rankHits(hits, query) : hits, verbose ?? false);
    return { content: [{ type: 'text', text: JSON.stringify(packed, null, 2) }] };
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
