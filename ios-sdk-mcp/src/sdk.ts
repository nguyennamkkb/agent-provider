import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import type { SdkPlatform } from './types.js';
import { extractAvailableInners, mergeAvailability, parseSwiftAvailable } from './parser.js';

const execFileAsync = promisify(execFile);

/** SDK roots inside Xcode.app. */
export const SDK_PATHS: Record<SdkPlatform, string> = {
  ios: '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk',
  watchos: '/Applications/Xcode.app/Contents/Developer/Platforms/WatchOS.platform/Developer/SDKs/WatchOS.sdk',
  macos: '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
  tvos: '/Applications/Xcode.app/Contents/Developer/Platforms/AppleTVOS.platform/Developer/SDKs/AppleTVOS.sdk',
  xros: '/Applications/Xcode.app/Contents/Developer/Platforms/XROS.platform/Developer/SDKs/XROS.sdk',
};

export interface SdkFile {
  path: string;
  framework: string;
  platform: SdkPlatform;
  lang: 'swift' | 'objc';
}

export interface RgMatch {
  file: string;
  lineNumber: number;
  lineText: string;
}

// *.swift: generated interface đã cache (nguồn Swift DUY NHẤT có doc comment,
// xem iface.ts). Không có .swift trong SDK Frameworks nên glob này chỉ trúng cache.
const GLOBS = ['*.swiftinterface', '*.h', '*.swift'];

// --- file discovery (1 lần, cache) ------------------------------------------

let fileCache: SdkFile[] | null = null;
let fileCacheByPlatform = new Map<string, SdkFile[]>();

/** Liệt kê mọi .swiftinterface + .h trong SDKs. Chạy 1 lần rồi cache
 * (cả full lẫn theo từng platform — .filter() 20k rows mỗi query tốn ~ms
 * nhưng cộng dồn qua nhiều tools; cache key theo platform rẻ hơn). */
export function discoverFiles(platforms?: SdkPlatform[]): SdkFile[] {
  if (fileCache) {
    if (!platforms) return fileCache;
    const key = [...platforms].sort().join(',');
    let hit = fileCacheByPlatform.get(key);
    if (!hit) {
      hit = fileCache.filter((f) => platforms.includes(f.platform));
      fileCacheByPlatform.set(key, hit);
    }
    return hit;
  }
  const out: SdkFile[] = [];
  // Dedup symlink: macOS .framework/{Modules,Headers} -> Versions/Current/... .
  // Không dedup, rg liệt kê CẢ path logical (Modules/...) lẫn physical
  // (Versions/A/...) -> trùng file, convertOK tính 2 lần, pull chain sai.
  // Chuẩn hóa mọi path về realpath: rg -P cũng trả realpath nên byPath khớp.
  const seenReal = new Set<string>();
  const reg = (realPath: string, _logicalPath: string, framework: string, platform: SdkPlatform, lang: 'swift' | 'objc') => {
    if (seenReal.has(realPath)) return;
    seenReal.add(realPath);
    out.push({ path: realPath, framework, platform, lang });
  };
  const wanted = platforms ?? (Object.keys(SDK_PATHS) as SdkPlatform[]);
  for (const p of wanted) {
    const sdk = SDK_PATHS[p];
    const fwRoot = path.join(sdk, 'System/Library/Frameworks');
    if (!fs.existsSync(fwRoot)) continue;
    for (const fwDir of fs.readdirSync(fwRoot)) {
      if (!fwDir.endsWith('.framework')) continue;
      const fwName = fwDir.slice(0, -'.framework'.length);
      const fwPath = path.join(fwRoot, fwDir);
      const modDir = path.join(fwPath, 'Modules', `${fwName}.swiftmodule`);
      if (fs.existsSync(modDir)) {
        for (const f of fs.readdirSync(modDir)) {
          if (f.endsWith('.swiftinterface')) {
            const lp = path.join(modDir, f);
            reg(fs.realpathSync(lp), lp, fwName, p, 'swift');
          }
        }
      }
      const hdrDir = path.join(fwPath, 'Headers');
      if (fs.existsSync(hdrDir)) {
        for (const f of fs.readdirSync(hdrDir)) {
          if (f.endsWith('.h')) {
            const lp = path.join(hdrDir, f);
            reg(fs.realpathSync(lp), lp, fwName, p, 'objc');
          }
        }
      }
    }
  }
  // Cache full khi discover không filter; filter thì lọc từ cache full.
  if (!platforms) fileCache = out;
  else if (!fileCache) {
    fileCache = discoverFiles();
    return fileCache.filter((f) => platforms.includes(f.platform));
  }
  return out;
}

