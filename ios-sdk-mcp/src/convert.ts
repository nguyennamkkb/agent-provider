import {
  stripLeadingAttributes,
  stripPublicPrefix,
  matchSwiftDecl,
  cleanTypeName,
  cutSignature,
  parseObjCHeader,
  type AvailabilityInfo,
} from './parser.js';
import {
  discoverFiles,
  analyzeContext,
  tokenize,
  type SdkFile,
} from './sdk.js';
import type { SdkPlatform } from './types.js';

export interface ConvertedHit {
  name: string;
  kind: string;
  framework: string;
  lang: 'swift' | 'objc';
  platform: SdkPlatform;
  signature: string;
  availability?: string;
  introducedIn?: number;
  deprecatedIn?: number;
  renamedTo?: string;
  unavailable?: boolean;
  parentType?: string;
  docComment?: string;
  filePath: string;
  lineNumber: number;
}

const KIND_RANK: Record<string, number> = {
  class: 0, struct: 1, enum: 2, protocol: 3, macro: 4, func: 5, var: 6,
  typealias: 7, init: 8, case: 9, associatedtype: 10, operator: 11, extension: 12,
};

/**
 * Convert 1 dòng rg match -> ApiSymbol-like object.
 * - Swift: strip attrs -> match decl (dùng đúng parser.ts).
 * - ObjC: parse nguyên file bằng parseObjCHeader rồi tra lineNumber
 *   (chuẩn 100% vì cùng 1 code path).
 * - Giải tích phía trên: analyzeContext (giữ pending semantics của parser).
 */
export function convertLine(
  file: SdkFile,
  lineNumber: number,
  lineText: string,
  objcByLine?: Map<number, { name: string; kind: string; signature: string; parentType?: string; docComment?: string }>,
): ConvertedHit | null {
  const trimmed = lineText.trim();
  if (file.lang === 'swift') {
    if (/^(import|#)/.test(trimmed)) return null;
    const noAttr = stripLeadingAttributes(trimmed);
    if (/^(internal|fileprivate|private)\b/.test(noAttr)) return null;
    const ext = noAttr.match(/^extension\s+([^\s{]+)/);
    const ctx = analyzeContext(file.path, lineNumber);
    if (ext) {
      const name = cleanTypeName(ext[1]);
      return {
        name, kind: 'extension', framework: file.framework, lang: 'swift',
        platform: file.platform, signature: cutSignature(lineText),
        ...(ctx.availLines.length > 0 ? { availability: ctx.availLines.join('; ') } : {}),
        ...(ctx.introducedIn !== null ? { introducedIn: ctx.introducedIn } : {}),
        ...(ctx.deprecatedIn !== null ? { deprecatedIn: ctx.deprecatedIn } : {}),
        ...(ctx.renamedTo ? { renamedTo: ctx.renamedTo } : {}),
        ...(ctx.unavailable ? { unavailable: true } : {}),
        parentType: name,
        ...(ctx.docComment ? { docComment: ctx.docComment } : {}),
        filePath: file.path, lineNumber,
      };
    }
    const rest = stripPublicPrefix(noAttr);
    let decl = rest !== null ? matchSwiftDecl(rest) : null;
    // Bare members trong protocol scope: không public nhưng vẫn là public API.
    // (convertLine không track scope -> thử match trực tiếp, parser full quyết định sau.)
    if (!decl) {
      const bare = matchSwiftDecl(noAttr);
      if (bare && ['func', 'var', 'init', 'operator', 'typealias', 'associatedtype', 'macro'].includes(bare.kind)) {
        decl = bare;
      }
    }
    if (!decl) {
      // enum case không prefix
      const cm = noAttr.match(/^case\s+(\w+)/);
      if (!cm) return null;
      return {
        name: cm[1], kind: 'case', framework: file.framework, lang: 'swift',
        platform: file.platform, signature: cutSignature(lineText),
        ...(ctx.availLines.length > 0 ? { availability: ctx.availLines.join('; ') } : {}),
        ...(ctx.introducedIn !== null ? { introducedIn: ctx.introducedIn } : {}),
        filePath: file.path, lineNumber,
      };
    }
    return {
      name: decl.names[0], kind: decl.kind, framework: file.framework, lang: 'swift',
      platform: file.platform, signature: cutSignature(lineText),
      ...(ctx.availLines.length > 0 ? { availability: ctx.availLines.join('; ') } : {}),
      ...(ctx.introducedIn !== null ? { introducedIn: ctx.introducedIn } : {}),
      ...(ctx.deprecatedIn !== null ? { deprecatedIn: ctx.deprecatedIn } : {}),
      ...(ctx.renamedTo ? { renamedTo: ctx.renamedTo } : {}),
      ...(ctx.unavailable ? { unavailable: true } : {}),
      ...(ctx.docComment ? { docComment: ctx.docComment } : {}),
      filePath: file.path, lineNumber,
    };
  }
  // ObjC: tra bảng parse full-file theo lineNumber.
  if (objcByLine) {
    const hit = objcByLine.get(lineNumber);
    if (!hit) return null;
    const ctx = analyzeContext(file.path, lineNumber);
    return {
      name: hit.name,
      kind: hit.kind as ConvertedHit['kind'],
      framework: file.framework,
      lang: 'objc',
      platform: file.platform,
      signature: hit.signature,
      ...(ctx.docComment && !hit.docComment ? { docComment: ctx.docComment } : {}),
      ...(hit.docComment ? { docComment: hit.docComment } : {}),
      ...(hit.parentType ? { parentType: hit.parentType } : {}),
      filePath: file.path,
      lineNumber,
    };
  }
  return null;
}

/** Parse 1 file ObjC -> map lineNumber => symbol (cho convertLine). */
export function objcLineMap(
  file: SdkFile,
  readFile: (p: string) => string,
): Map<number, { name: string; kind: string; signature: string; parentType?: string; docComment?: string }> {
  const map = new Map<number, { name: string; kind: string; signature: string; parentType?: string; docComment?: string }>();
  try {
    for (const s of parseObjCHeader(readFile(file.path), file.framework, file.path)) {
      if (!map.has(s.lineNumber)) {
        map.set(s.lineNumber, {
          name: s.name, kind: s.kind, signature: s.signature,
          ...(s.parentType ? { parentType: s.parentType } : {}),
          ...(s.docComment ? { docComment: s.docComment } : {}),
        });
      }
    }
  } catch { /* file lỗi -> map rỗng */ }
  return map;
}

export function rankHits<T extends { name: string; kind: string }>(hits: T[], query: string): T[] {
  const q = query.toLowerCase();
  const toks = tokenize(query);
  const score = (h: T & { signature?: string }): number => {
    const n = h.name.toLowerCase();
    let s = 0;
    if (n === q) s += 100;
    else if (n.startsWith(q)) s += 60;
    else if (n.includes(q)) s += 30;
    if (toks.length > 1) {
      const hay = `${n} ${(h.signature ?? '').toLowerCase()}`;
      let hit = 0;
      for (const t of toks) if (hay.includes(t)) hit++;
      s += (hit / toks.length) * 40;
    }
    s -= (KIND_RANK[h.kind] ?? 20) * 0.5;
    if (/^_/.test(h.name)) s -= 10;
    return s;
  };
  return [...hits].sort((a, b) => score(b) - score(a));
}

export type { SdkFile };
export type { AvailabilityInfo };
