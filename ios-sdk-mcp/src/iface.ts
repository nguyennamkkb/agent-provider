import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SDK_PATHS, type SdkFile } from './sdk.js';
import type { SdkPlatform } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Nguồn DOC của Swift API.
 *
 * .swiftinterface trong SDK đã bị strip toàn bộ doc comment -> mọi hit Swift
 * trước đây luôn thiếu `docComment` (chỉ ObjC .h là có). Xcode lấy doc từ
 * "generated interface" do sourcekitd sinh tại chỗ (request
 * source.request.editor.open.interface) — cùng thứ hiện ra khi Cmd-click 1 API.
 *
 * Ở đây ta sinh đúng file đó, cache ra đĩa 1 lần/module, rồi rg/đọc TRỰC TIẾP
 * trên nó như mọi file SDK khác. Không index, không database: cache chỉ là
 * source Swift thuần, mọi logic convert/analyzeContext giữ nguyên.
 */

const SDK_NAMES: Record<SdkPlatform, string> = {
  ios: 'iphoneos',
  watchos: 'watchos',
  macos: 'macosx',
  tvos: 'appletvos',
  xros: 'xros',
};

/** Arch dùng để sinh interface. watchOS 64-bit là arm64_32. */
const TRIPLE_PREFIX: Record<SdkPlatform, string> = {
  ios: 'arm64-apple-ios',
  watchos: 'arm64_32-apple-watchos',
  macos: 'arm64-apple-macos',
  tvos: 'arm64-apple-tvos',
  xros: 'arm64-apple-xros',
};

const versionCache = new Map<SdkPlatform, string | null>();

/** Version SDK ("26.2") qua xcrun; null nếu platform không cài. */
function sdkVersion(platform: SdkPlatform): string | null {
  if (versionCache.has(platform)) return versionCache.get(platform)!;
  let v: string | null = null;
  try {
    v = execFileSync('xcrun', ['--sdk', SDK_NAMES[platform], '--show-sdk-version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    v = null;
  }
  versionCache.set(platform, v);
  return v;
}

function targetTriple(platform: SdkPlatform): string | null {
  const v = sdkVersion(platform);
  if (!v) return null;
  const [maj, min = '0'] = v.split('.');
  return `${TRIPLE_PREFIX[platform]}${maj}.${min}`;
}

/** Build của Xcode (17C52...) — đổi Xcode là cache key đổi, không stale. */
let xcodeBuild: string | null = null;
function buildKey(): string {
  if (xcodeBuild) return xcodeBuild;
  let key = 'unknown';
  try {
    const plist = fs.readFileSync('/Applications/Xcode.app/Contents/version.plist', 'utf-8');
    const m = plist.match(/<key>ProductBuildVersion<\/key>\s*<string>([^<]+)<\/string>/);
    if (m) key = m[1];
  } catch { /* giữ unknown */ }
  xcodeBuild = key;
  return key;
}

export function cacheRoot(): string {
  return (
    process.env.IOS_SDK_MCP_CACHE ??
    path.join(os.homedir(), '.cache', 'ios-sdk-mcp', buildKey())
  );
}

/** MỘT thư mục cho MỖI framework — bắt buộc, không phải cho đẹp.
 * rg nhận DANH SÁCH THƯ MỤC (sdk.ts toDirs), không phải danh sách file. Nếu gom
 * mọi framework vào chung 1 dir thì query lọc framework=SwiftUI sẽ quét trúng
 * UIKit.swift nằm cạnh -> get_new_apis/grep_sdk trả sai framework. */
export function ifacePath(framework: string, platform: SdkPlatform): string {
  return path.join(cacheRoot(), platform, framework, `${framework}.swift`);
}

/** Path tới script sinh interface (cạnh dist/ hoặc src/). */
function scriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [
    path.join(here, '..', 'scripts', 'gen-iface.py'),
    path.join(here, '..', '..', 'scripts', 'gen-iface.py'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('gen-iface.py not found');
}

/** Module đã thử sinh và FAIL -> không thử lại (tránh spawn python mỗi query). */
const failed = new Set<string>();
/** Đang sinh -> chia sẻ promise (nhiều tool hỏi cùng framework 1 lúc). */
const inFlight = new Map<string, Promise<string | null>>();

export function ifaceCached(framework: string, platform: SdkPlatform): string | null {
  const p = ifacePath(framework, platform);
  try {
    // File rỗng = lần sinh trước chết giữa chừng -> coi như chưa có.
    return fs.statSync(p).size > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Đảm bảo có generated interface của `framework` cho `platform`.
 * Trả path file cache, hoặc null nếu module không sinh được (ObjC-only,
 * framework không tồn tại trên platform đó, sourcekitd lỗi).
 */
export async function ensureIface(
  framework: string,
  platform: SdkPlatform,
): Promise<string | null> {
  const key = `${platform}/${framework}`;
  if (failed.has(key)) return null;
  const hit = ifaceCached(framework, platform);
  if (hit) return hit;
  const running = inFlight.get(key);
  if (running) return running;

  const job = (async (): Promise<string | null> => {
    const triple = targetTriple(platform);
    const sdk = SDK_PATHS[platform];
    if (!triple || !fs.existsSync(sdk)) {
      failed.add(key);
      return null;
    }
    const out = ifacePath(framework, platform);
    try {
      await execFileAsync(
        'python3',
        [scriptPath(), framework, triple, sdk, out],
        { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
      );
      return ifaceCached(framework, platform);
    } catch {
      failed.add(key);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/**
 * Thay file Swift nguồn bằng generated interface ĐÃ cache (không sinh mới).
 * Nhiều .swiftinterface (arm64 + arm64e) của cùng framework gộp về 1 file cache
 * -> dedup luôn, rg quét ít hơn.
 */
export function withCachedIfaces(files: SdkFile[]): SdkFile[] {
  const out: SdkFile[] = [];
  const takenIface = new Set<string>();
  for (const f of files) {
    if (f.lang !== 'swift') {
      out.push(f);
      continue;
    }
    const cached = ifaceCached(f.framework, f.platform);
    if (!cached) {
      out.push(f);
      continue;
    }
    if (takenIface.has(cached)) continue;
    takenIface.add(cached);
    out.push({ ...f, path: cached });
  }
  return out;
}

/** Sinh interface cho mọi framework Swift trong `files` (dùng cho prewarm). */
export async function ensureIfacesFor(
  files: SdkFile[],
  concurrency = 4,
): Promise<{ framework: string; platform: SdkPlatform; ok: boolean }[]> {
  const jobs = new Map<string, { framework: string; platform: SdkPlatform }>();
  for (const f of files) {
    if (f.lang !== 'swift') continue;
    jobs.set(`${f.platform}/${f.framework}`, { framework: f.framework, platform: f.platform });
  }
  const queue = [...jobs.values()];
  const results: { framework: string; platform: SdkPlatform; ok: boolean }[] = [];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const p = await ensureIface(job.framework, job.platform);
      results.push({ ...job, ok: p !== null });
    }
  });
  await Promise.all(workers);
  return results;
}

/** Path này có nằm trong cache không (read_source cho phép đọc). */
export function isCachePath(p: string): boolean {
  return path.resolve(p).startsWith(path.resolve(cacheRoot()));
}
