import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Cache riêng cho test: không đụng cache thật của user, và xoá được.
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-sdk-mcp-test-'));
process.env.IOS_SDK_MCP_CACHE = CACHE;

const { ensureIface, ifaceCached, withCachedIfaces, isCachePath } = await import('../src/iface.js');
const { discoverFiles, analyzeContext, fileLines } = await import('../src/sdk.js');

const hasXcode = fs.existsSync('/Applications/Xcode.app/Contents/Developer');

describe.skipIf(!hasXcode)('generated interface = nguồn doc của Swift', () => {
  let ifacePath: string | null = null;

  beforeAll(async () => {
    ifacePath = await ensureIface('SwiftUI', 'ios');
  }, 120_000);

  it('sinh được file interface cho SwiftUI/ios', () => {
    expect(ifacePath).toBeTruthy();
    expect(isCachePath(ifacePath!)).toBe(true);
    // Xcode hiển thị ~144k dòng cho SwiftUI: chặn dưới rộng để không giòn
    // theo version SDK, nhưng đủ để bắt lỗi "sinh ra file cụt".
    expect(fileLines(ifacePath!).length).toBeGreaterThan(50_000);
  });

  it('có decl kèm doc comment (thứ .swiftinterface KHÔNG có)', () => {
    const lines = fileLines(ifacePath!);
    // Generated interface Xcode 27: prefix `nonisolated ` trước struct.
    const idx = lines.findIndex((l) => /^(nonisolated )?public struct ScrollView<Content>/.test(l));
    expect(idx).toBeGreaterThan(0);
    const ctx = analyzeContext(ifacePath!, idx + 1);
    // Abstract phải nằm ở ĐẦU doc (lookback đủ dài, không bị cắt mất).
    expect(ctx.docComment?.startsWith('A scrollable view.')).toBe(true);
    expect(ctx.docComment).toContain('defaultScrollAnchor');
    expect(ctx.introducedIn).toBe(130000);
  });

  it('member cũng có doc riêng', () => {
    const lines = fileLines(ifacePath!);
    const declIdx = lines.findIndex((l) => /^(nonisolated )?public struct ScrollView<Content>/.test(l));
    const memberIdx = lines.findIndex(
      (l, i) => i > declIdx && /\bvar axes: Axis\.Set/.test(l),
    );
    expect(memberIdx).toBeGreaterThan(declIdx);
    const ctx = analyzeContext(ifacePath!, memberIdx + 1);
    // Văn bản Apple đổi theo SDK: Xcode 27 là "The scrollable axes..." (trước đây "scrollable axes").
    expect(ctx.docComment).toMatch(/axes.*scrollable|scrollable.*axes/i);
  });

  it('.swiftinterface gốc KHÔNG có doc (lý do tồn tại của iface.ts)', () => {
    const raw = discoverFiles(['ios']).find(
      (f) => f.framework === 'SwiftUI' && f.lang === 'swift' && f.path.endsWith('.swiftinterface'),
    );
    expect(raw).toBeTruthy();
    const lines = fileLines(raw!.path);
    // Generated interface Xcode 27: prefix `nonisolated ` trước struct.
    const idx = lines.findIndex((l) => /(nonisolated )?public struct ScrollView</.test(l));
    expect(idx).toBeGreaterThan(0);
    expect(analyzeContext(raw!.path, idx + 1).docComment).toBeUndefined();
  });

  it('withCachedIfaces đổi nguồn Swift sang cache, giữ nguyên ObjC', () => {
    const files = discoverFiles(['ios']).filter(
      (f) => f.framework === 'SwiftUI' || f.framework === 'UIKit',
    );
    const swapped = withCachedIfaces(files);
    const swiftUi = swapped.filter((f) => f.framework === 'SwiftUI' && f.lang === 'swift');
    expect(swiftUi.length).toBe(1); // arm64 + arm64e gộp về 1 file cache
    expect(swiftUi[0].path).toBe(ifaceCached('SwiftUI', 'ios'));
    const headers = swapped.filter((f) => f.lang === 'objc');
    expect(headers.every((f) => f.path.startsWith('/Applications/Xcode.app/'))).toBe(true);
  });

  it('module không tồn tại -> null, không ném', async () => {
    expect(await ensureIface('NoSuchFrameworkXYZ', 'ios')).toBeNull();
  }, 60_000);
});
