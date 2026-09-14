import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { SdkIndexer } from '../src/indexer.js';

/**
 * REAL-DB SWEEP: quét DB thật (build từ 5 SDK) để bắt lỗi mà fixture nhỏ
 * không bao giờ thấy: GROUP BY nondeterministic, dedup sai, version drift.
 *
 * Chạy khi có DB: REAL_DB=/tmp/symbols-all.db npx vitest run tests/realdb.test.ts
 * Không có DB -> skip (CI không cần Xcode).
 */

const DB = process.env.REAL_DB ?? '';
const hasDb = DB && fs.existsSync(DB);
const describeDb = hasDb ? describe : describe.skip;

describeDb('realdb: known-answer sweep (Apple ground truth)', () => {
  let idx!: SdkIndexer;
  beforeAllInit();

  function beforeAllInit() {
    // vitest beforeAll can't be conditional easily; init lazily
  }

  it('Text+ deprecated iOS 26, intro iOS 13', async () => {
    idx = await SdkIndexer.create(DB);
    const plus = idx.getTypeMembers('Text', 'SwiftUICore', 200, false, 'ios').find((x) => x.name === '+');
    expect(plus).toBeDefined();
    expect(plus!.introducedIn).toBe(130000);
    expect(plus!.deprecatedIn).toBe(260000);
    idx.close();
  });

  it('foregroundColor intro iOS 13 (khong phai visionOS 1.0)', async () => {
    idx = await SdkIndexer.create(DB);
    const f = idx.getDetail('foregroundColor', 'SwiftUICore');
    expect(f).not.toBeNull();
    expect(f!.introducedIn).toBe(130000);
    expect(f!.renamedTo).toBe('foregroundStyle(_:)');
    idx.close();
  });

  it('getDeprecated(26) thay Text+ (dedup MAX giu version)', async () => {
    idx = await SdkIndexer.create(DB);
    const d = idx.getDeprecated(260000, 'SwiftUICore');
    const plus = d.find((x) => x.name === '+' && (x.parentType ?? '').includes('Text'));
    expect(plus).toBeDefined();
    expect(plus!.deprecatedIn).toBe(260000);
    idx.close();
  });

  it('search dedup: Text+ co deprecatedIn (khong bi row NULL an)', async () => {
    idx = await SdkIndexer.create(DB);
    const r = idx.search('+', 'SwiftUICore').filter((x) => (x.parentType ?? '').includes('Text'));
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].deprecatedIn).toBe(260000);
    idx.close();
  });

  it('WKInterfaceController tren watchos co members', async () => {
    idx = await SdkIndexer.create(DB);
    const m = idx.getTypeMembers('WKInterfaceController', 'WatchKit', 50, false, 'watchos');
    expect(m.length).toBeGreaterThan(10);
    expect(m.map((x) => x.name)).toContain('awakeWithContext:');
    idx.close();
  });

  it('ARSession intro iOS 11 (standalone macro line)', async () => {
    idx = await SdkIndexer.create(DB);
    const d = idx.getDetail('ARSession', 'ARKit', false, 'ios');
    expect(d).not.toBeNull();
    expect(d!.introducedIn).toBe(110000);
    idx.close();
  });

  it('TimelineEntry platforms gom 4 SDK', async () => {
    idx = await SdkIndexer.create(DB);
    const r = idx.search('TimelineEntry', 'WidgetKit');
    expect(r[0].platforms!.sort()).toEqual(['ios', 'macos', 'watchos', 'xros']);
    idx.close();
  });

  it('stats nhat quan: sum(platforms) == total, coverage trong [0,100]', async () => {
    idx = await SdkIndexer.create(DB);
    const s = idx.getStats();
    const sum = s.symbolsByPlatform.reduce((a, x) => a + x.count, 0);
    expect(sum).toBe(s.totalSymbols);
    expect(s.versionCoverage).toBeGreaterThanOrEqual(0);
    expect(s.versionCoverage).toBeLessThanOrEqual(100);
    expect(s.totalSymbols).toBeGreaterThan(900000);
    idx.close();
  });
});