/** Frameworks có mặt (kèm platforms), không cần parse. */
export function listFrameworksFast(platforms?: SdkPlatform[]): { name: string; platforms: SdkPlatform[] }[] {
  const files = discoverFiles(platforms);
  const map = new Map<string, Set<SdkPlatform>>();
  for (const f of files) {
    if (!map.has(f.framework)) map.set(f.framework, new Set());
    map.get(f.framework)!.add(f.platform);
  }
  return [...map.entries()].map(([name, plats]) => ({ name, platforms: [...plats] }));
}

// --- ripgrep ---------------------------------------------------------------

function rgArgs(dirs: string[], extra: string[]): string[] {
  const args: string[] = [];
  for (const g of GLOBS) args.push('-g', g);
  // --no-messages + --no-config: bỏ warning/time đọc config.
  // -P/--no-follow: KHÔNG theo symlink (macOS Modules -> Versions/Current
  // làm rg quét trùng file, trả path Versions/A/... lệch với discover).
  // --sort path: DETERMINISTIC — cùng query mọi lần cùng thứ tự matches.
  // (rg -m là per-file nên không sort thì convert/dedup/rank ra top khác nhau
  // giữa các lần gọi, Agent retry nhận kết quả khác.)
  args.push('--no-messages', '--no-config', '-P', '--sort', 'path', ...extra, '--', ...dirs);
  return args;
}

/** Gom dirs theo SDK Frameworks root (1 root/SDK thay vì 1414 dirname):
 * rg spawn + walk ít hơn (~350ms -> ~50ms cho no-match toàn corpus).
 * VD: .../iPhoneOS.sdk/System/Library/Frameworks (rg tự --glob lọc). */
function toDirs(files: SdkFile[]): string[] {
  // Tập nhỏ (đã lọc framework / chỉ vài file): quét ĐÚNG thư mục của chúng.
  // Gom về root ở đây là sai: rg quét cả SDK rồi caller vứt match lạ, `-m limit`
  // bị đốt vào framework khác -> lọc framework=SwiftUI vẫn nhận hit UIKit.
  if (files.length <= 40) {
    return [...new Set(files.map((f) => path.dirname(f.path)))];
  }
  const roots = new Set<string>();
  for (const f of files) {
    const idx = f.path.lastIndexOf('/System/Library/Frameworks/');
    if (idx >= 0) {
      roots.add(f.path.slice(0, idx + '/System/Library/Frameworks'.length));
    } else {
      roots.add(path.dirname(f.path));
    }
  }
  return [...roots];
}

/** Chạy rg --json, trả matches (file + dòng). Fixed-strings.
 * LƯU Ý: -F match substring nên '@interface Foo' cũng dính '@protocol FooBar;'.
 * Caller lọc tiếp bằng regex neo từ (/\b/) — xem direct.test.ts UIScrollView.
 * @param caseSensitive true = phân biệt hoa thường (pass A: `Text` không dính
 * `context`, `latest`); false = NOCASE quét rộng (pass B).
 */
