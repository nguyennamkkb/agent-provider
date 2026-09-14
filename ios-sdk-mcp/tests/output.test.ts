import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SdkIndexer } from '../src/indexer.js';

/**
 * Output-contract tests: output phải tốt nhất cho AI Agent đọc.
 * - Gọn (không trường lặp, cap số lượng, size budget)
 * - Đúng version (không bịa availability, sentinel bị loại)
 * - Khám phá được (detail kèm members, renamedTo resolve, ranking exact-first)
 * - Trung thực (null/[] thay vì đoán bừa, UNKNOWN giữ lại khi lọc version)
 * - Deterministic (thứ tự ổn định, JSON serialize được)
 */

let tmp: string;
let indexer!: SdkIndexer;

// Big struct: 25 methods -> kiểm tra cap members 20 trong detail.
const bigMembers = Array.from(
  { length: 25 },
  (_, i) => `  nonisolated public func m${String(i + 1).padStart(2, '0')}() -> Swift.Bool`,
).join('\n');

const SWIFT_FIXTURE = `@available(iOS 18.0, macOS 15.0, *)
public struct Card {
  public init()
  nonisolated public func title() -> Swift.String
  @available(iOS 16.0, macOS 13.0, *)
  nonisolated public func subtitle() -> Swift.String
  nonisolated public func _internalRender() -> Swift.Bool
  public var count: Swift.Int
}
@available(iOS, introduced: 13.0, deprecated: 16.0, renamed: "Card")
public struct OldCard {
  public init()
}
@available(iOS 15.0, *)
public struct Big {
  public init()
${bigMembers}
}
`;

const OBJC_FIXTURE = `// A box for things.
@interface Box : NSObject
// Whether it is open.
@property(nonatomic) BOOL open;
- (void)close;
- (void)_secret;
@end
`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-output-'));
  const modDir = path.join(tmp, 'System/Library/Frameworks/OutFW.framework/Modules/OutFW.swiftmodule');
  const hdrDir = path.join(tmp, 'System/Library/Frameworks/OutFW.framework/Headers');
  fs.mkdirSync(modDir, { recursive: true });
  fs.mkdirSync(hdrDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'arm64e-apple-ios.swiftinterface'), SWIFT_FIXTURE);
  fs.writeFileSync(path.join(hdrDir, 'OutFW.h'), OBJC_FIXTURE);

  indexer = await SdkIndexer.create();
  indexer.buildIndex(tmp);
  indexer.loadDocsFromMarkdown(
    '## Card Guide\nUse `Card` with `title()` for headers.\n### Advanced\n`subtitle()` needs iOS 16.',
    'out.md',
  );
});

