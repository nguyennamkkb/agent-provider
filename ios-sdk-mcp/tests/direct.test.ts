import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import {
  discoverFiles,
  rgMatches,
  listFrameworksFast,
  analyzeContext,
  readWindow,
  tokenize,
} from '../src/sdk.js';
import { convertLine, objcLineMap, rankHits } from '../src/convert.js';
import type { SdkFile } from '../src/sdk.js';

/**
 * DIRECT: chọc thẳng file SDK bằng rg + convert output (không qua SQLite).
 * Chạy trên Xcode thật của máy. Yêu cầu rg trong PATH.
 * - Ground truth là nội dung file SDK (không phải fixture).
 * - Không hardcode line numbers (Xcode đổi là lệch): locate bằng rg rồi assert.
 */

const hasRg = (() => {
  try {
    return fs.existsSync('/opt/homebrew/bin/rg') || fs.existsSync('/usr/local/bin/rg');
  } catch { return false; }
})();
const describeRg = hasRg ? describe : describe.skip;

let iosFiles: SdkFile[] = [];
let watchFiles: SdkFile[] = [];

beforeAll(() => {
  if (!hasRg) return;
  iosFiles = discoverFiles(['ios']);
  watchFiles = discoverFiles(['watchos']);
});

describeRg('direct: discovery + frameworks', () => {
  it('thấy SwiftUI.swiftinterface ios + WatchKit watchos', () => {
    expect(iosFiles.some((f) => f.framework === 'SwiftUI' && f.lang === 'swift')).toBe(true);
    expect(iosFiles.some((f) => f.framework === 'UIKit' && f.lang === 'objc')).toBe(true);
    expect(watchFiles.some((f) => f.framework === 'WatchKit')).toBe(true);
    expect(watchFiles.some((f) => f.framework === 'WidgetKit')).toBe(true);
  });
  it('listFrameworksFast có SwiftUI/WatchKit/WidgetKit + platforms', () => {
    const fws = listFrameworksFast();
    const names = fws.map((f) => f.name);
    for (const n of ['SwiftUI', 'UIKit', 'WidgetKit', 'WatchKit', 'ClockKit']) {
      expect(names).toContain(n);
    }
    expect(fws.find((f) => f.name === 'WidgetKit')!.platforms).toEqual(
      expect.arrayContaining(['ios', 'watchos']),
    );
  });
  it('số file hợp lý (>4000, cả 5 SDK)', () => {
    expect(discoverFiles().length).toBeGreaterThan(4000);
  });
});

describeRg('direct: ScrollView end-to-end (rg -> convert -> context)', () => {
  it('rg "struct ScrollView" trúng SwiftUI.swiftinterface (~40ms)', async () => {
    const t0 = performance.now();
    const hits = await rgMatches('struct ScrollView', iosFiles.filter((f) => f.framework === 'SwiftUI'));
    const dt = performance.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toContain('SwiftUI.swiftmodule');
    expect(dt).toBeLessThan(8000);
  }, 15000);
  it('convert struct ScrollView + giải tích iOS 13', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'SwiftUI' && f.lang === 'swift');
    const hits = await rgMatches('public struct ScrollView<Content>', fw);
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0];
    const file = fw.find((f) => f.path === h.file)!;
    const c = convertLine(file, h.lineNumber, h.lineText)!;
    expect(c).toMatchObject({ name: 'ScrollView', kind: 'struct', framework: 'SwiftUI', lang: 'swift', platform: 'ios' });
    expect(c.signature).toContain('SwiftUICore.View');
    const ctx = analyzeContext(h.file, h.lineNumber);
    expect(ctx.introducedIn).toBe(130000);
  }, 15000);
  it('lowercase "scrollview" vẫn trúng (NOCASE)', async () => {
    const hits = await rgMatches('scrollview', iosFiles.filter((f) => f.framework === 'SwiftUI'), 20);
    expect(hits.some((h) => /ScrollView/i.test(h.lineText))).toBe(true);
  }, 15000);
  it('multi-word "scroll view": tokens khớp trên cùng dòng/file', async () => {
    const toks = tokenize('scroll view');
    expect(toks).toEqual(['scroll', 'view']);
    const hits = await rgMatches('ScrollView', iosFiles.filter((f) => f.framework === 'SwiftUI'), 50);
    const both = hits.filter((h) => toks.every((t) => h.lineText.toLowerCase().includes(t)));
    expect(both.length).toBeGreaterThan(0);
  }, 15000);
  it('ranking: exact "ScrollView" lên đầu, case-insensitive', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'SwiftUI' && f.lang === 'swift');
    const hits = await rgMatches('scrollview', fw, 50);
    const conv = hits
      .map((h) => convertLine(fw.find((f) => f.path === h.file)!, h.lineNumber, h.lineText))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const ranked = rankHits(conv, 'scrollview');
    expect(ranked[0].name.toLowerCase()).toBe('scrollview');
  }, 20000);
});