export async function rgMatchesCase(
  pattern: string,
  files: SdkFile[],
  limit = 200,
  caseSensitive = false,
): Promise<RgMatch[]> {
  if (files.length === 0 || !pattern) return [];
  const out: RgMatch[] = [];
  const flags = caseSensitive ? ['-s'] : ['-i'];
  const run = async (extra: string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(
        'rg',
        rgArgs(toDirs(files), ['--json', ...flags, '-F', '-m', String(limit), '-e', pattern, ...extra]),
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout;
    } catch (e: unknown) {
      if ((e as { code?: number }).code !== 1) throw e;
      return (e as { stdout?: string }).stdout ?? '';
    }
  };
  const parse = (stdout: string) => {
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      try {
        const j = JSON.parse(line);
        out.push({
          file: j.data.path.text,
          lineNumber: j.data.line_number,
          lineText: j.data.lines.text.replace(/\n$/, ''),
        });
      } catch { /* bỏ dòng json vỡ */ }
      if (out.length >= limit) break;
    }
  };
  parse(await run([]));
  return out;
}

/** rg regex (word-boundary...), còn lại giống rgMatchesCase. */
export async function rgRegex(
  pattern: string,
  files: SdkFile[],
  limit = 200,
  caseSensitive = false,
): Promise<RgMatch[]> {
  if (files.length === 0 || !pattern) return [];
  const out: RgMatch[] = [];
  const flags = caseSensitive ? ['-s'] : ['-i'];
  try {
    const { stdout } = await execFileAsync(
      'rg',
      rgArgs(toDirs(files), ['--json', ...flags, '-m', String(limit), '-e', pattern]),
      { maxBuffer: 64 * 1024 * 1024 },
    );
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      try {
        const j = JSON.parse(line);
        out.push({
          file: j.data.path.text,
          lineNumber: j.data.line_number,
          lineText: j.data.lines.text.replace(/\n$/, ''),
        });
      } catch { /* bỏ */ }
      if (out.length >= limit) break;
    }
  } catch (e: unknown) {
    if ((e as { code?: number }).code !== 1) throw e;
    const stdout = (e as { stdout?: string }).stdout ?? '';
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      try {
        const j = JSON.parse(line);
        out.push({
          file: j.data.path.text,
          lineNumber: j.data.line_number,
          lineText: j.data.lines.text.replace(/\n$/, ''),
        });
      } catch { /* bỏ */ }
    }
  }
  return out;
}

export async function rgMatches(
  pattern: string,
  files: SdkFile[],
  limit = 200,
): Promise<RgMatch[]> {
  if (files.length === 0 || !pattern) return [];
  const out: RgMatch[] = [];
  try {
    const { stdout } = await execFileAsync(
      'rg',
      rgArgs(toDirs(files), ['--json', '-i', '-F', '-m', String(limit), '-e', pattern]),
      { maxBuffer: 64 * 1024 * 1024 },
    );
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      try {
        const j = JSON.parse(line);
        out.push({
          file: j.data.path.text,
          lineNumber: j.data.line_number,
          lineText: j.data.lines.text.replace(/\n$/, ''),
        });
      } catch { /* bỏ dòng json vỡ */ }
      if (out.length >= limit) break;
    }
  } catch (e: unknown) {
    // rg exit 1 = không match (không phải lỗi). Lỗi thật thì ném.
    const code = (e as { code?: number }).code;
    if (code !== 1) throw e;
    const stdout = (e as { stdout?: string }).stdout ?? '';
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('{"type":"match"')) continue;
      try {
        const j = JSON.parse(line);
        out.push({
          file: j.data.path.text,
          lineNumber: j.data.line_number,
          lineText: j.data.lines.text.replace(/\n$/, ''),
        });
      } catch { /* bỏ */ }
    }
  }
  return out;
}

/** Chỉ lấy danh sách file chứa pattern (nhanh hơn matches). */
export async function rgFiles(pattern: string, files: SdkFile[], limit = 100): Promise<string[]> {
  if (files.length === 0 || !pattern) return [];
  try {
    const { stdout } = await execFileAsync(
      'rg',
      rgArgs(toDirs(files), ['-l', '-i', '-F', '-m', '1', '-e', pattern]),
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, limit);
  } catch (e: unknown) {
    if ((e as { code?: number }).code !== 1) throw e;
    return [];
  }
}

/** Tách query thành tokens (cho "scroll view" -> ["scroll","view"]). */
export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
}