afterAll(() => {
  indexer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A. Detail output contract
// ---------------------------------------------------------------------------
describe('output: get_api_detail contract', () => {
  it('detail top-level keys đúng schema, không phình', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    const allowed = new Set([
      'name', 'kind', 'framework', 'module', 'lang', 'signature', 'availability',
      'minIOSVersion', 'introducedIn', 'deprecatedIn', 'obsoletedIn', 'renamedTo',
      'unavailable', 'deprecated', 'parentType', 'docComment', 'filePath',
      'lineNumber', 'members', 'memberCount', 'renamedToDetail',
    ]);
    for (const k of Object.keys(d)) expect(allowed.has(k)).toBe(true);
  });
  it('member rows gọn: chỉ keys cần thiết', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    const allowed = new Set(['name', 'kind', 'signature', 'availability', 'introducedIn', 'deprecatedIn', 'renamedTo']);
    for (const m of d.members) {
      for (const k of Object.keys(m)) expect(allowed.has(k)).toBe(true);
      expect(m).not.toHaveProperty('framework');
      expect(m).not.toHaveProperty('lang');
      expect(m).not.toHaveProperty('parentType');
    }
  });
  it('members trong detail cap 20, memberCount là tổng', () => {
    const d = indexer.getDetail('Big', 'OutFW')!;
    expect(d.members.length).toBeLessThanOrEqual(20);
    expect(d.memberCount).toBe(26); // init + 25 methods
    expect(d.memberCount).toBeGreaterThan(d.members.length);
  });
  it('type nhỏ: memberCount == số members trả về', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    expect(d.memberCount).toBe(d.members.length);
  });
  it('member override giữ availability riêng', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    const sub = d.members.find((x) => x.name === 'subtitle')!;
    expect(sub.availability).toContain('iOS 16.0');
    expect(sub.introducedIn).toBe(160000);
  });
  it('member kế thừa lược availability', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    expect(d.members.find((x) => x.name === 'title')).not.toHaveProperty('availability');
    expect(d.members.find((x) => x.name === 'count')).not.toHaveProperty('availability');
  });
  it('_internal bị lọc mặc định, mở được bằng flag', () => {
    const def = indexer.getDetail('Card', 'OutFW')!;
    expect(def.members.some((x) => x.name.startsWith('_'))).toBe(false);
    const full = indexer.getDetail('Card', 'OutFW', true)!;
    expect(full.members.some((x) => x.name === '_internalRender')).toBe(true);
    expect(full.memberCount).toBeGreaterThan(def.memberCount);
  });
  it('renamedToDetail gọn: không members đệ quy', () => {
    const d = indexer.getDetail('OldCard', 'OutFW')!;
    expect(d.renamedTo).toBe('Card');
    expect(d.renamedToDetail).toMatchObject({ name: 'Card' });
    expect(d.renamedToDetail).not.toHaveProperty('members');
    expect(d.renamedToDetail).not.toHaveProperty('renamedToDetail');
    expect(typeof (d.renamedToDetail as { memberCount: number }).memberCount).toBe('number');
  });
  it('renamedTo không resolve được -> null trung thực', () => {
    // GreetStyleFormal-style leaf: không có renamedTo nên key absent/null
    const d = indexer.getDetail('Card', 'OutFW')!;
    expect(d.renamedTo ?? null).toBeNull();
  });
  it('framework scope miss -> null, không đoán bừa', () => {
    expect(indexer.getDetail('Card', 'NoSuchFW')).toBeNull();
    expect(indexer.getDetail('CardXYZ', 'OutFW')).toBeNull();
  });
  it('không framework: fuzzy vẫn hoạt động', () => {
    expect(indexer.getDetail('Car')).not.toBeNull();
  });
  it('detail JSON serialize được, size có budget', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    const json = JSON.stringify(d);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.length).toBeLessThan(8000);
  });
  it('detail Big (nhiều members) vẫn trong budget', () => {
    const d = indexer.getDetail('Big', 'OutFW')!;
    expect(JSON.stringify(d).length).toBeLessThan(12000);
  });
  it('signature sạch: 1 dòng, không body, không khoảng trắng đôi', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    expect(d.signature).not.toContain('\n');
    expect(d.signature).not.toContain('{');
    expect(d.signature).not.toMatch(/  /);
    for (const m of d.members) {
      expect(m.signature).not.toContain('\n');
      expect(m.signature.length).toBeGreaterThan(0);
    }
  });
  it('docComment: có thì giữ, không thì undefined (không chuỗi rỗng)', () => {
    const box = indexer.getDetail('Box', 'OutFW')!;
    expect(box.docComment).toContain('A box');
    const card = indexer.getDetail('Card', 'OutFW')!;
    expect(card.docComment ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B. Search output contract
// ---------------------------------------------------------------------------
describe('output: search_apis contract', () => {
  it('exact match đứng đầu', () => {
    const r = indexer.search('Card', 'OutFW');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].name).toBe('Card');
  });
  it('limit được tôn trọng', () => {
    expect(indexer.search('a', 'OutFW', undefined, undefined, 2).length).toBeLessThanOrEqual(2);
    expect(indexer.search('a', 'OutFW', undefined, undefined, 200).length).toBeLessThanOrEqual(200);
  });
  it('kind filter nghiêm', () => {
    const r = indexer.search('Card', 'OutFW', undefined, 'struct');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.kind === 'struct')).toBe(true);
  });
  it('framework filter nghiêm', () => {
    expect(indexer.search('Card', 'Nope')).toHaveLength(0);
  });
  it('version filter: UNKNOWN luôn hiện, API mới bị loại', () => {
    // Box (ObjC, không annotation) = UNKNOWN -> hiện ở mọi version
    expect(indexer.search('Box', 'OutFW', 130000).length).toBeGreaterThan(0);
    // subtitle/Card iOS16-18 -> loại ở 15
    const at15 = indexer.search('Card', 'OutFW', 150000).map((x) => x.name);
    expect(at15).not.toContain('subtitle');
    const at18 = indexer.search('Card', 'OutFW', 180000).map((x) => x.name);
    expect(at18).toContain('subtitle');
  });
  it('kết quả có đủ keys, không signature rỗng', () => {
    const r = indexer.search('Card', 'OutFW');
    for (const x of r) {
      expect(x.name.length).toBeGreaterThan(0);
      expect(x.signature.length).toBeGreaterThan(0);
      expect(typeof x.introducedIn).toBe('number');
    }
  });
  it('deterministic: 2 lần gọi cùng thứ tự', () => {
    const a = indexer.search('Card', 'OutFW').map((x) => x.name);
    const b = indexer.search('Card', 'OutFW').map((x) => x.name);
    expect(a).toEqual(b);
  });
  it('không crash với ký tự đặc biệt / injection', () => {
    expect(() => indexer.search(`' OR 1=1 --`, 'OutFW')).not.toThrow();
    expect(() => indexer.search('%_\\', 'OutFW')).not.toThrow();
    expect(() => indexer.search('', 'OutFW')).not.toThrow();
    expect(Array.isArray(indexer.search(`' OR 1=1 --`, 'OutFW'))).toBe(true);
  });
  it('injection LIKE không dump toàn bộ DB', () => {
    const r = indexer.search(`' OR 1=1 --`, 'OutFW');
    expect(r.length).toBeLessThan(10);
  });
  it('JSON serialize được', () => {
    expect(() => JSON.stringify(indexer.search('Card', 'OutFW'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// C. get_type_members contract
// ---------------------------------------------------------------------------
describe('output: get_type_members contract', () => {
  it('loại extension rows + _internal mặc định', () => {
    const m = indexer.getTypeMembers('Card', 'OutFW');
    expect(m.every((x) => x.kind !== 'extension')).toBe(true);
    expect(m.some((x) => x.name.startsWith('_'))).toBe(false);
  });
  it('include_internal mở _internal', () => {
    const m = indexer.getTypeMembers('Card', 'OutFW', 200, true);
    expect(m.some((x) => x.name === '_internalRender')).toBe(true);
  });
  it('ObjC members gắn parentType', () => {
    const m = indexer.getTypeMembers('Box', 'OutFW');
    expect(m.map((x) => x.name)).toEqual(expect.arrayContaining(['open', 'close']));
    expect(m.every((x) => x.parentType === 'Box')).toBe(true);
  });
  it('qualified == short', () => {
    const a = indexer.getTypeMembers('Card', 'OutFW').map((x) => x.name).sort();
    const b = indexer.getTypeMembers('OutFW.Card', 'OutFW').map((x) => x.name).sort();
    expect(b).toEqual(a);
  });
  it('limit được tôn trọng, max 500', () => {
    expect(indexer.getTypeMembers('Big', 'OutFW', 5).length).toBeLessThanOrEqual(5);
    expect(indexer.getTypeMembers('Big', 'OutFW', 9999).length).toBeLessThanOrEqual(500);
  });
  it('sắp xếp ổn định theo kind,name', () => {
    const m = indexer.getTypeMembers('Card', 'OutFW');
    const keys = m.map((x) => `${x.kind}:${x.name}`);
    expect([...keys].sort()).toEqual(keys);
  });
  it('type không tồn tại -> [] (không throw)', () => {
    expect(indexer.getTypeMembers('Nope_XYZ')).toEqual([]);
  });
  it('detail.members là subset của get_type_members', () => {
    const d = indexer.getDetail('Card', 'OutFW')!;
    const full = new Set(indexer.getTypeMembers('Card', 'OutFW', 500).map((x) => x.name));
    for (const m of d.members) expect(full.has(m.name)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Version / deprecation contract
// ---------------------------------------------------------------------------
describe('output: version + deprecation contract', () => {
  it('getNewApis pin đúng version', () => {
    const n = indexer.getNewApis(180000, 'OutFW');
    expect(n.length).toBeGreaterThan(0);
    expect(n.every((x) => x.introducedIn === 180000)).toBe(true);
  });
  it('getNewApis version trống -> []', () => {
    expect(indexer.getNewApis(140000, 'OutFW')).toHaveLength(0);
  });
  it('deprecated chỉ hiện từ version deprecated', () => {
    expect(indexer.getDeprecated(150000, 'OutFW').find((x) => x.name === 'OldCard')).toBeUndefined();
    const d = indexer.getDeprecated(160000, 'OutFW').find((x) => x.name === 'OldCard')!;
    expect(d).toMatchObject({ renamedTo: 'Card', deprecatedIn: 160000 });
  });
  it('không có deprecatedIn sentinel 1 tỷ trong output', () => {
    const all = indexer.getDeprecated(999999999, 'OutFW');
    for (const x of all) {
      if (x.deprecatedIn !== null) expect(x.deprecatedIn).toBeLessThan(990000000);
      if (x.obsoletedIn !== null) expect(x.obsoletedIn).toBeLessThan(990000000);
    }
  });
  it('deprecated rows có đủ trường migrate (renamedTo khi có)', () => {
    const d = indexer.getDeprecated(160000, 'OutFW');
    for (const x of d) {
      expect(typeof x.unavailable).toBe('boolean');
      expect(x.signature.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// E. Guide + stats contract
// ---------------------------------------------------------------------------
describe('output: get_guide + get_sdk_stats contract', () => {
  it('guide trả snippet gọn (<=3000 chars), đúng chủ đề', () => {
    const g = indexer.getGuide('Card');
    expect(g.length).toBeGreaterThan(0);
    expect(g[0].snippet.length).toBeLessThanOrEqual(3000);
    expect(g[0].snippet.length).toBeGreaterThan(0);
    expect(g[0].topic.length).toBeGreaterThan(0);
  });
  it('guide miss -> [] (không throw)', () => {
    expect(indexer.getGuide('ZZZ_NO_MATCH_XYZ')).toEqual([]);
  });
  it('guide limit được tôn trọng', () => {
    expect(indexer.getGuide('Card', 1).length).toBeLessThanOrEqual(1);
  });
  it('stats nhất quán nội bộ', () => {
    const s = indexer.getStats();
    const byKind = s.symbolsByKind.reduce((a, x) => a + x.count, 0);
    const byLang = s.symbolsByLang.reduce((a, x) => a + x.count, 0);
    expect(byKind).toBe(s.totalSymbols);
    expect(byLang).toBe(s.totalSymbols);
    expect(s.versionCoverage).toBeGreaterThanOrEqual(0);
    expect(s.versionCoverage).toBeLessThanOrEqual(100);
    expect(s.deprecatedCount).toBeLessThanOrEqual(s.totalSymbols);
    expect(s.totalFrameworks).toBe(1);
  });
  it('stats JSON serialize được', () => {
    expect(() => JSON.stringify(indexer.getStats())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F. AI workflow end-to-end (search -> detail -> members -> migrate)
// ---------------------------------------------------------------------------
describe('output: AI workflow end-to-end', () => {
  it('search Card -> detail -> members -> guide khép kín', () => {
    const hits = indexer.search('Card', 'OutFW');
    expect(hits[0].name).toBe('Card');
    const d = indexer.getDetail(hits[0].name, 'OutFW')!;
    expect(d.memberCount).toBeGreaterThan(0);
    expect(d.members.length).toBeGreaterThan(0);
    const g = indexer.getGuide(hits[0].name);
    expect(g.length).toBeGreaterThan(0);
  });
  it('deprecated workflow: OldCard -> renamedTo Card resolve được', () => {
    const d = indexer.getDetail('OldCard', 'OutFW')!;
    expect(d.renamedTo).toBe('Card');
    const target = indexer.getDetail(d.renamedTo!, 'OutFW')!;
    expect(target.name).toBe('Card');
    expect(target.deprecated ?? false).toBe(false);
  });
  it('version workflow: Card dùng được ở iOS 18, subtitle cần iOS 16+ vẫn OK ở 18', () => {
    const at18 = indexer.search('Card', 'OutFW', 180000);
    expect(at18.map((x) => x.name)).toEqual(expect.arrayContaining(['Card', 'subtitle']));
    // nhưng OldCard đã deprecated ở 16 -> getDeprecated(160000) thấy nó
    expect(indexer.getDeprecated(160000, 'OutFW').some((x) => x.name === 'OldCard')).toBe(true);
  });
});