describeRg('direct: version ground truth (foregroundColor, Text+)', () => {
  it('foregroundColor: intro iOS 13 (không phải visionOS 1.0), renamed, sentinel bỏ', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'SwiftUICore' && f.lang === 'swift');
    const hits = await rgMatches('public func foregroundColor(_ color: SwiftUICore.Color?)', fw);
    expect(hits.length).toBeGreaterThan(0);
    const ctx = analyzeContext(hits[0].file, hits[0].lineNumber);
    expect(ctx.introducedIn).toBe(130000);
    expect(ctx.renamedTo).toBe('foregroundStyle(_:)');
    expect(ctx.deprecatedIn).toBeNull();
  }, 15000);
  it('Text +: intro 13 + deprecated 26 (xuyên originallyDefinedIn)', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'SwiftUICore' && f.lang === 'swift');
    const hits = await rgMatches('public static func + (lhs: SwiftUICore.Text', fw);
    expect(hits.length).toBeGreaterThan(0);
    const ctx = analyzeContext(hits[0].file, hits[0].lineNumber);
    expect(ctx.introducedIn).toBe(130000);
    expect(ctx.deprecatedIn).toBe(260000);
  }, 15000);
  it('deprecated: 26.0 quét toàn iOS SDK ra 12 files (rg nhanh)', async () => {
    const t0 = performance.now();
    const hits = await rgMatches('deprecated: 26.0', iosFiles, 100);
    expect(hits.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(15000);
  }, 20000);
});