/** Chuẩn hóa version number -> "13.0" (130000 -> "13.0", 999999 -> null). */
export function formatVersion(v: number | null | undefined): string | null {
  if (v === null || v === undefined || v >= 999999) return null;
  return `${Math.floor(v / 10000)}.${Math.floor((v % 10000) / 100)}`;
}

/**
 * Rút gọn chuỗi @available thô: gộp các dòng cùng platform (giữ dòng đầu),
 * bỏ sentinel deprecated 100000.0. VD 2 dòng iOS 16 + iOS 13 -> giữ 1.
 * Trả { text, introducedIn, deprecatedIn, renamedTo, unavailable } để convert
 * không phải parse lại.
 */
export function compactAvailability(
  availLines: string[],
  parsed: { introducedIn: number; deprecatedIn: number | null; renamedTo?: string; unavailable: boolean },
): string | undefined {
  if (availLines.length === 0) return undefined;
  if (availLines.length === 1) return availLines[0];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const l of availLines) {
    // key = platform đầu dòng (@available(iOS ... / API_AVAILABLE(ios...)...)
    const m = l.match(/^@(\w+)\((\w+)/) || l.match(/\b(API_\w+|NS_\w+)\b/);
    const key = m ? m[0].toLowerCase() : l.slice(0, 24).toLowerCase();
    // Giữ dòng đầu mỗi key; dòng sau cùng key mà ngắn hơn thì bỏ.
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(l);
  }
  // Bỏ sentinel trong text (deprecated: 100000.0 -> deprecated: —).
  return kept.map((l) => l.replace(/,?\s*deprecated:\s*100000\.0/g, '')).join('; ');
}

// --- đọc source + giải tích phía trên ---------------------------------------

const linesCache = new Map<string, string[]>();

/** Đọc toàn bộ dòng file (cache). */
export function fileLines(filePath: string): string[] {
  let lines = linesCache.get(filePath);
  if (!lines) {
    lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    if (linesCache.size > 500) linesCache.clear();
    linesCache.set(filePath, lines);
  }
  return lines;
}

/** Cửa sổ dòng quanh 1 match (1-indexed). */
export function readWindow(filePath: string, lineNumber: number, before = 3, after = 10): string[] {
  const lines = fileLines(filePath);
  return lines.slice(Math.max(0, lineNumber - 1 - before), lineNumber - 1 + after);
}

export interface ContextAnalysis {
  /** Các dòng @available thô phía trên decl. */
  availLines: string[];
  /** Version iOS / deprecated / renamed / unavailable (đã merge). */
  introducedIn: number | null;
  deprecatedIn: number | null;
  renamedTo?: string;
  unavailable: boolean;
  /** Doc comment phía trên (//, ///, block comment). */
  docComment?: string;
}

/**
 * Tìm dòng mở scope chứa 1 dòng decl (đi ngược + brace counting): struct/class/
 * enum/extension/@interface/@protocol gần nhất mà block của nó chứa decl.
 * Trả index 0-based của opener, hoặc -1.
 */
