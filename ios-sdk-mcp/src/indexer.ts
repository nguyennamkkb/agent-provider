import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { parseSwiftInterface, parseObjCHeader, UNKNOWN_VERSION } from './parser.js';
import type {
  ApiSymbol,
  DeprecatedApi,
  DocGuide,
  FrameworkInfo,
  SearchResult,
  TypeMember,
} from './types.js';

export const SCHEMA_VERSION = 2;

function rowToSymbol(r: unknown[]): ApiSymbol {
  return {
    name: String(r[1]),
    kind: r[2] as ApiSymbol['kind'],
    framework: String(r[3]),
    module: String(r[4]),
    lang: (r[5] as string) === 'objc' ? 'objc' : 'swift',
    signature: String(r[6]),
    availability: String(r[7] ?? ''),
    minIOSVersion: Number(r[8]),
    introducedIn: Number(r[8]),
    deprecatedIn: r[9] != null ? Number(r[9]) : null,
    obsoletedIn: r[10] != null ? Number(r[10]) : null,
    renamedTo: r[11] != null ? String(r[11]) : undefined,
    unavailable: Number(r[12]) === 1,
    deprecated: Number(r[13]) === 1,
    parentType: r[14] != null ? String(r[14]) : undefined,
    docComment: r[15] != null ? String(r[15]) : undefined,
    filePath: String(r[16]),
    lineNumber: Number(r[17]),
  };
}

