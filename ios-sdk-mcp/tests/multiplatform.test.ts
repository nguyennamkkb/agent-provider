import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SdkIndexer } from '../src/indexer.js';

/**
 * MULTI-PLATFORM: cùng parser chạy trên SDK khác nhau, gộp bằng cột platform.
 * - search dedup跨platform + platforms[]
 * - detail/members/new/deprecated/frameworks lọc được theo platform
 * - fixture: 2 "SDK" giả (ios + watchos) với WidgetKit/WatchKit thu nhỏ
 */

let tmp: string;
let indexer!: SdkIndexer;

const IOS_FIXTURE = `@available(iOS 14.0, macOS 11.0, watchOS 7.0, *)
public struct Widget : Swift.Sendable {
  public init()
  nonisolated public func title() -> Swift.String
}
@available(watchOS 9.0, *)
public struct WatchOnly {
  public init()
}
`;

const WATCHOS_FIXTURE = `@available(watchOS 9.0, *)
public struct Complication : Swift.Sendable {
  public init()
  nonisolated public func template() -> Swift.String
}
@available(iOS 14.0, macOS 11.0, watchOS 7.0, *)
public struct Widget : Swift.Sendable {
  public init()
  nonisolated public func title() -> Swift.String
}
`;

const WATCH_OBJC = `@interface WKInterfaceController : NSObject
- (void)awakeWithContext:(id)context;
@end
`;

function writeSdk(root: string, platformDir: string, framework: string, swift: string, objc?: string) {
  const modDir = path.join(root, platformDir, `System/Library/Frameworks/${framework}.framework/Modules/${framework}.swiftmodule`);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'test.swiftinterface'), swift);
  if (objc) {
    const hdrDir = path.join(root, platformDir, `System/Library/Frameworks/${framework}.framework/Headers`);
    fs.mkdirSync(hdrDir, { recursive: true });
    fs.writeFileSync(path.join(hdrDir, `${framework}.h`), objc);
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-multi-'));
  writeSdk(tmp, 'ios', 'WidgetKit', IOS_FIXTURE);
  writeSdk(tmp, 'watchos', 'WidgetKit', WATCHOS_FIXTURE);
  writeSdk(tmp, 'watchos', 'WatchKit', '@available(watchOS 2.0, *)\npublic struct WKOnly {\n  public init()\n}\n', WATCH_OBJC);

  indexer = await SdkIndexer.create();
  indexer.buildIndex(path.join(tmp, 'ios'), 'ios');
  indexer.buildIndex(path.join(tmp, 'watchos'), 'watchos');
});

afterAll(() => {
  indexer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('multi-platform: search dedup + platforms[]', () => {
  it('Widget có trên cả 2 platforms, gộp 1 row', () => {
    const r = indexer.search('Widget');
    const widget = r.find((x) => x.name === 'Widget' && x.kind === 'struct')!;
    expect(widget.platforms!.sort()).toEqual(['ios', 'watchos']);
  });
  it('platform filter: WatchOnly chỉ ở ios-index? (parse từ ios SDK)', () => {
    // WatchOnly parse từ ios fixture -> platform=ios (đúng: SDK nào parse ra thì tag SDK đó)
    const r = indexer.search('WatchOnly');
    expect(r[0].platforms).toEqual(['ios']);
  });
  it('Complication chỉ ở watchos', () => {
    const r = indexer.search('Complication');
    expect(r[0].platforms).toEqual(['watchos']);
    expect(indexer.search('Complication', undefined, undefined, undefined, 50, 'ios')).toHaveLength(0);
    expect(indexer.search('Complication', undefined, undefined, undefined, 50, 'watchos').length).toBeGreaterThan(0);
  });
  it('WKInterfaceController (ObjC) chỉ ở watchos', () => {
    const d = indexer.getDetail('WKInterfaceController', 'WatchKit')!;
    expect(d.platform).toBe('watchos');
    expect(d.members.map((x) => x.name)).toContain('awakeWithContext:');
    // platform sai -> null
    expect(indexer.getDetail('WKInterfaceController', 'WatchKit', false, 'ios')).toBeNull();
  });
});

describe('multi-platform: detail/members/frameworks/stats', () => {
  it('detail platform đúng + members cùng platform', () => {
    const iosD = indexer.getDetail('Widget', 'WidgetKit', false, 'ios')!;
    expect(iosD.platform).toBe('ios');
    expect(iosD.members.map((x) => x.name)).toContain('title');
    const wD = indexer.getDetail('Widget', 'WidgetKit', false, 'watchos')!;
    expect(wD.platform).toBe('watchos');
  });
  it('members lọc theo platform', () => {
    expect(indexer.getTypeMembers('Widget', 'WidgetKit', 200, false, 'ios').length).toBeGreaterThan(0);
    expect(indexer.getTypeMembers('Widget', 'WatchKit', 200, false, 'ios')).toHaveLength(0);
  });
  it('listFrameworks có platforms + lọc platform', () => {
    const all = indexer.listFrameworks();
    const wk = all.find((x) => x.name === 'WidgetKit')!;
    expect(wk.platforms.sort()).toEqual(['ios', 'watchos']);
    const watchOnly = indexer.listFrameworks('watchos');
    expect(watchOnly.some((x) => x.name === 'WatchKit')).toBe(true);
    const iosOnly = indexer.listFrameworks('ios');
    expect(iosOnly.some((x) => x.name === 'WatchKit')).toBe(false);
  });
  it('getNewApis lọc platform + version theo SDK (watchOS 9 vs iOS 16 riêng)', () => {
    // introducedIn là version iOS-equivalent của @available đầu tiên parse được;
    // khi có nhiều platform trong 1 @available, iOS được ưu tiên (parseSwiftAvailable).
    // Fixture watchOS-only: watchOS 9.0 -> introducedIn=90000 (không có seg iOS).
    const w = indexer.getNewApis(90000, 'WidgetKit', 'watchos');
    expect(w.some((x) => x.name === 'Complication')).toBe(true);
    expect(indexer.getNewApis(90000, 'WidgetKit', 'ios').some((x) => x.name === 'Complication')).toBe(false);
  });
  it('stats có symbolsByPlatform khớp total', () => {
    const s = indexer.getStats();
    const sum = s.symbolsByPlatform.reduce((a, x) => a + x.count, 0);
    expect(sum).toBe(s.totalSymbols);
    expect(s.symbolsByPlatform.map((x) => x.platform).sort()).toEqual(['ios', 'watchos']);
  });
  it('getDetail fuzzy không lẫn platform khi đã chỉ định', () => {
    // 'Wid' fuzzy không framework nhưng có platform watchos -> vẫn ra Widget watchos
    const d = indexer.getDetail('Wid', undefined, false, 'watchos');
    expect(d).not.toBeNull();
    expect(d!.platform).toBe('watchos');
  });
});
