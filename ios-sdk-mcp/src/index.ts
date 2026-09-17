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
import { convertLine, matchLabel, objcLineMap, preferIos, rankHits, type ConvertedHit } from './convert.js';

/** Thứ tự kind khi browse alpha (struct/class/enum/protocol trước members). */
const KIND_ORDER: Record<string, number> = {
  struct: 0, class: 1, enum: 2, protocol: 3, actor: 4, macro: 5, typealias: 6,
};
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
  stripLoc,
  trimAvailability,
  declFromMarker,
  isRealDeprecation,
} from './pack.js';
import type { SdkPlatform } from './types.js';

const server = new McpServer({
  name: 'ios-sdk-mcp',
  version: '0.6.0',
});

const platformDesc =
  'Platform filter: ios (default, iPhone/iPad), watchos, macos, tvos, xros (visionOS). Omit = ios only; pass "all" to search every platform.';

function platsArg(platform?: string): SdkPlatform[] | undefined {
  // Default = ios only: Agent code cho iPhone, line-number watchos sẽ làm
  // read_source follow-up sai file (lỗi đã đo: detail ScrollView ra watchos).
  if (!platform || platform.toLowerCase() === 'ios') return ['ios'];
  if (platform.toLowerCase() === 'all') return undefined;
  const p = platform.toLowerCase() as SdkPlatform;
  if (!['watchos', 'macos', 'tvos', 'xros'].includes(p)) {
    throw new Error(`Unknown platform "${platform}". Use ios|watchos|macos|tvos|xros|all.`);
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

/** Convert matches -> hits, gom members khi là type detail.
 * Dedup cross-platform: cùng API ở 5 SDK gộp về 1 hit (platform = hit đầu
 * theo walk order ios-first + platforms[] liệt kê đủ nơi có mặt). */
function toHits(
  matches: { file: string; lineNumber: number; lineText: string }[],
  filesByPath: Map<string, SdkFile>,
  limit: number,
): ConvertedHit[] {
  const out: ConvertedHit[] = [];
  const seen = new Map<string, ConvertedHit>();
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
    const k = `${hit.kind}:${hit.name}@${hit.framework}:${hit.signature}`;
    const prev = seen.get(k);
    if (prev) {
      // Ghi nhận platform thêm (không đổi platform chính = hit đầu).
      if (prev.platform !== hit.platform) {
        const ps = prev.platforms ?? (prev.platforms = [prev.platform]);
        if (!ps.includes(hit.platform)) ps.push(hit.platform);
      }
      continue;
    }
    seen.set(k, hit);
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

// --- search_apis: tìm NGANG theo từ khóa (khi CHƯA biết cha) -------------------
// Đã biết framework/type thì đi DỌC: list_frameworks -> list_types ->
// get_type_members -> get_api_detail (rẻ, deterministic). Chỉ search ngang
// khi chỉ có từ khóa (vd "glassEffect" -> owner type nào?).
server.tool(
  'search_apis',
  'HORIZONTAL keyword search (use when you only have a keyword, not a type). WHEN: discover which type/framework owns a keyword. Exact-name hits rank first with match:"exact"; fuzzy matches carry match:"prefix"|"contains"|"fuzzy". NEXT: get_api_detail(name) for the exact hit, or list_types to browse the framework. If you already know the type, use get_type_members instead — cheaper and deterministic.',
  {
    query: z.string().describe('Search keyword (e.g. "ScrollView", "scroll view", "glassEffect")'),
    mode: z.enum(['auto', 'exact', 'fuzzy']).optional().describe('auto (default): exact decl-anchored block first, then fuzzy. exact: only `struct Name`/`@interface Name` lines. fuzzy: token/word-boundary matches.'),
    framework: z.string().optional().describe('Filter by framework name (e.g. "SwiftUI", "WatchKit")'),
    kind: z.string().optional().describe('Filter by kind: class, struct, enum, protocol, func, var, macro, typealias, case, init, operator'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max results (default 20, max 100)'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ query, mode, framework, kind, platform, limit }) => {
    const files = filesFor(framework, platform);
    const toks = tokenize(query);
    if (toks.length === 0) {
      return { content: [{ type: 'text', text: `Empty query "${query}". Need >=2 alphanumerics per token. NEXT: retry with a real API keyword (e.g. "ScrollView").` }] };
    }
    // 2 tier tách bạch: EXACT (decl-anchored, case-sensitive, rẻ ~10-30ms,
    // trúng `struct Text` không dính comment/param) và FUZZY (word-boundary
    // + substring NOCASE cho khám phá). Không gộp budget: pass A có --sort
    // path (sdk.ts) nên deterministic; dừng sớm khi đủ chứ không vét.
    const n = Math.min(Math.max(limit ?? 20, 1), 100);
    const m = (mode ?? 'auto') as 'auto' | 'exact' | 'fuzzy';
    const rawToks = query.split(/[^A-Za-z0-9_]+/).filter((t) => t.length >= 2);
    const mainRaw = [...rawToks].sort((a, b) => b.length - a.length)[0] ?? toks[0];
    const rest = toks.filter((t) => t !== mainRaw.toLowerCase());
    const { rgMatchesCase, rgRegex } = await import('./sdk.js');
    const byPath = filesByPath(files);
    const esc = mainRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declPat = `(struct|class|enum|protocol|actor|func|var|let|init|typealias|associatedtype|macro|@interface|@protocol|@property)\\s+${esc}\\b`;
    const lub = (arr: { file: string; lineNumber: number }[]) => `${arr.length}`;
    void lub;
    const seen = new Set<string>();
    const exactMatches: { file: string; lineNumber: number; lineText: string }[] = [];
    const fuzzyMatches: { file: string; lineNumber: number; lineText: string }[] = [];
    const take = (
      dst: { file: string; lineNumber: number; lineText: string }[],
      src: { file: string; lineNumber: number; lineText: string }[],
      cap: number,
    ) => {
      for (const x of src) {
        if (dst.length >= cap) break;
        const k = `${x.file}:${x.lineNumber}`;
        if (!seen.has(k)) {
          seen.add(k);
          dst.push(x);
        }
      }
    };
    // EXACT tier: budget riêng, không chia với fuzzy.
    if (m !== 'fuzzy') {
      take(exactMatches, await rgRegex(declPat, files, 200, true), 200);
    }
    // FUZZY tier: chỉ chạy khi exact thiếu (auto) hoặc được yêu cầu.
    const needFuzzy = m === 'fuzzy' || exactMatches.length < Math.min(n, 20);
    if (needFuzzy) {
      take(fuzzyMatches, await rgRegex(`\\b${esc}\\b`, files, 200, true), 200);
      if (fuzzyMatches.length < n) {
        take(fuzzyMatches, await rgMatchesCase(mainRaw, files, 200, true), 200);
      }
      if (fuzzyMatches.length < n) {
        take(fuzzyMatches, await rgMatchesCase(mainRaw.toLowerCase(), files, 200, false), 200);
      }
    }
    // Convert + lọc token (loại row rác: query chỉ trong params/body
    // signature mà name không chứa — vd `value: Text` param lọt top `Text`).
    const q = mainRaw.toLowerCase();
    const keep = (h: ConvertedHit) => {
      const hay = `${h.name} ${h.signature} ${h.parentType ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
      if (rest.length > 0 && !rest.every((t) => hay.includes(t))) return false;
      return true;
    };
    let exact = toHits(exactMatches, byPath, exactMatches.length).filter(keep);
    let fuzzy = toHits(fuzzyMatches, byPath, fuzzyMatches.length).filter(keep);
    // Dedup chéo tier: exact giữ, fuzzy trùng thì bỏ.
    const exactKeys = new Set(exact.map((h) => `${h.kind}:${h.name}@${h.framework}:${h.signature}`));
    fuzzy = fuzzy.filter((h) => !exactKeys.has(`${h.kind}:${h.name}@${h.framework}:${h.signature}`));
    if (kind) {
      exact = exact.filter((h) => h.kind === kind);
      fuzzy = fuzzy.filter((h) => h.kind === kind);
    }
    if (m === 'exact') fuzzy = [];
    if (m === 'fuzzy') exact = [];
    // ios-first (toHits giữ platform hit đầu theo walk order) + gắn nhãn match.
    // Exact block lúc nào cũng lên trước fuzzy — Agent thấy canonical ngay.
    const rankedExact = preferIos(rankHits(exact, query));
    const rankedFuzzy = preferIos(rankHits(fuzzy, query));
    const out: ConvertedHit[] = [];
    for (const h of rankedExact) {
      if (out.length >= n) break;
      out.push({ ...h, match: matchLabel(h.name, mainRaw) === 'fuzzy' ? 'exact' : matchLabel(h.name, mainRaw) });
    }
    for (const h of rankedFuzzy) {
      if (out.length >= n) break;
      out.push({ ...h, match: matchLabel(h.name, mainRaw) });
    }
    const packed = packList(out.map(withAbstract));
    return { content: [{ type: 'text', text: JSON.stringify(packed) }] };
  },
);

// --- get_api_detail: đọc DỌC 1 API (full doc + version + members names) -------
server.tool(
  'get_api_detail',
  'VERTICAL read of ONE API: full Apple doc + versions + member NAME list. WHEN: you have an exact name (from search_apis match:"exact" or member list). Members return names-only (no doc) — call get_api_detail again on a member for its doc. NEXT: get_type_members(name, detail:"abstract") to choose among members, read_source for raw context, get_guide for usage examples.',
  {
    name: z.string().describe('Exact API name (e.g. "ScrollView", "Text", "WKInterfaceController")'),
    framework: z.string().optional().describe('Framework name for disambiguation (e.g. "SwiftUI" vs Vision "Text")'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed members (default false)'),
    platform: z.string().optional().describe(platformDesc),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ name, framework, include_internal, platform }) => {
    const files = await filesForDocs(framework, platform);
    const byPath = filesByPath(files);
    const cands = preferIos(await locateDecl(name, files, byPath));
    if (cands.length === 0) {
      return { content: [{ type: 'text', text: `API "${name}" not found. NEXT: search_apis {"query":"${name}","mode":"fuzzy"} to find the owner type, or list_types to browse.` }] };
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
    // Chỉ names (không doc): Text 131 members × full doc = ngập context.
    const members = await readScopeMembers(top, include_internal ?? false);
    const body = { ...stripLoc(trimAvailability(detail)), members: packMembers(detail, members, 'names') };
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  },
);

// --- list_types: chuỗi DỌC framework -> types (lấp lỗ hổng discovery) ---------
server.tool(
  'list_types',
  'VERTICAL browse: list types declared in a framework (no keyword needed). WHEN: you know the framework but not the type name (e.g. "what views does SwiftUI have?"). Reads decl lines in framework files only — cheap, deterministic. NEXT: get_type_members(type) or get_api_detail(type).',
  {
    framework: z.string().describe('Framework name (e.g. "SwiftUI", "WidgetKit", "UIKit")'),
    kind: z.string().optional().describe('Filter by kind: class, struct, enum, protocol (default: all four)'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max types (default 100, max 500)'),
    offset: z.number().optional().describe('Skip first N (default 0, for paging)'),
    detail: z.enum(['names', 'abstract']).optional().describe('names (default): kind+name only. abstract: +1-line doc + version.'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ framework, kind, platform, limit, offset, detail }) => {
    const { rgRegex: rgRe } = await import('./sdk.js');
    const files = filesFor(framework, platform);
    if (files.length === 0) {
      return { content: [{ type: 'text', text: `Framework "${framework}" not found. NEXT: list_frameworks to see exact names.` }] };
    }
    const n = Math.min(Math.max(limit ?? 100, 1), 500);
    const off = Math.max(offset ?? 0, 0);
    const d = detail ?? 'names';
    const kinds = kind ? [kind] : ['struct', 'class', 'enum', 'protocol'];
    const byPath = filesByPath(files);
    // Ưu tiên generated interface (cache, CÓ doc), fallback raw .swiftinterface
    // khi framework chưa prewarm (WidgetKit...): names vẫn đủ dùng, abstract
    // thì doc vắng mặt chứ không bịa (luật convert #7). Không LOẠI raw vì
    // loại là mất trắng discovery (lỗi đã gặp: list_types WidgetKit = []).
    const cached = files.filter((f) => f.lang !== 'swift' || isCachePath(f.path));
    const raw = files.filter((f) => f.lang === 'swift' && !isCachePath(f.path));
    const srcFiles = [...cached, ...raw];
    const bySrc = filesByPath(srcFiles);
    // 1 rg duy nhất trên vài file của framework (~ms). Pattern khớp cả khi
    // decl có prefix attribute (`@frozen public struct`, `nonisolated public
    // struct`, `@MainActor ... public struct`) và KHÔNG neo `^` (generated
    // interface thụt decl con trong type cha — neo `^` mất gần hết types).
    // Members trong body bị loại ở bước convert (chỉ giữ kinds struct/class/
    // enum/protocol) — `public var axes` convert ra kind var nên rớt.
    // 57% match là `///` doc (đã đo) + offset cần quét từ đầu: -m cố định
    // 2000 (trần rg) rồi slice trong bộ nhớ — total/count ổn định mọi offset
    // (không còn total=40 ở offset 0 mà 19 ở offset 5).
    const alt = kinds.join('|');
    const pat = `\\b(${alt})\\s+[A-Za-z_]\\w*`;
    const matches = await rgRe(pat, srcFiles, 2000, true);
    const seen = new Set<string>();
    const out: ConvertedHit[] = [];
    for (const m of matches) {
      const f = bySrc.get(m.file);
      if (!f) continue;
      const h = f.lang === 'objc'
        ? convertLine(f, m.lineNumber, m.lineText, objcMapFor(f))
        : convertLine(f, m.lineNumber, m.lineText);
      if (!h || !kinds.includes(h.kind)) continue;
      if (h.name.startsWith('_')) continue;
      const k = `${h.kind}:${h.name}@${h.framework}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
    }
    void byPath;
    // Browse dọc: sort ALPHA theo tên (ổn định, predictable) — KHÔNG dùng
    // rankHits (nó trừ điểm kind + cộng FW_BOOST, làm ControlCenter nhảy lên
    // trước Accessibility* dù cùng framework, Agent không đoán được thứ tự).
    const page = [...out]
      .sort((a, b) => a.name.localeCompare(b.name, 'en') || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
      .slice(off, off + n);
    const mapped = d === 'names'
      ? page.map((h) => ({ k: h.kind, n: h.name }))
      : page.map((h) => stripLoc(withAbstract(h)));
    const body = {
      framework: files[0].framework,
      platform: files[0].platform,
      total: out.length,
      offset: off,
      count: page.length,
      types: mapped,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  },
);

// --- get_type_members: "cha có con gì" (phân tầng names/abstract) ---------------
server.tool(
  'get_type_members',
  'VERTICAL list of a type\'s members ("what does this parent have?"). WHEN: you have a type name and want its methods/properties/cases. Default detail:"names" (kind+name, ~10 tokens/member — Text 131 members fits). Use detail:"abstract" to choose among members, then get_api_detail(member) for full doc. Swift: includes extension members (most modifiers live there). Supports limit/offset paging + kind filter.',
  {
    name: z.string().describe('Type name, short or qualified (e.g. "Text", "WKInterfaceController")'),
    framework: z.string().optional().describe('Filter by framework'),
    kind: z.string().optional().describe('Filter members by kind: func, var, init, case, typealias, struct, enum (e.g. kind:"init" lists only initializers)'),
    detail: z.enum(['names', 'abstract']).optional().describe('names (default): kind+name. abstract: +1-line doc + version.'),
    limit: z.number().optional().describe('Max members (default 100, max 200)'),
    offset: z.number().optional().describe('Skip first N (default 0, for paging)'),
    include_internal: z.boolean().optional().describe('Include internal _-prefixed Apple APIs (default false)'),
    platform: z.string().optional().describe(platformDesc),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ name, framework, kind, detail, limit, offset, include_internal, platform }) => {
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
      return { content: [{ type: 'text', text: `No members found for type "${name}". NEXT: search_apis {"query":"${name}","mode":"fuzzy"} to find the real owner type.` }] };
    }
    const seen = new Set<string>();
    let deduped = members.filter((h) => {
      const k = `${h.kind}:${h.name}:${h.signature}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (kind) deduped = deduped.filter((h) => h.kind === kind);
    const total = deduped.length;
    const n = Math.min(Math.max(limit ?? 100, 1), 200);
    const off = Math.max(offset ?? 0, 0);
    const d = detail ?? 'names';
    const page = rankHits(deduped, name).slice(off, off + n);
    // Header mang field chung của type; member chỉ giữ phần riêng
    // (không file/line — tham chiếu bằng name).
    const head = typeDecl ?? page[0];
    const body = {
      type: head.name,
      framework: head.framework,
      platform: head.platform,
      lang: head.lang,
      total,
      offset: off,
      count: page.length,
      members: packMembers(head, d === 'names' ? page.map(({ docComment: _d, signature: _s, ...r }) => r as ConvertedHit) : page.map(withAbstract), d),
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  },
);

// --- read_source: đọc source gốc quanh API (tra theo NAME, không cần file/line)
server.tool(
  'read_source',
  'Read raw SDK source lines around a declaration, resolved by NAME. WHEN: verify exact @available lines, see neighboring decls, or inspect a member found by name. Pass name (+framework); server locates the decl and returns numbered source lines. NEXT: none (leaf tool). TIP: keep windows small (before<=5, after<=15) to save context.',
  {
    name: z.string().describe('API name to locate (e.g. "ScrollView", "Text", "foregroundColor"). Takes the top-ranked decl, same as get_api_detail.'),
    framework: z.string().optional().describe('Framework to narrow the lookup (e.g. "SwiftUI" vs Vision "Text")'),
    platform: z.string().optional().describe(platformDesc),
    before: z.number().optional().describe('Lines before (default 5, max 30)'),
    after: z.number().optional().describe('Lines after (default 15, max 60)'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ name, framework, platform, before, after }) => {
    const files = await filesForDocs(framework, platform);
    const byPath = filesByPath(files);
    const cands = preferIos(await locateDecl(name, files, byPath));
    if (cands.length === 0) {
      return { content: [{ type: 'text', text: `API "${name}" not found. NEXT: search_apis {"query":"${name}","mode":"fuzzy"} to find the owner type.` }] };
    }
    const top = (await withDocs(rankHits(cands, name)[0])) ?? rankHits(cands, name)[0];
    const { readWindow } = await import('./sdk.js');
    const b = Math.min(Math.max(before ?? 5, 0), 30);
    const a = Math.min(Math.max(after ?? 15, 0), 60);
    const win = readWindow(top.filePath, top.lineNumber, b, a);
    const numbered = win
      .map((text, i) => `${top.lineNumber - b + i}: ${text}`)
      .join('\n');
    return { content: [{ type: 'text', text: numbered }] };
  },
);

// --- prewarm_docs: sinh trước generated interface ------------------------------
server.tool(
  'prewarm_docs',
  'SETUP tool (call once per framework, not per query): generate+cache Xcode "generated interface" so later calls return doc comments without delay. WHEN: first use of a Swift framework, or detail/members return no docComment. Cached on disk per Xcode build (~1-3s/framework).',
  {
    frameworks: z.array(z.string()).optional().describe('Frameworks to prewarm (e.g. ["SwiftUI","WidgetKit"]). Omit = every Swift framework (slow, minutes — avoid).'),
    platform: z.string().optional().describe(platformDesc),
  },
  {
    openWorldHint: false,
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
        }),
      }],
    };
  },
);

// --- grep_sdk: ripgrep thô (leaf/debug — KHÔNG dùng để đếm API) -----------------
// Output gọn: KHÔNG file/line (Agent tra lại bằng name qua read_source).
// Giữ text dòng match + framework chứa nó — đủ để verify/inspect.
server.tool(
  'grep_sdk',
  'LEAF/DEBUG tool: raw fixed-string matches (match text + framework). WHEN: inspect a marker/version string, or verify a declaration exists verbatim. Re-locate any hit via read_source {name}. NOT for counting APIs — 1 API spans 4 @available lines (iOS/macOS/tvOS/watchOS); use get_new_apis/get_deprecated for API objects. Prefer search_apis for converted results.',
  {
    pattern: z.string().describe('Fixed string to search (e.g. "scrollTargetBehavior", "deprecated: 26.0")'),
    framework: z.string().optional().describe('Filter by framework'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max matches (default 30, max 200)'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ pattern, framework, platform, limit }) => {
    const files = filesFor(framework, platform);
    const n = Math.min(Math.max(limit ?? 30, 1), 200);
    const matches = await rgMatches(pattern, files, n);
    const byPath = filesByPath(files);
    const out = matches.map((m) => ({
      text: m.lineText,
      framework: byPath.get(m.file)?.framework,
    }));
    const body = { count: out.length, matches: out };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  },
);

// --- list_frameworks: entry point chuỗi DỌC (frameworks -> list_types) ---------
server.tool(
  'list_frameworks',
  'VERTICAL entry: list frameworks (no parsing, ~ms). WHEN: start exploring ("what framework for widgets?") or validate a framework name. Use query to prefix-filter ("Swift" -> SwiftUI/SwiftData..., avoids 10k-token full list). NEXT: list_types(framework).',
  {
    query: z.string().optional().describe('Prefix/substring filter (e.g. "Swift", "Widget", "Map"). Omit = all (~332, ~10k tokens — avoid).'),
    platform: z.string().optional().describe(platformDesc),
    include_private: z.boolean().optional().describe('Include Apple-internal _-prefixed frameworks (default false)'),
    limit: z.number().optional().describe('Max frameworks (default 50, max 500)'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ query, platform, include_private, limit }) => {
    let fws = listFrameworksFast(platsArg(platform)).sort((a, b) => a.name.localeCompare(b.name));
    // `_AppIntents_SwiftUI` & co: internal của Apple, agent không dùng được.
    if (!include_private) fws = fws.filter((f) => !f.name.startsWith('_'));
    const total = fws.length;
    if (query) {
      const q = query.toLowerCase();
      fws = fws.filter((f) => f.name.toLowerCase().includes(q));
    }
    const n = Math.min(Math.max(limit ?? 50, 1), 500);
    const page = fws.slice(0, n);
    // Gọn: platforms là mảng ngắn; query rỗng + full list thì chỉ tên.
    const body = query
      ? { total, count: page.length, frameworks: page }
      : { total, count: page.length, frameworks: page.map((f) => f.name) };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  },
);

// --- get_new_apis: rg introduced/version ---------------------------------------
server.tool(
  'get_new_apis',
  'Find APIs introduced in a version ("what is new in iOS 26 for SwiftUI?"). WHEN: version-scoped discovery. Marker lines (4/platform) resolve to ONE API object via declFromMarker — no marker spam. No deprecated fields (asking "new"). NEXT: get_api_detail(name) for full doc.',
  {
    version: z.string().describe('Version string, e.g. "26.0", "18.0", "11.0"'),
    framework: z.string().optional().describe('Filter by framework (recommended — cross-SDK scan is slow)'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max APIs (default 40, max 200)'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ version, framework, platform, limit }) => {
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
    // LỌC version thật: pattern ` ${v},` dính chéo ("15.0, 26.0" chứa " 26.0,",
    // "iOS 27.0" chứa tvOS-seg "introduced: 26.0") -> chỉ giữ hit có
    // introducedIn đúng version hỏi. introducedIn lấy từ seg iOS nên
    // `Body` (iOS 27) hay `init` (scope iOS 26 nhưng own seg iOS 15) đều rớt.
    const { fileLines } = await import('./sdk.js');
    const hits: ConvertedHit[] = [];
    const dedup = new Set<string>();
    const wantV = (() => {
      const p = v.split('.');
      const maj = parseInt(p[0], 10); const min = p[1] ? parseInt(p[1], 10) : 0;
      return Number.isFinite(maj) ? maj * 10000 + min * 100 : null;
    })();
    for (const m of seen.values()) {
      const file = byPath.get(m.file);
      if (!file) continue;
      const hit = declFromMarker(
        file, m.lineNumber, fileLines(m.file),
        file.lang === 'objc' ? objcMapFor(file) : undefined,
      );
      if (!hit) continue;
      if (wantV !== null && hit.introducedIn !== undefined && hit.introducedIn !== wantV) continue;
      const k = `${hit.kind}:${hit.name}@${hit.framework}:${hit.signature}`;
      if (dedup.has(k)) continue;
      dedup.add(k);
      hits.push(withAbstract(hit));
      if (hits.length >= n) break;
    }
    const packed = packList(rankHits(hits, version));
    return { content: [{ type: 'text', text: JSON.stringify(packed) }] };
  },
);

// --- get_deprecated: migrate code cũ (renamed + message giữ lại) -----------------
server.tool(
  'get_deprecated',
  'MIGRATE old code: deprecated/unavailable APIs WITH replacements. WHEN: compiler warns deprecated, or auditing old code. Each hit keeps renamedTo + message (e.g. "Use string interpolation on Text instead") — the fix Agent needs. NEXT: get_api_detail(renamedTo) for the replacement\'s doc.',
  {
    query: z.string().optional().describe('Optional keyword to narrow (e.g. "Text", "foregroundColor"). Omit for a broad scan (capped).'),
    framework: z.string().optional().describe('Filter by framework'),
    platform: z.string().optional().describe(platformDesc),
    limit: z.number().optional().describe('Max APIs (default 40, max 200)'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
  async ({ query, framework, platform, limit }) => {
    const files = filesFor(framework, platform);
    const byPath = filesByPath(files);
    const n = Math.min(Math.max(limit ?? 40, 1), 200);
    const markers = ['deprecated:', 'API_DEPRECATED', 'NS_DEPRECATED', 'unavailable'];
    const seen = new Map<string, { file: string; lineNumber: number; lineText: string }>();
    // Query rút về token dài nhất ("foregroundColor" thay vì cả câu): marker
    // dòng (`deprecated: 26.0, message: ...`) hiếm khi chứa tên API — tên nằm
    // ở DECL kề sau. Lọc bằng decl chứ không lọc bằng marker (lỗi đã đo:
    // query "foregroundColor"/"interpolation" ra count 0 vì marker không
    // chứa từ đó).
    const qRaw = (query ?? '').split(/[^A-Za-z0-9_]+/).filter((t) => t.length >= 2)
      .sort((a, b) => b.length - a.length)[0]?.toLowerCase();
    const { fileLines: flines } = await import('./sdk.js');
    for (const mk of markers) {
      for (const m of await rgMatches(mk, files, 200)) {
        // Sentinel `deprecated: 100000.0` = CHƯA deprecated -> loại.
        if (!isRealDeprecation(m.lineText)) continue;
        const file = byPath.get(m.file);
        if (!file) continue;
        // Resolve decl TRƯỚC, lọc query SAU (trên name+signature+message).
        const pre = declFromMarker(
          file, m.lineNumber, flines(m.file),
          file.lang === 'objc' ? objcMapFor(file) : undefined,
        );
        if (!pre) continue;
        if (qRaw) {
          const hay = `${pre.name} ${pre.signature} ${m.lineText}`.toLowerCase();
          if (!hay.includes(qRaw)) continue;
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
    const packed = packList(query ? rankHits(hits, query) : hits);
    return { content: [{ type: 'text', text: JSON.stringify(packed) }] };
  },
);

// --- get_sdk_stats --------------------------------------------------------------
server.tool(
  'get_sdk_stats',
  'Corpus stats: file counts per platform/lang (no index). WHEN: debugging empty results (wrong SDK? missing platform?). NOT for normal API lookup.',
  {},
  {
    readOnlyHint: true,
    openWorldHint: false,
  },
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
        ),
      }],
    };
  },
);

// --- get_guide: ví dụ + cách dùng (lớp knowledge, không phải SDK source) ---------
server.tool(
  'get_guide',
  'Usage guides + code examples (LAST step of the workflow). WHEN: you have the API name and need HOW-TO + sample code (not signatures). Reads ios27-full-knowledge.md + IOS_DOCS_PATH markdown. Call AFTER get_api_detail, not before.',
  {
    query: z.string().describe('Topic or API name (e.g. "Liquid Glass", "WidgetKit", "TimelineEntry")'),
  },
  {
    readOnlyHint: true,
    openWorldHint: false,
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
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ios-sdk-mcp running on stdio (direct SDK mode, no index)');
}

main().catch(console.error);
