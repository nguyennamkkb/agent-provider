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
