import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { parseSwiftInterface, parseObjCHeader, UNKNOWN_VERSION } from './parser.js';
import type {
  ApiDetail,
  ApiSymbol,
  DeprecatedApi,
  DocGuide,
  FrameworkInfo,
  ParsedSymbol,
  SearchResult,
  TypeMember,
} from './types.js';

export const SCHEMA_VERSION = 3;

/** SDK roots inside Xcode.app, in index order. */
export const SDK_PATHS: Record<string, string> = {
  ios: '/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk',
  watchos: '/Applications/Xcode.app/Contents/Developer/Platforms/WatchOS.platform/Developer/SDKs/WatchOS.sdk',
  macos: '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
  tvos: '/Applications/Xcode.app/Contents/Developer/Platforms/AppleTVOS.platform/Developer/SDKs/AppleTVOS.sdk',
  xros: '/Applications/Xcode.app/Contents/Developer/Platforms/XROS.platform/Developer/SDKs/XROS.sdk',
};

function rowToSymbol(r: unknown[], cols: string[]): ApiSymbol {
  const c: Record<string, unknown> = {};
  cols.forEach((k, i) => (c[k] = r[i]));
  const str = (v: unknown) => (v != null ? String(v) : undefined);
  return {
    name: String(c['name']),
    kind: c['kind'] as ApiSymbol['kind'],
    framework: String(c['framework']),
    module: String(c['module']),
    lang: c['lang'] === 'objc' ? 'objc' : 'swift',
    platform: (str(c['platform']) ?? 'ios') as ApiSymbol['platform'],
    signature: String(c['signature']),
    availability: String(c['availability'] ?? ''),
    minIOSVersion: Number(c['introduced_in']),
    introducedIn: Number(c['introduced_in']),
    deprecatedIn: c['deprecated_in'] != null ? Number(c['deprecated_in']) : null,
    obsoletedIn: c['obsoleted_in'] != null ? Number(c['obsoleted_in']) : null,
    renamedTo: str(c['renamed_to']),
    unavailable: Number(c['unavailable']) === 1,
    deprecated: Number(c['deprecated']) === 1,
    parentType: str(c['parent_type']),
    docComment: str(c['doc_comment']),
    filePath: String(c['file_path']),
    lineNumber: Number(c['line_number']),
  };
}
const SYMBOL_COLS =
  'id, name, kind, framework, module, lang, platform, signature, availability, introduced_in, deprecated_in, obsoleted_in, renamed_to, unavailable, deprecated, parent_type, doc_comment, file_path, line_number'.split(', ');

function rowToSearch(r: unknown[]): SearchResult {
  return {
    name: String(r[0]),
    kind: String(r[1]),
    framework: String(r[2]),
    lang: String(r[9] ?? ''),
    platforms: String(r[10] ?? '')
      .split(',')
      .filter(Boolean) as SearchResult['platforms'],
    parentType: r[3] != null ? String(r[3]) : undefined,
    signature: String(r[4]),
    availability: String(r[5] ?? ''),
    introducedIn: Number(r[6]),
    deprecatedIn: r[7] != null ? Number(r[7]) : null,
    renamedTo: r[8] != null ? String(r[8]) : undefined,
  };
}

/** Extra WHERE fragment for platform filter. */
function platformFilter(platform?: string): { sql: string; params: (string | number)[] } {
  if (!platform) return { sql: '', params: [] };
  return { sql: ` AND platform = ?`, params: [platform] };
}

export class SdkIndexer {
  private db!: Database;

  static async create(dbPath?: string): Promise<SdkIndexer> {
    const SQL = await initSqlJs();
    const indexer = new SdkIndexer();
    if (dbPath && fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      indexer.db = new SQL.Database(buffer);
    } else {
      indexer.db = new SQL.Database();
    }
    indexer.ensureSchema();
    return indexer;
  }