function rowToSearch(r: unknown[]): SearchResult {
  return {
    name: String(r[0]),
    kind: String(r[1]),
    framework: String(r[2]),
    lang: String(r[9] ?? ''),
    parentType: r[3] != null ? String(r[3]) : undefined,
    signature: String(r[4]),
    availability: String(r[5] ?? ''),
    introducedIn: Number(r[6]),
    deprecatedIn: r[7] != null ? Number(r[7]) : null,
    renamedTo: r[8] != null ? String(r[8]) : undefined,
  };
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

  buildIndex(sdkPath: string) {
    const frameworksDir = path.join(sdkPath, 'System/Library/Frameworks');
    if (!fs.existsSync(frameworksDir)) {
      console.error(`Frameworks dir not found: ${frameworksDir}`);
      return;
    }

    const frameworks = fs.readdirSync(frameworksDir).filter((f) => f.endsWith('.framework'));
    let totalSymbols = 0;

    for (const fwDir of frameworks) {
      const fwName = fwDir.replace('.framework', '');
      const fwPath = path.join(frameworksDir, fwDir);

      // Swift interfaces
      const modulesDir = path.join(fwPath, 'Modules', `${fwName}.swiftmodule`);
      if (fs.existsSync(modulesDir)) {
        const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.swiftinterface'));
        for (const file of files) {
          const content = fs.readFileSync(path.join(modulesDir, file), 'utf-8');
          totalSymbols += this.insertAll(parseSwiftInterface(content, fwName, path.join(modulesDir, file)));
        }
      }

      // ObjC headers
      const headersDir = path.join(fwPath, 'Headers');
      if (fs.existsSync(headersDir)) {
        const headers = fs.readdirSync(headersDir).filter((f) => f.endsWith('.h'));
        for (const header of headers) {
          const content = fs.readFileSync(path.join(headersDir, header), 'utf-8');
          totalSymbols += this.insertAll(parseObjCHeader(content, fwName, path.join(headersDir, header)));
        }
      }
    }

    try {
      const settings = JSON.parse(
        fs.readFileSync(path.join(sdkPath, 'SDKSettings.json'), 'utf-8'),
      ) as { Version?: string; CanonicalName?: string };
      this.setMeta('sdk_version', settings.CanonicalName ?? settings.Version ?? 'unknown');
    } catch {
      this.setMeta('sdk_version', 'unknown');
    }
    this.setMeta('built_at', new Date().toISOString());
    console.error(`Indexed ${totalSymbols} symbols across ${frameworks.length} frameworks`);
  }

  private insertAll(symbols: ApiSymbol[]): number {
    for (const sym of symbols) {
      this.db.run(
        `INSERT INTO symbols (name, kind, framework, module, lang, signature, availability,
          introduced_in, deprecated_in, obsoleted_in, renamed_to, unavailable, deprecated,
          parent_type, doc_comment, file_path, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sym.name,
          sym.kind,
          sym.framework,
          sym.module,
          sym.lang,
          sym.signature,
          sym.availability,
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

  listFrameworks(): FrameworkInfo[] {
    const results = this.db.exec(`
      SELECT framework, COUNT(*) as api_count, MIN(introduced_in) as min_version
      FROM symbols
      GROUP BY framework
      ORDER BY api_count DESC
    `);
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      name: String(r[0]),
      path: '',
      apiCount: Number(r[1]),
      minIOSVersion: Number(r[2]),
      isNew: Number(r[2]) >= 260000,
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
  ): SearchResult[] {
    const like = `%${query}%`;
    const prefix = `${query}%`;
    let sql = `
      SELECT name, kind, framework, parent_type, signature, availability,
             introduced_in, deprecated_in, renamed_to, lang
      FROM symbols
      WHERE (name LIKE ? OR signature LIKE ? OR parent_type LIKE ?)`;
    const params: (string | number)[] = [like, like, like];

    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (kind) {
      sql += ` AND kind = ?`;
      params.push(kind);
    }
    if (iosVersion) {
      sql += ` AND (introduced_in <= ? OR introduced_in = ${UNKNOWN_VERSION})`;
      params.push(iosVersion);
    }

    sql += ` ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END,
              introduced_in DESC, name LIMIT ?`;
    params.push(query, prefix, Math.min(limit, 200));
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map(rowToSearch);
  }

  /** Concrete declarations rank above extensions/members with the same name. */
  private static readonly RANK = `CASE kind WHEN 'class' THEN 0 WHEN 'struct' THEN 1 WHEN 'enum' THEN 2 WHEN 'protocol' THEN 3 WHEN 'macro' THEN 4 WHEN 'func' THEN 5 WHEN 'var' THEN 6 WHEN 'typealias' THEN 7 WHEN 'init' THEN 8 WHEN 'case' THEN 9 WHEN 'associatedtype' THEN 10 ELSE 11 END, CASE WHEN kind = 'extension' THEN 1 ELSE 0 END`;

  getDetail(name: string, framework?: string): ApiSymbol | null {
    let sql = `SELECT * FROM symbols WHERE name = ?`;
    const params: string[] = [name];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    sql += ` ORDER BY ${SdkIndexer.RANK} LIMIT 1`;
    let results = this.db.exec(sql, params);
    if (results.length === 0 || results[0].values.length === 0) {
      // fallback: contains match, exact-name ranked first
      let sql2 = `SELECT * FROM symbols WHERE name LIKE ?`;
      const params2: string[] = [`%${name}%`];
      if (framework) {
        sql2 += ` AND framework = ?`;
        params2.push(framework);
      }
      sql2 += ` ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, ${SdkIndexer.RANK} LIMIT 1`;
      params2.push(name);
      results = this.db.exec(sql2, params2);
    }
    if (results.length === 0 || results[0].values.length === 0) return null;
    return rowToSymbol(results[0].values[0]);
  }

  /**
   * All members of a type (extension members carry parent_type).
   * Matches short (`GridItem`) and qualified (`SwiftUI.GridItem`) names.
   * Excludes `extension` placeholder rows (no name/signature of their own).
   */
  getTypeMembers(typeName: string, framework?: string, limit = 200): TypeMember[] {
    const short = typeName.includes('.') ? typeName.split('.').pop()! : typeName;
    let sql = `
      SELECT name, kind, framework, lang, parent_type, signature, availability,
             introduced_in, deprecated_in
      FROM symbols
      WHERE kind != 'extension'
        AND (parent_type = ? OR parent_type = ? OR parent_type LIKE ?)`,
      params: (string | number)[] = [typeName, short, `%.${short}`];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
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
    }));
  }

  getNewApis(iosVersion: number, framework?: string): SearchResult[] {
    let sql = `
      SELECT name, kind, framework, parent_type, signature, availability,
             introduced_in, deprecated_in, renamed_to, lang
      FROM symbols WHERE introduced_in = ?`;
    const params: (string | number)[] = [iosVersion];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    sql += ` ORDER BY framework, name LIMIT 200`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map(rowToSearch);
  }

  /** Deprecated / obsoleted / unavailable APIs — with renamed_to for migration. */
  getDeprecated(iosVersion: number, framework?: string): DeprecatedApi[] {
    let sql = `
      SELECT name, kind, framework, parent_type, signature, availability,
             introduced_in, deprecated_in, renamed_to, lang, unavailable, obsoleted_in
      FROM symbols
      WHERE ((deprecated_in IS NOT NULL AND deprecated_in <= ?)
         OR (obsoleted_in IS NOT NULL AND obsoleted_in <= ?)
         OR unavailable = 1)`;
    const params: (string | number)[] = [iosVersion, iosVersion];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    sql += ` ORDER BY framework, name LIMIT 200`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      ...rowToSearch(r),
      unavailable: Number(r[10]) === 1,
      obsoletedIn: r[11] != null ? Number(r[11]) : null,
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
    const sdkVersion = this.getMeta('sdk_version');
    const totalN = Number(total[0]?.values[0]?.[0] ?? 0);
    const versionedN = Number(versioned[0]?.values[0]?.[0] ?? 0);
    return {
      totalSymbols: totalN,
      totalFrameworks: frameworks[0]?.values[0]?.[0] ?? 0,
      sdkVersion,
      symbolsByKind: byKind.length === 0 ? [] : byKind[0].values.map((r) => ({ kind: String(r[0]), count: Number(r[1]) })),
      symbolsByLang: byLang.length === 0 ? [] : byLang[0].values.map((r) => ({ lang: String(r[0]), count: Number(r[1]) })),
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
