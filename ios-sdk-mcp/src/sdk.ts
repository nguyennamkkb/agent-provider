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

const GLOBS = ['*.swiftinterface', '*.h'];

// --- file discovery (1 lần, cache) ------------------------------------------

let fileCache: SdkFile[] | null = null;

/** Liệt kê mọi .swiftinterface + .h trong SDKs. Chạy 1 lần rồi cache. */
export function discoverFiles(platforms?: SdkPlatform[]): SdkFile[] {
  if (fileCache) {
    return platforms ? fileCache.filter((f) => platforms.includes(f.platform)) : fileCache;
  }
  const out: SdkFile[] = [];
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
            out.push({ path: path.join(modDir, f), framework: fwName, platform: p, lang: 'swift' });
          }
        }
      }
      const hdrDir = path.join(fwPath, 'Headers');
      if (fs.existsSync(hdrDir)) {
        for (const f of fs.readdirSync(hdrDir)) {
          if (f.endsWith('.h')) {
            out.push({ path: path.join(hdrDir, f), framework: fwName, platform: p, lang: 'objc' });
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
  for (const g of GLOBS) args.push('--glob', g);
  args.push(...extra, '--', ...dirs);
  return args;
}

function toDirs(files: SdkFile[]): string[] {
  return [...new Set(files.map((f) => path.dirname(f.path)))];
}

/** Chạy rg --json, trả matches (file + dòng). Fixed-strings, case-insensitive.
 * LƯU Ý: -F match substring nên '@interface Foo' cũng dính '@protocol FooBar;'.
 * Caller lọc tiếp bằng regex neo từ (/\b/) — xem direct.test.ts UIScrollView. */
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
 * Giải tích phía trên 1 dòng decl: gom @available lines + standalone ObjC
 * macros + doc comment. Chạy 2 phase đúng semantics parser:
 * - Phase 1: đi ngược qua scope chain (giống scope stack của parser): member
 *   không @available riêng -> thừa hưởng @available của `extension`/type chứa
 *   nó. Xuyên qua @_originallyDefinedIn / #if / dòng trống / `}` đóng.
 * - Phase 2: doc comment liền kề phía trên decl (dừng ở dòng trống/code).
 * Áp đúng luật merge của parser (mergeAvailability).
 */
export function analyzeContext(filePath: string, lineNumber: number, maxLookback = 60): ContextAnalysis {
  const lines = fileLines(filePath);
  const availLines: string[] = [];

  // Phase 1: scope chain — đi ngược tìm @available của scope chứa decl.
  // Thuật toán (giống parser scope stack, chạy ngược): brace depth tương đối
  // so với decl. Cùng level (depth 0) = @available của chính decl. Khi gặp
  // dòng mở scope (extension/type/@interface...) mà depth < 0, ta vừa thoát
  // scope con -> reset depth về (depth+opens-closes của dòng opener) rồi gom
  // tiếp @available phía trên opener (inheritance).
  let depth = 0;
  let collecting = true;
  for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 2 - maxLookback); i--) {
    const raw = lines[i] ?? '';
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue; // xuyên qua trống + preprocessor
    if (t.startsWith('@_originallyDefinedIn')) continue; // move-marker, xuyên qua
    const noStr = t.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const opens = (noStr.match(/\{/g) || []).length;
    const closes = (noStr.match(/\}/g) || []).length;
    const isAvail = t.startsWith('@available') ||
      /\b(API_AVAILABLE|API_DEPRECATED|API_DEPRECATED_WITH_REPLACEMENT|API_UNAVAILABLE|NS_AVAILABLE|NS_DEPRECATED|NS_CLASS_AVAILABLE)\b/.test(t);
    if (isAvail) {
      if (!collecting) continue; // @available của scope con đã đóng -> bỏ
      availLines.unshift(t);
      continue;
    }
    // Dòng code: cập nhật depth ngược (đi lên: `}` = vào scope con đã đóng).
    depth += closes - opens;
    if (depth < 0) {
      // Vừa thoát 1 scope con: nếu dòng này là opener (extension/type/...)
      // thì đó chính là scope chứa decl -> tiếp tục gom phía trên nó.
      // Nếu không phải opener (member khác) -> dừng.
      const isOpener = /(^|[\s*])(extension|@interface|@protocol)\b/.test(t) ||
        /^\s*(public|open|package)\b.*\{\s*$/.test(raw) ||
        /^\s*(public|open|package)\s+(class|struct|enum|protocol|actor)\b/.test(t);
      if (isOpener) {
        depth = 0; // vào scope cha, gom tiếp
        continue;
      }
      break;
    }
    if (depth === 0) {
      // Cùng level: decl khác (kể cả `}` đóng scope trước) -> dừng gom avail.
      // Ngoại lệ: dòng `{`-only/`}`-only đã xử lý ở depth; comment bỏ qua ở phase 2.
      if (/^(\}|\{)\s*$/.test(t)) continue;
      collecting = false;
      // Vẫn đi tiếp để tìm opener scope cha? Không — depth 0 + decl khác =
      // đã hết block của decl. Dừng hẳn để tránh leo nhầm.
      if (/^\s*(@|[a-zA-Z])/.test(t) && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')) {
        // Cho phép đi tiếp qua comment-only lines (phase 2 lo doc), dừng ở code.
        if (!/^[A-Za-z@#]/.test(t)) continue;
        break;
      }
    }
    // depth > 0: đang trong scope con đã đóng -> bỏ qua tới khi cân bằng.
  }

  // Phase 2: doc comment liền kề (parser takeDoc semantics).
  const docParts: string[] = [];
  let inBlock = false;
  let blockBuf: string[] = [];
  for (let i = lineNumber - 2; i >= Math.max(0, lineNumber - 2 - 15); i--) {
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