describe('realdb: khong con bare-column GROUP BY (static check)', () => {
  it('moi SELECT co GROUP BY deu dung aggregate cho moi cot', () => {
    const src = fs.readFileSync(new URL('../src/indexer.ts', import.meta.url).pathname, 'utf-8');
    // Chi check SELECT ... FROM symbols ... GROUP BY that (bo qua template ${...}
    // va subquery inner cua getDeprecated - outer cua no da aggregate).
    const queries = [...src.matchAll(/SELECT\s+([\w\s,()*]+?)\s+FROM symbols[\s\S]*?GROUP BY ([^\n`]+)/g)]
      .filter((q) => !q[1].includes('${') && !q[0].includes(') s') && !q[0].includes('${dedup}'));
    // Rieng getDeprecated inner subquery: check tay - moi cot phai co AGG hoac la key.
    const innerMatch = src.match(/FROM \(SELECT ([\s\S]*?)\s+FROM symbols GROUP BY ([^)]+)\) s/);
    expect(innerMatch).not.toBeNull();
    const innerCols = innerMatch![1].split(/,(?![^(]*\))/).map((c) => c.trim()).filter(Boolean);
    const innerKeys = new Set(innerMatch![2].split(',').map((k) => k.trim().toLowerCase()));
    for (const c of innerCols) {
      const hasAgg = /\b(MAX|MIN|GROUP_CONCAT|COUNT|SUM|AVG)\s*\(/i.test(c);
      const colName = (c.match(/(?:as\s+)?(\w+)\s*$/)?.[1] ?? '').toLowerCase();
      expect(hasAgg || innerKeys.has(colName), `bare column trong getDeprecated inner: "${c}"`).toBe(true);
    }
    expect(queries.length).toBeGreaterThan(0);
    // Group keys duoc phep dung tran (chung dinh nghia dedup grain) + cac cot
    // bai GROUP BY don gian (kind/lang/platform + COUNT) la group key luon.
    // NOTE: neu static check nay fail nghia la co query moi them GROUP BY ma
    // quen aggregate -> sua query, khong sua test.
    const allowedKeys = new Set(['name', 'kind', 'framework', 'parent_type', 'signature', 'platform', 'lang']);
    for (const q of queries) {
      const groupKeys = new Set(
        q[2].split(',').map((k) => k.trim().split(/\s+/)[0].toLowerCase()),
      );
      const cols = q[1].split(/,(?![^(]*\))/).map((c) => c.trim()).filter(Boolean);
      for (const c of cols) {
        const hasAgg = /\b(MAX|MIN|GROUP_CONCAT|COUNT|SUM|AVG)\s*\(/i.test(c);
        const colName = (c.match(/(?:as\s+)?(\w+)\s*$/)?.[1] ?? '').toLowerCase();
        const ok = hasAgg || allowedKeys.has(colName) || groupKeys.has(colName);
        expect(ok, `bare column trong GROUP BY query (nondeterministic!): "${c}"`).toBe(true);
      }
    }
  });
});

describe('realdb: getTypeMembers dedup template', () => {
  it('ca 2 nhanh (platform / dedup) deu khong co bare column', () => {
    const src = fs.readFileSync(new URL('../src/indexer.ts', import.meta.url).pathname, 'utf-8');
    // Nhanh platform: moi cot la cot don (khong GROUP BY) -> ok.
    // Nhanh dedup: name/kind/framework la keys; lang/parent_type/signature/
    // availability/introduced_in/deprecated_in phai co AGG.
    const dedupBlock = src.match(/: `name, kind, framework,([\s\S]*?)GROUP_CONCAT[\s\S]*?platforms`/)?.[1] ?? '';
    expect(dedupBlock).not.toBe('');
    for (const agg of ['MAX(lang)', 'MAX(availability)', 'MIN(introduced_in)', 'MAX(deprecated_in)']) {
      expect(dedupBlock.includes(agg), `thieu ${agg} trong dedup template`).toBe(true);
    }
  });
});
