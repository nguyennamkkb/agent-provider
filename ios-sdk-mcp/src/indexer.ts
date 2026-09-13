import initSqlJs, { type Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { parseSwiftInterface, parseObjCHeader } from './parser.js';
import type { ApiSymbol, FrameworkInfo, SearchResult, TypeHierarchy } from './types.js';

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
    indexer.createTables();
    return indexer;
  }

  private createTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        framework TEXT NOT NULL,
        module TEXT NOT NULL,
        signature TEXT NOT NULL,
        availability TEXT,
        min_ios_version INTEGER DEFAULT 999999,
        parent_type TEXT,
        doc_comment TEXT,
        file_path TEXT,
        line_number INTEGER
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_framework ON symbols(framework)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_min_ios ON symbols(min_ios_version)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_symbols_sig ON symbols(signature)`);
  }

  buildIndex(sdkPath: string) {
    const frameworksDir = path.join(sdkPath, 'System/Library/Frameworks');
    if (!fs.existsSync(frameworksDir)) {
      console.error(`Frameworks dir not found: ${frameworksDir}`);
      return;
    }

    const frameworks = fs.readdirSync(frameworksDir).filter(f => f.endsWith('.framework'));
    let totalSymbols = 0;

    for (const fwDir of frameworks) {
      const fwName = fwDir.replace('.framework', '');
      const fwPath = path.join(frameworksDir, fwDir);

      // Parse Swift interfaces
      const modulesDir = path.join(fwPath, 'Modules', `${fwName}.swiftmodule`);
      if (fs.existsSync(modulesDir)) {
        const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.swiftinterface'));
        for (const file of files) {
          const content = fs.readFileSync(path.join(modulesDir, file), 'utf-8');
          const symbols = parseSwiftInterface(content, fwName, path.join(modulesDir, file));
          for (const sym of symbols) {
            this.db.run(
              `INSERT INTO symbols (name, kind, framework, module, signature, availability, min_ios_version, parent_type, doc_comment, file_path, line_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [sym.name, sym.kind, sym.framework, sym.module, sym.signature, sym.availability, sym.minIOSVersion, sym.parentType ?? null, sym.docComment ?? null, sym.filePath, sym.lineNumber]
            );
            totalSymbols++;
          }
        }
      }

      // Parse ObjC headers
      const headersDir = path.join(fwPath, 'Headers');
      if (fs.existsSync(headersDir)) {
        const headers = fs.readdirSync(headersDir).filter(f => f.endsWith('.h'));
        for (const header of headers) {
          const content = fs.readFileSync(path.join(headersDir, header), 'utf-8');
          const symbols = parseObjCHeader(content, fwName, path.join(headersDir, header));
          for (const sym of symbols) {
            this.db.run(
              `INSERT INTO symbols (name, kind, framework, module, signature, availability, min_ios_version, parent_type, doc_comment, file_path, line_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [sym.name, sym.kind, sym.framework, sym.module, sym.signature, sym.availability, sym.minIOSVersion, null, sym.docComment ?? null, sym.filePath, sym.lineNumber]
            );
            totalSymbols++;
          }
        }
      }
    }

    console.error(`Indexed ${totalSymbols} symbols across ${frameworks.length} frameworks`);
  }

  listFrameworks(): FrameworkInfo[] {
    const results = this.db.exec(`
      SELECT framework, COUNT(*) as api_count, MIN(min_ios_version) as min_version
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

  search(query: string, framework?: string, iosVersion?: number): SearchResult[] {
    let sql = `SELECT name, kind, framework, signature, availability FROM symbols WHERE (name LIKE ? OR signature LIKE ? OR framework LIKE ?)`;
    const like = `%${query}%`;
    const params: (string | number)[] = [like, like, like];

    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    if (iosVersion) {
      sql += ` AND min_ios_version <= ?`;
      params.push(iosVersion);
    }

    sql += ` ORDER BY min_ios_version DESC, name LIMIT 50`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      name: String(r[0]),
      kind: String(r[1]),
      framework: String(r[2]),
      signature: String(r[3]),
      availability: String(r[4]),
    }));
  }

  getDetail(name: string, framework?: string): ApiSymbol | null {
    let sql = `SELECT * FROM symbols WHERE name LIKE ?`;
    const params: string[] = [`%${name}%`];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    sql += ` LIMIT 1`;
    const results = this.db.exec(sql, params);
    if (results.length === 0 || results[0].values.length === 0) return null;
    const r = results[0].values[0];
    return {
      name: String(r[1]),
      kind: String(r[2]) as ApiSymbol['kind'],
      framework: String(r[3]),
      module: String(r[4]),
      signature: String(r[5]),
      availability: String(r[6] ?? ''),
      minIOSVersion: Number(r[7]),
      parentType: r[8] != null ? String(r[8]) : undefined,
      docComment: r[9] != null ? String(r[9]) : undefined,
      filePath: String(r[10]),
      lineNumber: Number(r[11]),
    };
  }

  getTypeHierarchy(name: string): TypeHierarchy | null {
    const detail = this.getDetail(name);
    if (!detail) return null;

    const extResults = this.db.exec(`
      SELECT signature, availability FROM symbols
      WHERE kind = 'extension' AND parent_type LIKE ?
      ORDER BY min_ios_version
    `, [`%${name}%`]);

    const extensions = extResults.length === 0 ? [] : extResults[0].values.map((e) => ({
      types: [name],
      availability: String(e[1]),
    }));

    return {
      name: detail.name,
      kind: detail.kind,
      framework: detail.framework,
      supertype: detail.signature.match(/:\s*([\w.]+)/)?.[1],
      protocols: [...detail.signature.matchAll(/conforming to\s+([\w.,\s]+)/g)].map(m => m[1].split(',').map(s => s.trim())).flat(),
      extensions,
    };
  }

  getNewApis(iosVersion: number, framework?: string): SearchResult[] {
    let sql = `SELECT name, kind, framework, signature, availability FROM symbols WHERE min_ios_version = ?`;
    const params: (string | number)[] = [iosVersion];
    if (framework) {
      sql += ` AND framework = ?`;
      params.push(framework);
    }
    sql += ` ORDER BY framework, name LIMIT 200`;
    const results = this.db.exec(sql, params);
    if (results.length === 0) return [];
    return results[0].values.map((r) => ({
      name: String(r[0]),
      kind: String(r[1]),
      framework: String(r[2]),
      signature: String(r[3]),
      availability: String(r[4]),
    }));
  }

  getStats() {
    const total = this.db.exec('SELECT COUNT(*) FROM symbols');
    const frameworks = this.db.exec('SELECT COUNT(DISTINCT framework) FROM symbols');
    const byKind = this.db.exec('SELECT kind, COUNT(*) as c FROM symbols GROUP BY kind ORDER BY c DESC');
    const newIn27 = this.db.exec('SELECT COUNT(*) FROM symbols WHERE min_ios_version = 270000');
    return {
      totalSymbols: total[0]?.values[0]?.[0] ?? 0,
      totalFrameworks: frameworks[0]?.values[0]?.[0] ?? 0,
      symbolsByKind: byKind.length === 0 ? [] : byKind[0].values.map((r) => ({ kind: String(r[0]), count: Number(r[1]) })),
      newInIOS27: newIn27[0]?.values[0]?.[0] ?? 0,
    };
  }

  save(dbPath: string) {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }

  close() {
    this.db.close();
  }
}