export function findScopeOpener(lines: string[], lineNumber: number, maxLookback = 400): number {
  let depth = 0;
  for (let i = lineNumber - 1; i >= Math.max(0, lineNumber - maxLookback); i--) {
    const t = (lines[i] ?? '').trim();
    const noStr = t.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    depth += (noStr.match(/\}/g) || []).length - (noStr.match(/\{/g) || []).length;
    if (depth < 0) {
      // depth âm KHÔNG đồng nghĩa opener: VD `}` ở 1448 đóng getter của member
      // TRƯỚC (environment), không phải mở scope chứa decl.
      // Chỉ nhận opener khi: extension/@interface/@protocol, hoặc dòng mở type
      // (struct/class/enum...), hoặc dòng có `{` mở scope mà KHÔNG phải dòng
      // member `public var/func... {` (getter block — opener thật nằm trên nữa).
      const isExtLike = /(^|[\s*])(extension|@interface|@protocol)\b/.test(t);
      const isTypeOpen = /^\s*(public|open|package)\s+(class|struct|enum|protocol|actor)\b/.test(t);
      const hasBrace = /\{\s*$/.test(noStr);
      const isMemberWithBody = /^\s*(public|open|package)\b.*\b(var|func|init|subscript|let)\b.*\{\s*$/.test(t);
      if (isExtLike || isTypeOpen) return i;
      if (hasBrace && !isMemberWithBody) return i;
      // `}` lẻ hoặc member có body (getter): đây là scope con đã đóng —
      // cân bằng lại (dòng này +1 opener ảo) rồi đi tiếp lên.
      depth = 0;
      continue;
    }
    if (depth === 0 && /(^|[\s*])(extension|@interface|@protocol)\b/.test(t)) return i;
  }
  return -1;
}

/** Dòng có phải availability/macro marker không (cả Swift + ObjC). */
function isAvailLine(t: string): boolean {
  return t.startsWith('@available') ||
    /\b(API_AVAILABLE|API_DEPRECATED|API_DEPRECATED_WITH_REPLACEMENT|API_UNAVAILABLE|NS_AVAILABLE|NS_DEPRECATED|NS_CLASS_AVAILABLE)\b/.test(t);
}

/** Gom @available lines kề ngay trên 1 dòng (dừng ở trống/code khác). */
function collectOwnAvail(lines: string[], lineNumber: number): string[] {
  const out: string[] = [];
  for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 17); i--) {
    const t = (lines[i] ?? '').trim();
    if (!t) break;
    if (t.startsWith('#') || t.startsWith('@_originallyDefinedIn')) continue;
    // NOTE: `t` đã trim() nên KHÔNG còn thụt đầu dòng để phân biệt member
    // trong struct vs decl top-level — mọi check dưới dùng chuỗi đã trim.
    // Dòng decl member (`public var content: Content`, kể cả `nonisolated
    // public var axes...` của chính caller): own avail của axes nằm TRÊN nó
    // (trên struct decl) -> xuyên qua, không dừng. (Raw .swiftinterface:
    // member không own @available, avail duy nhất nằm trên struct decl.)
    // Dòng mở scope (`... struct ScrollView<Content> ... {`) -> xuyên qua
    // (collectOwnAvail của scope opener lo phần trên nó), KHÔNG break.
    if (/\b(struct|class|enum|protocol|actor|extension)\b.*\{\s*$/.test(t)) continue;
    if (/^(public|open|nonisolated|@frozen)\b.*\b(var|let|func|init|typealias)\b/.test(t) && !isAvailLine(t)) continue;
    if (isAvailLine(t)) {
      out.unshift(t);
      continue;
    }
    // Attribute đứng RIÊNG dòng (`@frozen`, `@MainActor`, `@backDeployed(...)`):
    // xuyên qua, vì @available có thể nằm phía trên nó. Dừng ở dòng trống/code
    // như cũ nên không hút nhầm @available của decl phía trên.
    if (/^@[A-Za-z_]\w*(\s*\([^)]*\))?\s*$/.test(t)) continue;
    break;
  }
  return out;
}

/**
 * Giải tích phía trên 1 dòng decl: gom @available lines + standalone ObjC
 * macros + doc comment. Đúng semantics parser scope stack:
 * - own @available kề trên decl (dừng ở trống/code).
 * - + @available phía trên scope opener chứa decl (inheritance).
 * Xuyên @_originallyDefinedIn / #if. Áp luật merge của parser.
 */