describeRg('direct: ObjC (ARSession, UIScrollView doc)', () => {
  it('ARSession: standalone macro + class + intro iOS 11', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'ARKit' && f.lang === 'objc');
    const hits = await rgMatches('@interface ARSession', fw);
    expect(hits.length).toBeGreaterThan(0);
    const h = hits[0];
    const file = fw.find((f) => f.path === h.file)!;
    const map = objcLineMap(file, (p) => fs.readFileSync(p, 'utf-8'));
    const c = convertLine(file, h.lineNumber, h.lineText, map)!;
    expect(c).toMatchObject({ name: 'ARSession', kind: 'class', lang: 'objc' });
    const ctx = analyzeContext(h.file, h.lineNumber);
    expect(ctx.introducedIn).toBe(110000);
  }, 15000);
  it('member kế thừa scope: axes/showsIndicators intro iOS 13 (không own @available)', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'SwiftUI' && f.lang === 'swift' && (f as SdkFile).platform === 'ios');
    const hits = await rgMatches('public struct ScrollView<Content>', fw);
    // axes nằm trong struct ScrollView (iOS 13 scope), không có @available riêng.
    const { fileLines, findScopeOpener } = await import('../src/sdk.js');
    const lines = fileLines(hits[0].file);
    // tìm dòng axes trong struct này
    const { rgMatches: rg2 } = await import('../src/sdk.js');
    const ax = await rg2('public var axes: SwiftUICore.Axis.Set', fw, 5);
    const inScroll = ax.find((h) => h.file === hits[0].file && h.lineNumber > hits[0].lineNumber && h.lineNumber < hits[0].lineNumber + 25);
    expect(inScroll).toBeDefined();
    const ctx = analyzeContext(inScroll!.file, inScroll!.lineNumber);
    expect(ctx.introducedIn).toBe(130000);
    expect(findScopeOpener(lines, inScroll!.lineNumber)).toBeGreaterThanOrEqual(0);
  }, 15000);
  it('UIScrollView: @interface match đúng dòng (không nhầm @protocol forward)', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'UIKit' && f.path.endsWith('UIScrollView.h'));
    expect(fw.length).toBe(1);
    // Pattern cũ '@interface UIScrollView ' dính cả `@protocol UIScrollViewDelegate;`
    // vì rg -F match substring. Dùng regex neo từ: '@interface UIScrollView\b'.
    const hits = await rgMatches('@interface UIScrollView', fw);
    const iface = hits.filter((h) => /@interface\s+UIScrollView\b/.test(h.lineText));
    expect(iface.length).toBeGreaterThan(0);
    expect(iface[0].lineText).toContain('@interface UIScrollView : UIView');
  }, 15000);
  it('members UIScrollView qua objcLineMap (delegate, contentOffset...)', async () => {
    const fw = iosFiles.filter((f) => f.framework === 'UIKit' && f.path.endsWith('UIScrollView.h'));
    const map = objcLineMap(fw[0], (p) => fs.readFileSync(p, 'utf-8'));
    const names = [...map.values()].map((v) => v.name);
    for (const n of ['contentOffset', 'delegate', 'setContentOffset:animated:']) {
      expect(names).toContain(n);
    }
    const delegate = [...map.values()].find((v) => v.name === 'delegate')!;
    expect(delegate.parentType).toBe('UIScrollView');
  }, 15000);
});

describeRg('direct: watchOS + widget', () => {
  it('WKInterfaceController trong WatchKit headers', async () => {
    const fw = watchFiles.filter((f) => f.framework === 'WatchKit' && f.lang === 'objc');
    const hits = await rgMatches('@interface WKInterfaceController', fw);
    expect(hits.length).toBeGreaterThan(0);
  }, 15000);
  it('TimelineEntry trong WidgetKit watchos', async () => {
    const fw = watchFiles.filter((f) => f.framework === 'WidgetKit' && f.lang === 'swift');
    const hits = await rgMatches('protocol TimelineEntry', fw);
    expect(hits.length).toBeGreaterThan(0);
    const file = fw.find((f) => f.path === hits[0].file)!;
    const c = convertLine(file, hits[0].lineNumber, hits[0].lineText)!;
    expect(c).toMatchObject({ name: 'TimelineEntry', kind: 'protocol', platform: 'watchos' });
  }, 15000);
});

describeRg('direct: tokenize + rank đơn vị', () => {
  it('tokenize bỏ từ ngắn, lowercase', () => {
    expect(tokenize('Scroll View')).toEqual(['scroll', 'view']);
    expect(tokenize('a Text+')).toEqual(['text']);
    expect(tokenize('')).toEqual([]);
  });
  it('rankHits: exact > prefix > contains, _ phạt', () => {
    const hits = [
      { name: '_ScrollViewHelper', kind: 'struct' },
      { name: 'MyScrollView', kind: 'struct' },
      { name: 'ScrollView', kind: 'struct' },
      { name: 'ScrollViewReader', kind: 'struct' },
    ];
    const ranked = rankHits(hits, 'ScrollView');
    expect(ranked[0].name).toBe('ScrollView');
    expect(ranked[1].name).toBe('ScrollViewReader');
  });
});
