import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SdkIndexer } from './indexer.js';

let tmp: string;
let indexer!: SdkIndexer;

const SWIFT_FIXTURE = `@available(iOS 18.0, macOS 15.0, *)
extension Greeter {
  nonisolated public func greet(name: Swift.String) -> Swift.String
  @available(iOS 16.0, macOS 13.0, *)
  nonisolated public func greetFormal(name: Swift.String) -> Swift.String
}
@available(iOS, introduced: 13.0, deprecated: 17.0, renamed: "Greeter")
public struct OldGreeter {
  public init()
}
`;

const OBJC_FIXTURE = `// Greets people.
@interface Greeter : NSObject
// Says hello.
- (NSString *)greet:(NSString *)name API_AVAILABLE(ios(13.0));
- (void)oldMethod API_DEPRECATED_WITH_REPLACEMENT("greet:", ios(13.0, 17.0));
@end
typedef NS_ENUM(NSInteger, GreetStyle) {
  GreetStyleCasual = 0,
  GreetStyleFormal API_AVAILABLE(ios(16.0)),
};
`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-test-'));
  const modDir = path.join(tmp, 'System/Library/Frameworks/TestFW.framework/Modules/TestFW.swiftmodule');
  const hdrDir = path.join(tmp, 'System/Library/Frameworks/TestFW.framework/Headers');
  fs.mkdirSync(modDir, { recursive: true });
  fs.mkdirSync(hdrDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'arm64e-apple-ios.swiftinterface'), SWIFT_FIXTURE);
  fs.writeFileSync(path.join(hdrDir, 'TestFW.h'), OBJC_FIXTURE);

  indexer = await SdkIndexer.create();
  indexer.buildIndex(tmp);
  indexer.loadDocsFromMarkdown('## Greeter Guide\nUse `greet(name:)` to say hello.\n### Advanced\nFormal style needs iOS 16.', 'test.md');
});