export function analyzeContext(filePath: string, lineNumber: number, _maxLookback = 60): ContextAnalysis {
  const lines = fileLines(filePath);
  // Phase 1a: own.
  const availLines = collectOwnAvail(lines, lineNumber);
  // Phase 1b: scope opener -> gom phía trên nó (inheritance).
  // Member KHÔNG own @available (thường gặp: var/func trong struct/extension)
  // thì lấy của scope. Member CÓ own thì chỉ merge thêm khi opener là
  // extension KHÁC scope hiện tại? Không — đơn giản + đúng parser: merge luôn
  // (mergeAvailability lấy min/intro theo iOS, union deprecated/renamed).
  const openerIdx = findScopeOpener(lines, lineNumber);
  if (openerIdx >= 0) {
    const above = collectOwnAvail(lines, openerIdx + 1);
    for (const l of above) {
      if (!availLines.includes(l)) availLines.unshift(l);
    }
  }

  // Phase 2: doc comment liền kề (parser takeDoc semantics).
  const docParts: string[] = [];
  let inBlock = false;
  let blockBuf: string[] = [];
  // 400 dòng: doc của Apple trong generated interface rất dài (ScrollView ~45
  // dòng, View modifiers >200 kèm ví dụ code). Giới hạn 15 cũ cắt mất phần
  // abstract ở ĐẦU doc — phần quan trọng nhất. Vòng lặp vẫn dừng ngay ở dòng
  // trống/dòng code nên không nuốt doc của decl phía trên.
  for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 2 - 400); i--) {
    const raw = lines[i] ?? '';
    const t = raw.trim();
    if (!t) break;
    if (t.startsWith('@available') || t.startsWith('@_originallyDefinedIn') || t.startsWith('#')) continue;
    if (inBlock) {
      if (t.includes('*/')) {
        blockBuf.unshift(t.slice(0, t.indexOf('*/')));
        const body = blockBuf.join(' ').replace(/^\s*\*\s?/gm, '').trim();
        if (body) docParts.unshift(body);
        blockBuf = [];
        inBlock = false;
      } else {
        blockBuf.unshift(t);
      }
      continue;
    }
    if (t.endsWith('*/')) {
      const start = t.indexOf('/*');
      if (start >= 0 && t.indexOf('/*') < t.indexOf('*/')) {
        const body = t.slice(start + 2, t.indexOf('*/')).replace(/^\s*\*\s?/gm, '').trim();
        if (body) docParts.unshift(body);
        continue;
      }
      blockBuf.unshift(t.slice(0, t.indexOf('*/')));
      inBlock = true;
      continue;
    }
    if (t.startsWith('///') || t.startsWith('//!')) {
      docParts.unshift(t.replace(/^\/\/[!/]?\s?/, ''));
      continue;
    }
    if (t.startsWith('//')) {
      docParts.unshift(t.replace(/^\/\/\s?/, ''));
      continue;
    }
    if (t.startsWith('*')) {
      docParts.unshift(t.replace(/^\*\s?/, ''));
      continue;
    }
    break; // dòng code khác -> dừng
  }

  const result: ContextAnalysis = {
    availLines,
    introducedIn: null,
    deprecatedIn: null,
    unavailable: false,
  };
  if (availLines.length > 0) {
    try {
      const parsed = availLines.flatMap((l) => extractAvailableInners(l)).map((inner) => parseSwiftAvailable(inner));
      // ObjC macros đứng riêng dòng (API_AVAILABLE(ios(11.0))) cũng gom ở đây:
      // parseSwiftAvailable không hiểu -> fallback thủ công.
      const merged = mergeAvailability(parsed);
      result.introducedIn = merged.introducedIn !== 999999 ? merged.introducedIn : null;
      result.deprecatedIn = merged.deprecatedIn;
      result.renamedTo = merged.renamedTo;
      result.unavailable = merged.unavailable;
    } catch { /* giữ null */ }
  }
  // ObjC standalone macro line: API_AVAILABLE(ios(x.y)) / API_DEPRECATED...
  for (const l of availLines) {
    const m = l.match(/API_AVAILABLE\s*\(\s*ios\s*\(\s*([0-9._]+)/i);
    if (m && result.introducedIn === null) {
      const v = m[1].replace(/_/g, '.').split('.');
      result.introducedIn = parseInt(v[0], 10) * 10000 + (v[1] ? parseInt(v[1], 10) : 0) * 100;
    }
  }
  const doc = docParts.join('\n').trim();
  if (doc) result.docComment = doc;
  return result;
}