  private ensureSchema() {
    const meta = this.db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`,
    );
    let version = 0;
    if (meta.length > 0) {
      try {
        const v = this.db.exec(`SELECT v FROM meta WHERE k='schema_version'`);
        if (v.length > 0 && v[0].values.length > 0) version = Number(v[0].values[0][0]);
      } catch {
        version = 0;
      }
    }
    if (version !== SCHEMA_VERSION) {
      this.db.run(`DROP TABLE IF EXISTS symbols`);
      this.db.run(`DROP TABLE IF EXISTS docs`);
      this.db.run(`DROP TABLE IF EXISTS meta`);
      this.createTables();
      this.db.run(`INSERT INTO meta (k, v) VALUES ('schema_version', ?)`, [SCHEMA_VERSION]);
    }
  }

  private createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        framework TEXT NOT NULL,
        module TEXT NOT NULL,
        lang TEXT NOT NULL DEFAULT 'swift',
        platform TEXT NOT NULL DEFAULT 'ios',
        signature TEXT NOT NULL,
        availability TEXT,
        introduced_in INTEGER DEFAULT 999999,
        deprecated_in INTEGER,
        obsoleted_in INTEGER,
        renamed_to TEXT,
        unavailable INTEGER DEFAULT 0,
        deprecated INTEGER DEFAULT 0,
        parent_type TEXT,
        doc_comment TEXT,
        file_path TEXT,
        line_number INTEGER
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_framework ON symbols(framework)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_platform ON symbols(platform)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_introduced ON symbols(introduced_in)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_deprecated ON symbols(deprecated_in)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        framework TEXT,
        symbol TEXT,
        content TEXT NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_docs_topic ON docs(topic)`);
  }

  /** True when the DB has no indexed symbols (fresh build needed). */
  isEmpty(): boolean {
    const r = this.db.exec('SELECT COUNT(*) FROM symbols');
    return Number(r[0]?.values[0]?.[0] ?? 0) === 0;
  }

  setMeta(k: string, v: string) {
    this.db.run(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, [k, v]);
  }

  getMeta(k: string): string | null {
    const r = this.db.exec(`SELECT v FROM meta WHERE k = ?`, [k]);
    if (r.length === 0 || r[0].values.length === 0) return null;
    return String(r[0].values[0][0]);
  }

  /**
   * Index one SDK (single platform). Call once per platform via buildAll().
   * Dedupes identical (platform, file, line) rows so rebuilds are idempotent.
   */
  buildIndex(sdkPath: string, platform: ApiSymbol['platform'] = 'ios'): number {
    const frameworksDir = path.join(sdkPath, 'System/Library/Frameworks');
    if (!fs.existsSync(frameworksDir)) {
      console.error(`Frameworks dir not found: ${frameworksDir}`);
      return 0;
    }

    const frameworks = fs.readdirSync(frameworksDir).filter((f) => f.endsWith('.framework'));
    let totalSymbols = 0;

    for (const fwDir of frameworks) {
      const fwName = fwDir.replace('.framework', '');
      const fwPath = path.join(frameworksDir, fwDir);

      // Swift interfaces (all arch slices)
      const modulesDir = path.join(fwPath, 'Modules', `${fwName}.swiftmodule`);
      if (fs.existsSync(modulesDir)) {
        const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.swiftinterface'));
        for (const file of files) {
          const content = fs.readFileSync(path.join(modulesDir, file), 'utf-8');
          totalSymbols += this.insertAll(
            parseSwiftInterface(content, fwName, path.join(modulesDir, file)),
            platform,
          );
        }
      }

      // ObjC headers
      const headersDir = path.join(fwPath, 'Headers');
      if (fs.existsSync(headersDir)) {
        const headers = fs.readdirSync(headersDir).filter((f) => f.endsWith('.h'));
        for (const header of headers) {
          const content = fs.readFileSync(path.join(headersDir, header), 'utf-8');
          totalSymbols += this.insertAll(
            parseObjCHeader(content, fwName, path.join(headersDir, header)),
            platform,
          );
        }
      }
    }

    try {
      const settings = JSON.parse(
        fs.readFileSync(path.join(sdkPath, 'SDKSettings.json'), 'utf-8'),
      ) as { Version?: string; CanonicalName?: string };
      this.setMeta(`sdk_version_${platform}`, settings.CanonicalName ?? settings.Version ?? 'unknown');
    } catch {
      this.setMeta(`sdk_version_${platform}`, 'unknown');
    }
    this.setMeta('built_at', new Date().toISOString());
    console.error(`[${platform}] Indexed ${totalSymbols} symbols across ${frameworks.length} frameworks`);
    return totalSymbols;
  }

  /** Index every platform SDK found in Xcode (ios/watchos/macos/tvos/xros). */
  buildAll(platforms?: ApiSymbol['platform'][]): number {
    const wanted = platforms ?? (Object.keys(SDK_PATHS) as ApiSymbol['platform'][]);
    let total = 0;
    for (const p of wanted) {
      const sdk = SDK_PATHS[p];
      if (!sdk || !fs.existsSync(sdk)) {
        console.error(`[${p}] SDK not found, skipped`);
        continue;
      }
      total += this.buildIndex(sdk, p);
    }
    return total;
  }

  private insertAll(symbols: ParsedSymbol[], platform: ApiSymbol['platform']): number {
    for (const sym of symbols) {
      // Merge parsed per-platform versions (@available watchOS x.y / API_AVAILABLE
      // watchos(...)) into the raw availability string so cross-SDK queries work
      // even before other SDKs are indexed.
      let availability = sym.availability;
      if (sym.platforms) {
        const extras = Object.entries(sym.platforms)
          .filter((e): e is [string, number] => typeof e[1] === 'number' && (e[1] as number) !== UNKNOWN_VERSION)
          .map(([k, v]) => `${k}${Math.floor(v / 10000)}.${Math.floor((v % 10000) / 100)}`)
          .filter((s) => !availability.includes(s));
        if (extras.length > 0) availability = `${availability} [also: ${extras.join(', ')}]`;
      }
      this.db.run(
        `INSERT INTO symbols (name, kind, framework, module, lang, platform, signature, availability,
          introduced_in, deprecated_in, obsoleted_in, renamed_to, unavailable, deprecated,
          parent_type, doc_comment, file_path, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sym.name,
          sym.kind,
          sym.framework,
          sym.module,
          sym.lang,
          platform,
          sym.signature,
          availability,
          sym.introducedIn,
          sym.deprecatedIn,
          sym.obsoletedIn,
          sym.renamedTo ?? null,
          sym.unavailable ? 1 : 0,
          sym.deprecated ? 1 : 0,
          sym.parentType ?? null,
          sym.docComment ?? null,
          sym.filePath,
          sym.lineNumber,
        ],
      );
    }
    return symbols.length;
  }

  /**
   * Load markdown docs (knowledge files, AdditionalDocumentation).
   * Split by ## / ### headers into topics for get_guide().
   */
  loadDocsFromMarkdown(content: string, source: string): number {
    const sections = content.split(/^(?=#{2,3}\s+)/m);
    let n = 0;
    for (const sec of sections) {
      const m = sec.match(/^#{2,3}\s+(.+?)\s*\n([\s\S]*)$/);
      if (!m) continue;
      const topic = `${source}: ${m[1].trim()}`.slice(0, 300);
      const body = m[2].trim().slice(0, 20000);
      if (!body) continue;
      this.db.run(`INSERT INTO docs (topic, content) VALUES (?, ?)`, [topic, body]);
      n++;
    }
    return n;
  }

  loadDocsFromFile(filePath: string): number {
    if (!fs.existsSync(filePath)) return 0;
    return this.loadDocsFromMarkdown(fs.readFileSync(filePath, 'utf-8'), path.basename(filePath));
  }

  listFrameworks(platform?: string): FrameworkInfo[] {
    const pf = platformFilter(platform);
    const results = this.db.exec(
      `
      SELECT framework, COUNT(*) as api_count, MIN(introduced_in) as min_version,
             GROUP_CONCAT(DISTINCT platform) as platforms
      FROM symbols
      WHERE 1 = 1${pf.sql}
      GROUP BY framework
      ORDER BY api_count DESC
    `,
      pf.params,
    );
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      name: String(r[0]),
      path: '',
      apiCount: Number(r[1]),
      minIOSVersion: Number(r[2]),
      isNew: Number(r[2]) >= 260000,
      platforms: String(r[3] ?? '').split(',').filter(Boolean) as FrameworkInfo['platforms'],
    }));
  }

  /**
   * Ranked search: exact name > prefix > contains, then newer APIs first.
   * sql.js has no FTS5, so LIKE + CASE ranking over indexed columns.
   */
  search(
    query: string,
    framework?: string,
    iosVersion?: number,
    kind?: string,
    limit = 50,
    platform?: string,
  ): SearchResult[] {
    const like = `%${query}%`;
    const prefix = `${query}%`;
    // Dedup across platforms: one row per (name, kind, framework), with
    // platforms aggregated. Aggregates are deterministic: MIN introduced,
    // MAX deprecated/obsoleted (platform nao deprecated thi hien), MAX cho
    // text fields (SQLite bare-column lay row dau tien tuy y -> sai).
    let sql = `
      SELECT name, kind, framework,
             MAX(parent_type) as parent_type, MAX(signature) as signature,
             MAX(availability) as availability,
             MIN(introduced_in) as introduced_in, MAX(deprecated_in) as deprecated_in,
             MAX(renamed_to) as renamed_to, MAX(lang) as lang,
             GROUP_CONCAT(DISTINCT platform) as platforms
      FROM symbols
      WHERE (name LIKE ? OR parent_type LIKE ? OR signature LIKE ?)`;
    const params: (string | number)[] = [like, like, like];

    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (kind) {
      sql += ` AND kind = ?`;
      params.push(kind);
    }
    if (platform) {
      sql += ` AND platform = ?`;
      params.push(platform);
    }
    if (iosVersion) {
      sql += ` AND (introduced_in <= ? OR introduced_in = ${UNKNOWN_VERSION})`;
      params.push(iosVersion);
    }

    // Dedup key gom ca parent_type + signature: cung ten 'init'/'+' nhung khac
    // cha/khac signature la API khac nhau (neu chi group name+kind+framework,
    // Text+ se bi row '+' cua CGSize nuot mat - realdb sweep da bat). Overloads
    // khac signature giu rieng tung row; trung lap cross-platform moi bi gop.
    sql += ` GROUP BY name, kind, framework, parent_type, signature
              ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END,
              introduced_in DESC, name LIMIT ?`;
    params.push(query, prefix, Math.min(limit, 200));
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map(rowToSearch);
  }

  /** Concrete declarations rank above extensions/members with the same name. */
  private static readonly RANK = `CASE kind WHEN 'class' THEN 0 WHEN 'struct' THEN 1 WHEN 'enum' THEN 2 WHEN 'protocol' THEN 3 WHEN 'macro' THEN 4 WHEN 'func' THEN 5 WHEN 'var' THEN 6 WHEN 'typealias' THEN 7 WHEN 'init' THEN 8 WHEN 'case' THEN 9 WHEN 'associatedtype' THEN 10 ELSE 11 END, CASE WHEN kind = 'extension' THEN 1 ELSE 0 END`;

  /** Shared member filter: skip extension placeholders + internal `_` APIs unless asked. */
  private memberFilter(includeInternal: boolean): string {
    return `kind != 'extension'${includeInternal ? '' : ` AND name NOT LIKE '\\_%' ESCAPE '\\'`}`;
  }

  getDetail(
    name: string,
    framework?: string,
    includeInternal = false,
    platform?: string,
  ): ApiDetail | null {
    let sql = `SELECT ${SYMBOL_COLS.join(', ')} FROM symbols WHERE name = ?`;
    const params: (string | number)[] = [name];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (platform) {
      sql += ` AND platform = ?`;
      params.push(platform);
    }
    sql += ` ORDER BY ${SdkIndexer.RANK} LIMIT 1`;
    let results = this.db.exec(sql, params);
    if (results.length === 0 || results[0].values.length === 0) {
      // Without framework: contains fallback. With framework: no fallback —
      // a contains match (e.g. 'View' -> '_PreviewHost') misleads more than null.
      if (framework) return null;
      const params2: (string | number)[] = [`%${name}%`];
      let sql2 = `SELECT ${SYMBOL_COLS.join(', ')} FROM symbols WHERE name LIKE ?`;
      if (platform) {
        sql2 += ` AND platform = ?`;
        params2.push(platform);
      }
      sql2 += ` ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, ${SdkIndexer.RANK} LIMIT 1`;
      params2.push(name);
      results = this.db.exec(sql2, params2);
    }
    if (results.length === 0 || results[0].values.length === 0) return null;
    const sym = rowToSymbol(results[0].values[0], SYMBOL_COLS);
    // Compact top-20 member summaries so the agent knows what to explore next.
    // Full list lives behind get_type_members.
    const filter = this.memberFilter(includeInternal);
    const short = sym.name.includes('.') ? sym.name.split('.').pop()! : sym.name;
    const mrows = this.db.exec(
      `SELECT name, kind, signature, availability, introduced_in, deprecated_in, renamed_to
       FROM symbols
       WHERE ${filter} AND framework = ? AND platform = ?
         AND (parent_type = ? OR parent_type = ? OR parent_type LIKE ?)
       ORDER BY kind, name LIMIT 20`,
      [sym.framework, sym.platform, sym.name, short, `%.${short}`],
    );
    // Resolve semantic parent version first: for extension rows the type decl
    // (class/struct/enum/protocol, else the extension itself) defines inheritance.
    let parentIntro = sym.introducedIn;
    let parentAvail = sym.availability;
    if (sym.kind === 'extension' && sym.parentType) {
      const trows = this.db.exec(
        `SELECT availability, introduced_in FROM symbols
         WHERE kind != 'extension' AND framework = ? AND platform = ?
           AND (name = ? OR name LIKE ?)
         ORDER BY ${SdkIndexer.RANK} LIMIT 1`,
        [sym.framework, sym.platform, sym.parentType, `%.${sym.parentType}`],
      );
      if (trows.length > 0 && trows[0].values.length > 0) {
        parentAvail = String(trows[0].values[0][0] ?? '');
        parentIntro = Number(trows[0].values[0][1]);
      }
    }
    const members = (mrows.length === 0 ? [] : mrows[0].values)
      .map((r) => ({
        name: String(r[0]),
        kind: String(r[1]),
        signature: String(r[2]),
        // availability only on member-level override (different version than parent)
        ...(r[3] != null && (String(r[3]) !== parentAvail || Number(r[4]) !== parentIntro)
          ? { availability: String(r[3]) }
          : {}),
        introducedIn: Number(r[4]),
        ...(r[5] != null ? { deprecatedIn: Number(r[5]) } : {}),
        ...(r[6] != null ? { renamedTo: String(r[6]) } : {}),
      }));
    const cnt = this.db.exec(
      `SELECT COUNT(*) FROM symbols
       WHERE ${filter} AND framework = ? AND platform = ?
         AND (parent_type = ? OR parent_type = ? OR parent_type LIKE ?)`,
      [sym.framework, sym.platform, sym.name, short, `%.${short}`],
    );
    const detail: ApiDetail = {
      ...sym,
      members,
      memberCount: Number(cnt[0]?.values[0]?.[0] ?? members.length),
    };
    if (sym.renamedTo) {
      // Resolve target but strip its members (avoid recursive bloat);
      // memberCount tells the agent whether the target is worth opening.
      const target = this.getDetail(sym.renamedTo, sym.framework, includeInternal, sym.platform);
      if (target) {
        const { members: _drop, renamedToDetail: _drop2, ...targetBase } = target;
        detail.renamedToDetail = { ...targetBase, memberCount: target.memberCount };
      } else {
        detail.renamedToDetail = null;
      }
    }
    return detail;
  }

  /**
   * All members of a type (extension members carry parent_type).
   * Matches short (`GridItem`) and qualified (`SwiftUI.GridItem`) names.
   * Excludes `extension` placeholder rows; internal `_` APIs excluded by default.
   * Member rows omit the redundant `availability` raw string (detail parent has it).
   */
  /**
   * Members of a type. Without `platform`, rows are deduped across platforms
   * (same name+kind+signature = one API) with platforms[] aggregated —
   * otherwise the LIMIT is eaten by 5x duplicates and inits disappear.
   */
  getTypeMembers(
    typeName: string,
    framework?: string,
    limit = 200,
    includeInternal = false,
    platform?: string,
  ): TypeMember[] {
    const short = typeName.includes('.') ? typeName.split('.').pop()! : typeName;
    const dedup = platform
      ? `name, kind, framework, lang, parent_type, signature, availability,
             introduced_in, deprecated_in, platform as platforms`
      : `name, kind, framework, MAX(lang) as lang, parent_type,
             signature, MAX(availability) as availability,
             MIN(introduced_in) as introduced_in, MAX(deprecated_in) as deprecated_in,
             GROUP_CONCAT(DISTINCT platform) as platforms`;
    let sql = `
      SELECT ${dedup}
      FROM symbols
      WHERE ${this.memberFilter(includeInternal)}
        AND (parent_type = ? OR parent_type = ? OR parent_type LIKE ?)`,
      params: (string | number)[] = [typeName, short, `%.${short}`];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (platform) {
      sql += ` AND platform = ?`;
      params.push(platform);
    } else {
      // group ca framework/parent_type: init cua Text khac init cua GridItem,
      // func cua SwiftUICore khac func cua UIKit. parent_type/signature la
      // group keys (cung grain voi name/kind/framework).
      sql += ` GROUP BY name, kind, framework, parent_type, signature`;
    }
    sql += ` ORDER BY kind, name LIMIT ?`;
    params.push(Math.min(limit, 500));
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      name: String(r[0]),
      kind: String(r[1]),
      framework: String(r[2]),
      lang: String(r[3] ?? ''),
      parentType: r[4] != null ? String(r[4]) : undefined,
      signature: String(r[5]),
      availability: String(r[6] ?? ''),
      introducedIn: Number(r[7]),
      deprecatedIn: r[8] != null ? Number(r[8]) : null,
      platforms: String(r[9] ?? '').split(',').filter(Boolean) as TypeMember['platforms'],
    }));
  }

  getNewApis(iosVersion: number, framework?: string, platform?: string): SearchResult[] {
    let sql = `
      SELECT name, kind, framework,
             MAX(parent_type) as parent_type, MAX(signature) as signature,
             MAX(availability) as availability,
             MIN(introduced_in) as introduced_in, MAX(deprecated_in) as deprecated_in,
             MAX(renamed_to) as renamed_to, MAX(lang) as lang,
             GROUP_CONCAT(DISTINCT platform) as platforms
      FROM symbols WHERE introduced_in = ?`;
    const params: (string | number)[] = [iosVersion];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (platform) {
      sql += ` AND platform = ?`;
      params.push(platform);
    }
    sql += ` GROUP BY name, kind, framework, parent_type, signature ORDER BY framework, name LIMIT 200`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map(rowToSearch);
  }

  /** Deprecated / obsoleted / unavailable APIs — with renamed_to for migration.
   * Dedup lay MAX(deprecated_in/obsoleted_in): cung 1 API, platform nao deprecated
   * thi hien. Dedup key gom parent_type+signature (giong search) de 'init'/'+'
   * cua type khac khong nuot lan nhau. */
  getDeprecated(iosVersion: number, framework?: string, platform?: string): DeprecatedApi[] {
    let sql = `
      SELECT name, kind, framework, parent_type, signature, availability,
             introduced_in, deprecated_in, renamed_to, lang, platforms, unavailable, obsoleted_in
      FROM (SELECT name, kind, framework, parent_type, signature,
              MAX(availability) as availability, MIN(introduced_in) as introduced_in,
              MAX(deprecated_in) as deprecated_in, MAX(renamed_to) as renamed_to,
              MAX(lang) as lang, GROUP_CONCAT(DISTINCT platform) as platforms,
              MAX(unavailable) as unavailable, MAX(obsoleted_in) as obsoleted_in
            FROM symbols GROUP BY name, kind, framework, parent_type, signature) s
      WHERE ((deprecated_in IS NOT NULL AND deprecated_in <= ?)
         OR (obsoleted_in IS NOT NULL AND obsoleted_in <= ?)
         OR unavailable = 1)`;
    const params: (string | number)[] = [iosVersion, iosVersion];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (platform) {
      sql += ` AND platforms LIKE ?`;
      params.push(`%${platform}%`);
    }
    // Sort: co deprecated/obsoleted version that len truoc (AI migrate duoc ngay),
    // unavailable-only xuong sau (thuong la API cua platform khac). Trong tung
    // nhom xep theo deprecated_in desc (moi deprecated nhat truoc) roi den name.
    sql += ` ORDER BY CASE WHEN deprecated_in IS NOT NULL OR obsoleted_in IS NOT NULL THEN 0 ELSE 1 END,
              COALESCE(deprecated_in, obsoleted_in, 0) DESC, framework, name LIMIT 200`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      ...rowToSearch(r),
      unavailable: Number(r[11]) === 1,
      obsoletedIn: r[12] != null ? Number(r[12]) : null,
    }));
  }

  /** Usage guides / examples from the docs layer. */
  getGuide(query: string, limit = 3): DocGuide[] {
    const like = `%${query}%`;
    const results = this.db.exec(
      `SELECT topic, framework, symbol, SUBSTR(content, 1, 3000) FROM docs
       WHERE topic LIKE ? OR content LIKE ? OR symbol LIKE ?
       ORDER BY CASE WHEN topic LIKE ? THEN 0 ELSE 1 END LIMIT ?`,
      [like, like, like, like, Math.min(limit, 5)],
    );
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      topic: String(r[0]),
      framework: r[1] != null ? String(r[1]) : undefined,
      symbol: r[2] != null ? String(r[2]) : undefined,
      snippet: String(r[3]),
    }));
  }

  getStats() {
    const total = this.db.exec('SELECT COUNT(*) FROM symbols');
    const frameworks = this.db.exec('SELECT COUNT(DISTINCT framework) FROM symbols');
    const byKind = this.db.exec(
      'SELECT kind, COUNT(*) as c FROM symbols GROUP BY kind ORDER BY c DESC',
    );
    const byLang = this.db.exec(
      'SELECT lang, COUNT(*) as c FROM symbols GROUP BY lang',
    );
    const byPlatform = this.db.exec(
      'SELECT platform, COUNT(*) as c FROM symbols GROUP BY platform ORDER BY c DESC',
    );
    const versioned = this.db.exec(
      `SELECT COUNT(*) FROM symbols WHERE introduced_in != ${UNKNOWN_VERSION}`,
    );
    const deprecated = this.db.exec(
      'SELECT COUNT(*) FROM symbols WHERE deprecated = 1 OR unavailable = 1',
    );
    const withDocs = this.db.exec(
      "SELECT COUNT(*) FROM symbols WHERE doc_comment IS NOT NULL AND doc_comment != ''",
    );
    const docsCount = this.db.exec('SELECT COUNT(*) FROM docs');
    const sdkVersions = this.db.exec(`SELECT k, v FROM meta WHERE k LIKE 'sdk_version_%'`);
    const totalN = Number(total[0]?.values[0]?.[0] ?? 0);
    const versionedN = Number(versioned[0]?.values[0]?.[0] ?? 0);
    return {
      totalSymbols: totalN,
      totalFrameworks: frameworks[0]?.values[0]?.[0] ?? 0,
      sdkVersion: this.getMeta('sdk_version'),
      sdkVersions: Object.fromEntries(
        (sdkVersions.length === 0 ? [] : sdkVersions[0].values).map((r) => [
          String(r[0]).replace('sdk_version_', ''),
          String(r[1]),
        ]),
      ),
      symbolsByKind: byKind.length === 0 ? [] : byKind[0].values.map((r) => ({ kind: String(r[0]), count: Number(r[1]) })),
      symbolsByLang: byLang.length === 0 ? [] : byLang[0].values.map((r) => ({ lang: String(r[0]), count: Number(r[1]) })),
      symbolsByPlatform: byPlatform.length === 0 ? [] : byPlatform[0].values.map((r) => ({ platform: String(r[0]), count: Number(r[1]) })),
      versionCoverage: totalN > 0 ? Math.round((versionedN / totalN) * 1000) / 10 : 0,
      deprecatedCount: deprecated[0]?.values[0]?.[0] ?? 0,
      symbolsWithDocs: withDocs[0]?.values[0]?.[0] ?? 0,
      docsSections: docsCount[0]?.values[0]?.[0] ?? 0,
    };
  }

  save(dbPath: string) {
    const data = this.db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  }

  close() {
    this.db.close();
  }
}