afterAll(() => {
  indexer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('indexer integration (fixture SDK)', () => {
  it('indexes swift + objc symbols', () => {
    const stats = indexer.getStats();
    expect(stats.totalSymbols).toBeGreaterThanOrEqual(10);
    expect(stats.totalFrameworks).toBe(1);
    expect(stats.symbolsByLang.find((l) => l.lang === 'swift')!.count).toBeGreaterThan(0);
    expect(stats.symbolsByLang.find((l) => l.lang === 'objc')!.count).toBeGreaterThan(0);
  });
  it('version coverage reflects annotated decls; unannotated stay UNKNOWN', () => {
    expect(indexer.getStats().versionCoverage).toBeGreaterThanOrEqual(70);
    // Decls without any availability annotation must stay UNKNOWN (honest data).
    // Note: 'Greeter' exists twice (Swift extension @iOS18 + ObjC class unannotated),
    // so check via lang-filtered search instead of getDetail.
    for (const n of ['GreetStyle', 'GreetStyleCasual']) {
      expect(indexer.getDetail(n)!.introducedIn).toBe(999999);
    }
    const objcGreeter = indexer.search('Greeter', 'TestFW').find((x) => x.lang === 'objc');
    expect(objcGreeter!.introducedIn).toBe(999999);
  });
  it('exact-name search ranks first', () => {
    const r = indexer.search('greet');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].name.toLowerCase()).toContain('greet');
  });
  it('framework filter works', () => {
    expect(indexer.search('greet', 'Nope')).toHaveLength(0);
    expect(indexer.search('greet', 'TestFW').length).toBeGreaterThan(0);
  });
  it('kind filter works', () => {
    const r = indexer.search('Greet', 'TestFW', undefined, 'case');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.kind === 'case')).toBe(true);
  });
  it('getDetail exact then fallback', () => {
    const d = indexer.getDetail('GreetStyleFormal');
    expect(d).toMatchObject({ kind: 'case', parentType: 'GreetStyle', introducedIn: 160000 });
    expect(indexer.getDetail('NoSuchApi_xyz')).toBeNull();
  });
  it('getDetail carries members + memberCount so agent knows what to explore', () => {
    const d = indexer.getDetail('Greeter', 'TestFW')!;
    expect(d.memberCount).toBeGreaterThan(0);
    expect(d.members.map((x) => x.name)).toContain('greet');
    // leaf API (no members) reports empty honestly
    expect(indexer.getDetail('GreetStyleFormal')!.members).toHaveLength(0);
    expect(indexer.getDetail('GreetStyleFormal')!.memberCount).toBe(0);
  });
  it('getDetail resolves renamedTo target', () => {
    const d = indexer.getDetail('oldMethod', 'TestFW')!;
    expect(d.renamedTo).toBe('greet:');
    expect(d.renamedToDetail).toMatchObject({ name: 'greet:' });
  });
  it('objc doc comment captured', () => {
    const d = indexer.getDetail('greet:');
    expect(d!.docComment).toContain('Says hello.');
  });
  it('getTypeMembers lists extension members', () => {
    const m = indexer.getTypeMembers('Greeter');
    const names = m.map((x) => x.name);
    expect(names).toContain('greet');
    expect(names).toContain('greetFormal');
  });
  it('getTypeMembers matches qualified name, excludes extension rows', () => {
    const shortM = indexer.getTypeMembers('Greeter');
    const qualifiedM = indexer.getTypeMembers('TestFW.Greeter');
    expect(qualifiedM.map((x) => x.name).sort()).toEqual(shortM.map((x) => x.name).sort());
    expect(shortM.every((x) => x.kind !== 'extension')).toBe(true);
    expect(shortM[0]).toMatchObject({ framework: 'TestFW', parentType: 'Greeter' });
  });
  it('multi-version: availability filter keeps UNKNOWN, drops newer APIs', () => {
    // greetFormal is iOS 16, GreetStyleFormal is iOS 16, GreetStyle* unannotated (UNKNOWN).
    const at16 = indexer.search('Greet', 'TestFW', 160000).map((x) => x.name);
    expect(at16).toContain('greetFormal');
    expect(at16).toContain('GreetStyle'); // UNKNOWN always visible
    const at15 = indexer.search('Greet', 'TestFW', 150000).map((x) => x.name);
    expect(at15).not.toContain('greetFormal');
    expect(at15).toContain('GreetStyle'); // UNKNOWN still visible
    // iOS 18-only Swift extension member hidden at 15, visible at 18.
    expect(indexer.search('greet', 'TestFW', 150000).map((x) => x.name)).not.toContain('greet');
    expect(indexer.search('greet', 'TestFW', 180000).map((x) => x.name)).toContain('greet');
  });
  it('multi-version: getNewApis pins exact version', () => {
    expect(indexer.getNewApis(160000, 'TestFW').every((x) => x.introducedIn === 160000)).toBe(true);
    expect(indexer.getNewApis(160000, 'TestFW').length).toBeGreaterThan(0);
    expect(indexer.getNewApis(150000, 'TestFW')).toHaveLength(0);
  });
  it('multi-version: deprecated visible only at/after deprecation version', () => {
    expect(indexer.getDeprecated(160000, 'TestFW').find((x) => x.name === 'oldMethod')).toBeUndefined();
    expect(indexer.getDeprecated(170000, 'TestFW').find((x) => x.name === 'oldMethod')).toMatchObject({
      renamedTo: 'greet:',
    });
  });
  it('getNewApis finds iOS 18 API', () => {
    const n = indexer.getNewApis(180000, 'TestFW');
    expect(n.length).toBeGreaterThan(0);
    expect(n.every((x) => x.introducedIn === 180000)).toBe(true);
  });
  it('getDeprecated finds renamed API', () => {
    const d = indexer.getDeprecated(170000, 'TestFW');
    const old = d.find((x) => x.name === 'oldMethod');
    expect(old).toMatchObject({ renamedTo: 'greet:', deprecatedIn: 170000 });
  });
  it('getGuide finds docs', () => {
    const g = indexer.getGuide('Greeter');
    expect(g.length).toBeGreaterThan(0);
    expect(g[0].snippet).toContain('greet(name:)');
  });
  it('listFrameworks reports TestFW', () => {
    const f = indexer.listFrameworks();
    expect(f.find((x) => x.name === 'TestFW')!.apiCount).toBeGreaterThan(0);
  });
});
