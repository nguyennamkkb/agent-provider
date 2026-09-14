import type { ApiKind, ApiSymbol } from './types.js';

/** Version unknown / unparseable. */
export const UNKNOWN_VERSION = 999999;

/** "18.0" | "18" | "3_2" -> 180000 etc. Null when unparseable. */
export function parseVersionToken(tok: string): number | null {
  const t = tok.trim().replace(/_/g, '.');
  const m = t.match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 10000 + (m[2] !== undefined ? parseInt(m[2], 10) : 0) * 100;
}

export interface AvailabilityInfo {
  raw: string;
  introducedIn: number;
  deprecatedIn: number | null;
  obsoletedIn: number | null;
  renamedTo?: string;
  unavailable: boolean;
  deprecated: boolean;
}

export function unknownAvail(): AvailabilityInfo {
  return {
    raw: '',
    introducedIn: UNKNOWN_VERSION,
    deprecatedIn: null,
    obsoletedIn: null,
    renamedTo: undefined,
    unavailable: false,
    deprecated: false,
  };
}

/** Split by top-level commas (respect quotes + parens). */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; }
    else if (c === '(') { depth++; cur += c; }
    else if (c === ')') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * Parse the inside of a Swift `@available(...)`.
 * Only the iOS platform is extracted (macOS/tvOS/watchOS/visionOS ignored).
 * Handles both families:
 *   @available(iOS 18.0, macOS 15.0, *)
 *   @available(iOS, introduced: 13.0, deprecated: 16.0, renamed: "foo")
 *   @available(*, unavailable / deprecated, message: ...)
 */
/** Extract ALL @available(...) inners from a line (quote+paren aware). */
export function extractAvailableInners(line: string): string[] {
  const inners: string[] = [];
  let idx = 0;
  while (idx < line.length) {
    const at = line.indexOf('@available', idx);
    if (at < 0) break;
    const open = line.indexOf('(', at);
    if (open < 0) break;
    let depth = 0;
    let inStr = false;
    let j = open;
    for (; j < line.length; j++) {
      const c = line[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    inners.push(line.slice(open + 1, j));
    idx = j + 1;
  }
  return inners;
}

/** iOS sentinel: Apple uses 100000.0 (= unrealistic future) as 'not yet deprecated'. */
export const NOT_DEPRECATED_SENTINEL = 100000 * 10000;

export function parseSwiftAvailable(inner: string): AvailabilityInfo {
  const info = unknownAvail();
  info.raw = inner.trim();
  // Re-glue `iOS, introduced: x, ...` which splitTopLevel broke apart:
  // a bare platform seg absorbs following `key: value` segs.
  const PLAT = '(?:iOS|macOS|macCatalyst|tvOS|watchOS|visionOS)';
  const rawSegs = splitTopLevel(inner).map((s) => s.trim()).filter((s) => s && s !== '*');
  const segs: string[] = [];
  for (const s of rawSegs) {
    const last = segs.length > 0 ? segs[segs.length - 1] : '';
    const lastIsBarePlatform = new RegExp(`^${PLAT}$`).test(last);
    const lastIsPlatformRest = new RegExp(`^${PLAT},`).test(last);
    const sStartsNew = new RegExp(`^(\\*|${PLAT}\\b)`).test(s);
    // Glue continuations back onto their platform: `iOS, introduced: x`,
    // and bare keywords: `tvOS, unavailable`.
    if ((lastIsBarePlatform && !sStartsNew) || (lastIsPlatformRest && /^\w+\s*:/.test(s) && !sStartsNew)) {
      segs[segs.length - 1] = `${last}, ${s}`;
    } else {
      segs.push(s);
    }
  }
  for (const seg of segs) {
    const t = seg;
    // Other-platform segments (tvOS/watchOS/...) do not affect iOS status.
    const pm = t.match(/^(iOS|macOS|macCatalyst|tvOS|watchOS|visionOS)\b/);
    if (pm && pm[1] !== 'iOS') continue;
    if (t === 'unavailable') { info.unavailable = true; continue; }
    if (t === 'deprecated') { info.deprecated = true; continue; }

    // "iOS 18.0"
    let m = t.match(/^iOS\s+([0-9._]+)/);
    if (m) {
      const v = parseVersionToken(m[1]);
      if (v !== null && v < info.introducedIn) info.introducedIn = v;
      continue;
    }
    // "iOS, introduced: 13.0, deprecated: 16.0, obsoleted: 17.0, renamed: ..., ..."
    m = t.match(/^iOS\s*,(.*)$/s);
    if (m) {
      const pairs = m[1];
      const gi = pairs.match(/introduced\s*:\s*([0-9._]+)/);
      if (gi) {
        const v = parseVersionToken(gi[1]);
        if (v !== null && v < info.introducedIn) info.introducedIn = v;
      }
      const gd = pairs.match(/deprecated\s*:\s*([0-9._]+)/);
      if (gd) {
        const v = parseVersionToken(gd[1]);
        // 100000.0 = Apple's 'not deprecated yet' sentinel -> ignore version,
        // but keep deprecated=true only if there is a message/rename hint.
        if (v !== null && v < NOT_DEPRECATED_SENTINEL) info.deprecatedIn = v;
        if (v === null || v >= NOT_DEPRECATED_SENTINEL) {
          if (/message\s*:|renamed\s*:/.test(pairs)) info.deprecated = true;
        } else {
          info.deprecated = true;
        }
      } else if (/\bdeprecated\b/.test(pairs)) {
        info.deprecated = true;
      }
      const go = pairs.match(/obsoleted\s*:\s*([0-9._]+)/);
      if (go) {
        const v = parseVersionToken(go[1]);
        if (v !== null) info.obsoletedIn = v;
      }
      const gr = pairs.match(/renamed\s*:\s*"([^"]+)"/);
      if (gr && !info.renamedTo) info.renamedTo = gr[1];
      if (/\bunavailable\b/.test(pairs)) info.unavailable = true;
      continue;
    }
    // "*, deprecated, renamed: ...", "*, unavailable, message: ..."
    const gr = t.match(/renamed\s*:\s*"([^"]+)"/);
    if (gr && !info.renamedTo) info.renamedTo = gr[1];
    if (/\bunavailable\b/.test(t)) info.unavailable = true;
    if (/\bdeprecated\b/.test(t)) info.deprecated = true;
  }
  return info;
}

/** Merge several consecutive @available lines (one per platform). */
export function mergeAvailability(list: AvailabilityInfo[]): AvailabilityInfo {
  const out = unknownAvail();
  const raws: string[] = [];
  for (const a of list) {
    if (a.raw) raws.push(a.raw);
    if (a.introducedIn < out.introducedIn) out.introducedIn = a.introducedIn;
    if (a.deprecatedIn !== null && out.deprecatedIn === null) out.deprecatedIn = a.deprecatedIn;
    if (a.obsoletedIn !== null && out.obsoletedIn === null) out.obsoletedIn = a.obsoletedIn;
    if (a.renamedTo && !out.renamedTo) out.renamedTo = a.renamedTo;
    out.unavailable = out.unavailable || a.unavailable;
    out.deprecated = out.deprecated || a.deprecated;
  }
  out.raw = raws.join('; ');
  return out;
}

/** Member inherits scope (extension/type) availability unless it declares its own. */
export function inheritAvail(
  scope: AvailabilityInfo | null,
  own: AvailabilityInfo,
): AvailabilityInfo {
  const base = scope ?? unknownAvail();
  return {
    raw: own.raw || base.raw,
    introducedIn: own.introducedIn !== UNKNOWN_VERSION ? own.introducedIn : base.introducedIn,
    deprecatedIn: own.deprecatedIn ?? base.deprecatedIn,
    obsoletedIn: own.obsoletedIn ?? base.obsoletedIn,
    renamedTo: own.renamedTo ?? base.renamedTo,
    unavailable: own.unavailable || base.unavailable,
    deprecated: own.deprecated || base.deprecated,
  };
}

/** Quote-aware paren depth (for joining multi-line signatures). */
function parenDepth(s: string): number {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') d++;
    else if (c === ')') d--;
  }
  return d;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * Strip leading attributes (@MainActor, @_disfavoredOverload, @attached(...) with
 * nested parens...) and soft modifiers (nonisolated, final, ...) before access level.
 */
function stripLeadingAttributes(line: string): string {
  let s = line.trimStart();
  for (;;) {
    if (s.startsWith('@')) {
      let i = 1;
      while (i < s.length && /[\w.]/.test(s[i])) i++;
      s = s.slice(i).trimStart();
      if (s.startsWith('(')) {
        let depth = 0;
        let j = 0;
        let inStr = false;
        for (; j < s.length; j++) {
          const c = s[j];
          if (inStr) {
            if (c === '\\') j++;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === '(') depth++;
          else if (c === ')') {
            depth--;
            if (depth === 0) { j++; break; }
          }
        }
        s = s.slice(j).trimStart();
      }
      continue;
    }
    const m = s.match(/^(nonisolated|mutating|nonmutating|consuming|borrowing|final)\b\s*/);
    if (m) { s = s.slice(m[0].length); continue; }
    break;
  }
  return s;
}

/**
 * Strip soft modifiers around access level (`nonisolated public`, `override dynamic
 * public`, `@objc ... public`, `@_spi(Private) ...`). Bare `internal`/`fileprivate`/
 * `private` are NOT public API: detect separately and skip.
 */
const SWIFT_NONPUBLIC = /^(internal|fileprivate|private)\b/;
function stripPublicPrefix(line: string): string | null {
  let s = line;
  let sawPublic = false;
  for (;;) {
    if (s.startsWith('@')) {
      let i = 1;
      while (i < s.length && /[\w.]/.test(s[i])) i++;
      s = s.slice(i).trimStart();
      if (s.startsWith('(')) {
        let depth = 0;
        let j = 0;
        let inStr = false;
        for (; j < s.length; j++) {
          const c = s[j];
          if (inStr) {
            if (c === '\\') j++;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === '(') depth++;
          else if (c === ')') {
            depth--;
            if (depth === 0) { j++; break; }
          }
        }
        s = s.slice(j).trimStart();
      }
      continue;
    }
    // NOTE: `class` is a kind keyword (`open class Foo`) — matchSwiftDecl handles
    // `class func` itself, so never eat `class`/`static` here.
    const m = s.match(
      /^(nonisolated|mutating|nonmutating|consuming|borrowing|final|override|dynamic|required|convenience|distributed|lazy|weak|unowned|isolated|indirect|open|package|public)\b\s*/,
    );
    if (!m) break;
    if (m[1] === 'public' || m[1] === 'open' || m[1] === 'package') sawPublic = true;
    s = s.slice(m[0].length);
  }
  return sawPublic ? s : null;
}

interface SwiftDecl {
  kind: ApiKind;
  names: string[];
}

/** Match a declaration after access level was consumed. */
function matchSwiftDecl(rest: string): SwiftDecl | null {
  let s = rest;

  // `class func` / `static func` must be checked BEFORE bare `class` type decl.
  let m = s.match(/^(static|class)\s+func\s+(\w+|[^\w\s(:<]+)/);
  if (m) {
    const name = m[2];
    return { kind: /^\w/.test(name) ? 'func' : 'operator', names: [name] };
  }
  m = s.match(/^(static|class)\s+(var|let)\s+(\w+)/);
  if (m) return { kind: 'var', names: [m[3]] };
  m = s.match(/^(class|struct|enum|protocol|actor)\s+(\w+)/);
  if (m) {
    const kind: ApiKind = m[1] === 'actor' ? 'class' : (m[1] as ApiKind);
    return { kind, names: [m[2]] };
  }
  m = s.match(/^(prefix|infix|postfix)\s+func\s+([^\s(:]+)/);
  if (m) return { kind: 'operator', names: [m[2]] };
  m = s.match(/^func\s+(\w+|[^\w\s(:<]+)/);
  if (m) {
    const name = m[1];
    const isOp = !/^\w/.test(name);
    return { kind: isOp ? 'operator' : 'func', names: [name] };
  }
  m = s.match(/^(var|let)\s+(\w+)/);
  if (m) return { kind: 'var', names: [m[2]] };
  if (/^init[?!]?(?=\s*\()/.test(s)) return { kind: 'init', names: ['init'] };
  if (/^deinit\b/.test(s)) return null;
  if (/^subscript\b/.test(s)) return { kind: 'func', names: ['subscript'] };
  m = s.match(/^typealias\s+(\w+)/);
  if (m) return { kind: 'typealias', names: [m[1]] };
  m = s.match(/^associatedtype\s+(\w+)/);
  if (m) return { kind: 'associatedtype', names: [m[1]] };
  m = s.match(/^macro\s+(\w+)/);
  if (m) return { kind: 'macro', names: [m[1]] };
  return null;
}

/** Remove generic params suffix: "Foo<T>" -> "Foo". */
function cleanTypeName(tok: string): string {
  return tok.replace(/<.*>$/, '').replace(/[^.\w].*$/, '');
}

/** Cut implementation bodies / trailing brace: keep clean signature. */
function cutSignature(line: string): string {
  const idx = line.indexOf(' {');
  const sig = (idx >= 0 ? line.slice(0, idx) : line).trim();
  return sig.replace(/\s+/g, ' ');
}

/** Extract content of first balanced (...) group. */
function extractParenInner(line: string): string | null {
  const start = line.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return line.slice(start + 1, i);
    }
  }
  return null;
}

function isDeclStartLine(trimmed: string): boolean {
  return /^(public|open|package|extension|case|@)/.test(trimmed);
}

interface Scope {
  name: string;
  kind: 'type' | 'enum' | 'protocol' | 'extension';
  avail: AvailabilityInfo;
  /** Brace depth after the opening line. */
  depth: number;
}
function makeScope(name: string, kind: Scope['kind'], avail: AvailabilityInfo, depth: number): Scope {
  return { name, kind, avail, depth };
}
function isEnumScope(s: Scope): boolean {
  return s.kind === 'enum';
}

export function parseSwiftInterface(
  content: string,
  framework: string,
  filePath: string,
): ApiSymbol[] {
  const rawLines = content.split('\n');

  // Pass 1: join multi-line declarations (unbalanced parens), cap 8 lines.
  const lines: { text: string; lineNumber: number }[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const start = i + 1;
    let text = rawLines[i];
    if (isDeclStartLine(text.trimStart()) && parenDepth(text) > 0) {
      let j = i;
      while (parenDepth(text) > 0 && j + 1 < rawLines.length && j - i < 8) {
        j++;
        text += ' ' + rawLines[j].trim();
      }
      lines.push({ text, lineNumber: start });
      i = j + 1;
    } else {
      lines.push({ text, lineNumber: start });
      i++;
    }
  }

  const symbols: ApiSymbol[] = [];
  const stack: Scope[] = [];
  let pending: AvailabilityInfo[] = [];
  let depth = 0;

  const popScopes = () => {
    // Single-line decls (`public struct S {`) open AND close on the same line:
    // don't pop the scope we just pushed (depth equal) — it ends on the next
    // line whose brace depth returns below. Only pop strictly deeper scopes.
    while (stack.length > 0 && stack[stack.length - 1].depth > depth) stack.pop();
  };

  const emit = (
    name: string,
    kind: ApiKind,
    signature: string,
    avail: AvailabilityInfo,
    lineNumber: number,
    parentType?: string,
  ) => {
    symbols.push({
      name,
      kind,
      framework,
      module: framework,
      lang: 'swift',
      signature,
      availability: avail.raw,
      minIOSVersion: avail.introducedIn,
      introducedIn: avail.introducedIn,
      deprecatedIn: avail.deprecatedIn,
      obsoletedIn: avail.obsoletedIn,
      renamedTo: avail.renamedTo,
      unavailable: avail.unavailable,
      deprecated: avail.deprecated,
      parentType,
      filePath,
      lineNumber,
    });
  };

  for (const { text: raw, lineNumber } of lines) {
    const opens = countChar(raw, '{');
    const closes = countChar(raw, '}');
    const line = raw.trim();

    if (!line || line.startsWith('import ') || line.startsWith('#')) {
      depth += opens - closes;
      popScopes();
      continue; // blank lines / imports keep pending availability
    }

    // @available on its own line, or trailing other attributes
    // (e.g. `@_hasMissingDesignatedInitializers @available(iOS 26.0, ...)`).
    if (line.includes('@available')) {
      const strippedProbe = stripLeadingAttributes(line);
      const isDeclLine = /^(public|open|package)\b/.test(strippedProbe) || /^extension\b/.test(strippedProbe);
      if (!isDeclLine) {
        for (const inner of extractAvailableInners(line)) {
          pending.push(parseSwiftAvailable(inner));
        }
        depth += opens - closes;
        popScopes();
        continue;
      }
      // Same-line @available + decl (rare): attach directly.
      for (const inner of extractAvailableInners(line)) {
        pending.push(parseSwiftAvailable(inner));
      }
    }

    // Non-public decls (internal/private/fileprivate) are never indexed.
    const nonPubProbe = stripLeadingAttributes(line);
    if (SWIFT_NONPUBLIC.test(nonPubProbe)) {
      pending = [];
      depth += opens - closes;
      popScopes();
      continue;
    }

    const stripped = stripLeadingAttributes(line);

    // extension Scope (availability on this line applies to all members inside)
    const ext = stripped.match(/^extension\s+([^\s{]+)/);
    if (ext) {
      const avail = inheritAvail(
        stack.length > 0 ? stack[stack.length - 1].avail : null,
        mergeAvailability(pending),
      );
      pending = [];
      const name = cleanTypeName(ext[1]);
      emit(name, 'extension', cutSignature(line), avail, lineNumber, name);
      if (opens > 0) {
        stack.push(makeScope(name, 'extension', avail, depth + opens - closes));
      }
      depth += opens - closes;
      popScopes();
      continue;
    }

    // Swift protocol `@objc optional` / bare `optional` member marker.
    // Must run before decl matching: `optional` is not a kind keyword.
    if (stack.length > 0 && stack[stack.length - 1].kind === 'protocol') {
      const noAttr = stripped
        .replace(/^@objc\s+(optional|required)\b\s*/, '')
        .replace(/^(optional|required)\b\s*/, '');
      if (noAttr !== stripped) {
        const optDecl = matchSwiftDecl(stripPublicPrefix(noAttr) ?? noAttr);
        if (optDecl && optDecl.names.length > 0) {
          const scope = stack[stack.length - 1];
          const avail = inheritAvail(scope.avail, mergeAvailability(pending));
          pending = [];
          for (const n of optDecl.names) {
            emit(n, optDecl.kind, `@optional ${cutSignature(line)}`, avail, lineNumber, scope.name);
          }
          depth += opens - closes;
          popScopes();
          continue;
        }
      }
    }

    // public / open / package declaration (modifiers may sit on both sides:
    // `nonisolated public func`, `@objc override dynamic public init`, ...)
    const pubRest = stripPublicPrefix(stripped);
    if (pubRest !== null) {
      const decl = matchSwiftDecl(pubRest);
      const scopeAvail = stack.length > 0 ? stack[stack.length - 1].avail : null;
      if (decl) {
        const avail = inheritAvail(scopeAvail, mergeAvailability(pending));
        pending = [];
        const parent =
          stack.length > 0 && (decl.kind === 'func' || decl.kind === 'var' || decl.kind === 'init' ||
            decl.kind === 'operator' || decl.kind === 'macro' ||
            decl.kind === 'typealias' || decl.kind === 'associatedtype' || decl.kind === 'case')
            ? stack[stack.length - 1].name
            : undefined;
        for (const n of decl.names) emit(n, decl.kind, cutSignature(line), avail, lineNumber, parent);
        if (
          (decl.kind === 'class' || decl.kind === 'struct' || decl.kind === 'enum' ||
            decl.kind === 'protocol') &&
          opens > 0
        ) {
          stack.push(makeScope(
            decl.names[0],
            decl.kind === 'enum' ? 'enum' : decl.kind === 'protocol' ? 'protocol' : 'type',
            avail,
            depth + opens - closes,
          ));
        }
      } else {
        pending = []; // unrecognized public line: drop pending to avoid misattach
      }
      depth += opens - closes;
      popScopes();
      continue;
    }

    // enum case without access prefix, inside enum scope
    const cm = stripped.match(/^case\s+(.+)$/);
    if (cm && stack.length > 0 && isEnumScope(stack[stack.length - 1])) {
      const scope = stack[stack.length - 1];
      const avail = inheritAvail(scope.avail, mergeAvailability(pending));
      pending = [];
      for (const part of splitTopLevel(cm[1].replace(/\s*\{\s*$/, ''))) {
        const nm = part.trim().match(/^(\w+)/)?.[1];
        if (nm) emit(nm, 'case', cutSignature(line), avail, lineNumber, scope.name);
      }
      depth += opens - closes;
      popScopes();
      continue;
    }

    // Bare members inside `public protocol` scope are public API
    // (Apple emits `func runTest(...)`, `associatedtype Body`, ... bare).
    // Bare members inside struct/class/enum/extension are NOT (internal by default).
    // NOTE: stripPublicPrefix returns null when there is no public/open/package,
    // so match the bare line directly with matchSwiftDecl here.
    if (stack.length > 0 && stack[stack.length - 1].kind === 'protocol') {
      const scope = stack[stack.length - 1];
      const decl = matchSwiftDecl(stripped);
      if (decl && (decl.kind === 'func' || decl.kind === 'var' || decl.kind === 'init' ||
        decl.kind === 'operator' || decl.kind === 'typealias' ||
        decl.kind === 'associatedtype' || decl.kind === 'macro')) {
        const avail = inheritAvail(scope.avail, mergeAvailability(pending));
        pending = [];
        for (const n of decl.names) {
          emit(n, decl.kind, cutSignature(line), avail, lineNumber, scope.name);
        }
        depth += opens - closes;
        popScopes();
        continue;
      }
    }

    depth += opens - closes;
    popScopes();
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// ObjC header parser
// ---------------------------------------------------------------------------

const OBJC_MACRO_RE =
  /\b(API_AVAILABLE|API_DEPRECATED_WITH_REPLACEMENT|API_DEPRECATED|API_UNAVAILABLE|NS_AVAILABLE_IOS|NS_CLASS_AVAILABLE_IOS|NS_AVAILABLE|NS_DEPRECATED_IOS|NS_DEPRECATED)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

function foldObjCMacro(kind: string, args: string, avail: AvailabilityInfo): void {
  const nums = [...args.matchAll(/(\d+(?:[._]\d+)?)/g)]
    .map((m) => parseVersionToken(m[1]))
    .filter((v): v is number => v !== null);
  const minInto = (v: number) => {
    if (v < avail.introducedIn) avail.introducedIn = v;
  };
  switch (kind) {
    case 'API_AVAILABLE': {
      const m = args.match(/ios\s*\(\s*([0-9._]+)/i);
      if (m) {
        const v = parseVersionToken(m[1]);
        if (v !== null) minInto(v);
      }
      break;
    }
    case 'API_DEPRECATED_WITH_REPLACEMENT': {
      const r = args.match(/"([^"]+)"/);
      if (r && !avail.renamedTo) avail.renamedTo = r[1];
    }
    // fallthrough
    case 'API_DEPRECATED': {
      const m = args.match(/ios\s*\(\s*([0-9._]+)\s*(?:,\s*([0-9._]+))?/i);
      if (m) {
        const a = parseVersionToken(m[1]);
        if (a !== null) minInto(a);
        if (m[2]) {
          const b = parseVersionToken(m[2]);
          if (b !== null) avail.deprecatedIn = b;
        }
      }
      avail.deprecated = true;
      break;
    }
    case 'API_UNAVAILABLE': {
      // Bare `ios` (no version) = unavailable on iOS. `tvos`/`watchos`-only does not count.
      if (/(^|[,\s])ios($|[,\s])/i.test(args) && !/ios\s*\(/i.test(args)) {
        avail.unavailable = true;
      }
      break;
    }
    case 'NS_AVAILABLE_IOS':
    case 'NS_CLASS_AVAILABLE_IOS': {
      if (nums[0] !== undefined) minInto(nums[0]);
      break;
    }
    case 'NS_AVAILABLE': {
      // NS_AVAILABLE(macosVer, iosVer)
      if (nums[1] !== undefined) minInto(nums[1]);
      else if (nums[0] !== undefined) minInto(nums[0]);
      break;
    }
    case 'NS_DEPRECATED_IOS': {
      // (iosIntroduced, iosDeprecated, ...)
      if (nums[0] !== undefined) minInto(nums[0]);
      if (nums[1] !== undefined) avail.deprecatedIn = nums[1];
      avail.deprecated = true;
      break;
    }
    case 'NS_DEPRECATED': {
      // (macIntro, macDep, iosIntro, iosDep, ...)
      if (nums[2] !== undefined) minInto(nums[2]);
      if (nums[3] !== undefined) avail.deprecatedIn = nums[3];
      avail.deprecated = true;
      break;
    }
  }
}

function extractObjCAvailability(line: string): {
  clean: string;
  avail: AvailabilityInfo;
  rawMacros: string[];
} {
  const avail = unknownAvail();
  const raws: string[] = [];
  const clean = line
    .replace(OBJC_MACRO_RE, (full, kind: string, args: string) => {
      raws.push(full);
      foldObjCMacro(kind, args, avail);
      return ' ';
    })
    .replace(/\s+/g, ' ');
  avail.raw = raws.join(' ');
  return { clean, avail, rawMacros: raws };
}

/**
 * Merge standalone-line availability (pending) with inline suffixes.
 * Inline wins for introduced (more specific); deprecation/obsoleted/renamed/
 * unavailable union. Either side may be null/empty.
 */
export function mergeObjCAvail(
  pending: AvailabilityInfo | null,
  inline: AvailabilityInfo,
): AvailabilityInfo {
  if (!pending || !pending.raw) return inline;
  if (!inline.raw) return pending;
  return {
    raw: `${pending.raw} ${inline.raw}`,
    introducedIn: Math.min(pending.introducedIn, inline.introducedIn),
    deprecatedIn: pending.deprecatedIn ?? inline.deprecatedIn,
    obsoletedIn: pending.obsoletedIn ?? inline.obsoletedIn,
    renamedTo: pending.renamedTo ?? inline.renamedTo,
    unavailable: pending.unavailable || inline.unavailable,
    deprecated: pending.deprecated || inline.deprecated,
  };
}

/** First selector chunk list: "a:(..)x b:(..)y;" -> "a:b:". Nullary -> method name.
 * Stops at trailing macros (NS_SWIFT_NAME(...) etc.) so they don't leak into
 * the selector. */
function objcSelector(cleanAfterParen: string): string {
  const cut = cleanAfterParen.split(/\bNS_[A-Z][A-Z_0-9]*\b/)[0];
  const chunks = [...cut.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  if (chunks.length > 0) return chunks.map((c) => c + ':').join('');
  return cut.trim().match(/^(\w+)/)?.[1] ?? 'unknown';
}

export function parseObjCHeader(
  content: string,
  framework: string,
  filePath: string,
): ApiSymbol[] {
  const lines = content.split('\n');
  const symbols: ApiSymbol[] = [];
  let pendingDoc: string[] = [];
  let inBlockComment = false;
  let blockBuf: string[] = [];
  let inEnum: { name: string; avail: AvailabilityInfo } | null = null;
  let pendingEnum: { name: string; avail: AvailabilityInfo } | null = null;
  let currentScope: { name: string; isCategory: boolean } | null = null;
  /** Standalone availability-macro line(s) waiting for the next decl. */
  let pendingAvail: AvailabilityInfo | null = null;
  // Multiline ObjC method decls: join continuation lines (typeIdentifier: ...).
  let pendingMethod: { text: string; raw: string; lineNumber: number } | null = null;

  /**
   * Swift `@objc optional` / bare `optional` member marker inside protocols.
   * ObjC `@optional`/`@required` handled by the same variable.
   */
  let optionality: 'optional' | 'required' | null = null;

  const takeDoc = (): string | undefined => {
    const d = pendingDoc.slice(-15).join('\n').trim();
    pendingDoc = [];
    return d || undefined;
  };

  const emit = (
    name: string,
    kind: ApiKind,
    signature: string,
    avail: AvailabilityInfo,
    lineNumber: number,
    parentType?: string,
    docComment?: string,
  ) => {
    symbols.push({
      name,
      kind,
      framework,
      module: framework,
      lang: 'objc',
      signature,
      availability: avail.raw,
      minIOSVersion: avail.introducedIn,
      introducedIn: avail.introducedIn,
      deprecatedIn: avail.deprecatedIn,
      obsoletedIn: avail.obsoletedIn,
      renamedTo: avail.renamedTo,
      unavailable: avail.unavailable,
      deprecated: avail.deprecated,
      parentType,
      docComment,
      filePath,
      lineNumber,
    });
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNumber = idx + 1;
    let raw = lines[idx];
    let line = raw.trim();

    // --- comments -> pendingDoc ---
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end >= 0) {
        blockBuf.push(line.slice(0, end));
        const body = blockBuf
          .join(' ')
          .replace(/^\s*\*\s?/gm, '')
          .trim();
        if (body) pendingDoc.push(body);
        blockBuf = [];
        inBlockComment = false;
        line = line.slice(end + 2).trim();
        if (!line) continue;
      } else {
        blockBuf.push(line);
        continue;
      }
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end >= 0) {
        const body = line
          .slice(2, end)
          .replace(/^\s*\*\s?/gm, '')
          .trim();
        if (body) pendingDoc.push(body);
        line = line.slice(end + 2).trim();
        if (!line) continue;
      } else {
        blockBuf.push(line.slice(2));
        inBlockComment = true;
        continue;
      }
    }
    if (line.startsWith('//')) {
      pendingDoc.push(line.replace(/^\/\/\s?/, ''));
      continue;
    }
    if (!line || line.startsWith('#')) continue; // keep pendingDoc across blanks/imports

    // --- trailing `//` comment on a code line (e.g. `; // default is 0.0`) ---
    // Must run before decl regexes, else the comment tail corrupts name capture.
    line = line.replace(/\s+\/\/.*$/, '').trim();
    if (!line) continue;

    // --- multiline method join: a `-/+` line without closing `;` continues ---
    if (pendingMethod) {
      pendingMethod.text += ' ' + line;
      pendingMethod.raw += ' ' + raw.trim();
      if (/;[ \t]*(\/\/.*)?$/.test(line)) {
        line = pendingMethod.text;
        raw = pendingMethod.raw;
        pendingMethod = null;
      } else {
        continue;
      }
    } else if (/^[-+]\s*\(/.test(line) && !/;[ \t]*(\/\/.*)?$/.test(line)) {
      pendingMethod = { text: line, raw, lineNumber };
      continue;
    }

    // --- availability macros: inline suffixes + standalone macro lines ---
    // Pattern 3 (old ObjC style): `API_AVAILABLE(ios(11.0))` alone on its own
    // line applies to the decl on the NEXT line (mirrors Swift @available).
    const { clean, avail: inlineAvail } = extractObjCAvailability(line);
    line = clean.trim();
    if (!line || line === ';') {
      if (inlineAvail.raw && !inEnum) {
        pendingAvail = pendingAvail ? mergeObjCAvail(pendingAvail, inlineAvail) : inlineAvail;
      }
      continue;
    }
    // Merge standalone-line availability with inline suffixes on the decl line.
    // Inline wins for introduced; deprecation/unavailable union.
    const useAvail = mergeObjCAvail(pendingAvail, inlineAvail);
    pendingAvail = null;

    // --- NS_ENUM member capture ---
    // Members inherit the enum's availability (inEnum.avail from the typedef),
    // merged with any member-level inline macro (inline wins for introduced).
    if (inEnum) {
      if (/^}/.test(line)) {
        inEnum = null;
        continue;
      }
      const em = line.match(/^(\w+)\s*(=[^,]*)?,?\s*$/);
      if (em) {
        emit(em[1], 'case', raw.trim().replace(/\s+/g, ' '),
          mergeObjCAvail(inEnum.avail, inlineAvail), lineNumber, inEnum.name, takeDoc());
      }
      continue;
    }
    if (pendingEnum && /^\{/.test(line)) {
      inEnum = pendingEnum;
      pendingEnum = null;
      continue;
    }
    pendingEnum = null;

    // --- declarations (ObjC members live inside @interface..@end scope) ---
    // @interface may carry prefix macros on the same line:
    // `UIKIT_EXTERN API_AVAILABLE(ios(13.0)) @interface UIBezierPath ...`
    let m = line.match(/(?:^|[\s*])@interface\s+(\w+)(?:\s*\((\w+)\))?/);
    if (m) {
      const doc = takeDoc();
      if (m[2]) {
        emit(`${m[1]}(${m[2]})`, 'extension', line, useAvail, lineNumber, m[1], doc);
        currentScope = { name: m[1], isCategory: true };
      } else {
        emit(m[1], 'class', line, useAvail, lineNumber, undefined, doc);
        currentScope = { name: m[1], isCategory: false };
      }
      continue;
    }
    if (/^@implementation\b/.test(line) || /^@end\b/.test(line)) {
      if (/^@end/.test(line)) pendingDoc = [];
      currentScope = null;
      optionality = null;
      continue;
    }
    // @optional/@required inside protocols: sticky until the next marker
    const optM = line.match(/^@(optional|required)\b/);
    if (optM) {
      optionality = optM[1] as 'optional' | 'required';
      continue;
    }
    m = line.match(/^@protocol\s+(\w+)\s*(<[^;]*)?;?\s*$/);
    if (m) {
      if (line.endsWith(';') && !m[2]) continue; // forward declaration: skip
      emit(m[1], 'protocol', line, useAvail, lineNumber, undefined, takeDoc());
      currentScope = { name: m[1], isCategory: false };
      continue;
    }
    m = line.match(/^@property\s*(?:\([^)]*\))?\s*(.+?)\s*;?\s*$/);
    if (m) {
      const nm = m[1].match(/(\w+)\s*(?:=\s*[^;]+)?\s*;?\s*$/)?.[1];
      if (nm) {
        const sig = optionality === 'optional' && currentScope ? `@optional ${line}` : line;
        emit(nm, 'var', sig, useAvail, lineNumber, currentScope?.name, takeDoc());
      }
      continue;
    }
    m = line.match(/^[-+]\s*\([^)]*\)\s*([\s\S]+?)\s*;?\s*$/);
    if (m) {
      const sig = optionality === 'optional' && currentScope ? `@optional ${line}` : line;
      emit(objcSelector(m[1]), 'func', sig, useAvail, lineNumber, currentScope?.name, takeDoc());
      continue;
    }
    m = line.match(/^typedef\s+(NS_ENUM|NS_OPTIONS|NS_CLOSED_ENUM)\s*\(\s*[^,]+,\s*(\w+)\s*\)\s*(\{?)\s*;?\s*$/);
    if (m) {
      emit(m[2], 'enum', line, useAvail, lineNumber, undefined, takeDoc());
      // Enum members inherit the enum's own availability (e.g. ARSessionRunOptions
      // iOS 11 from the standalone macro line above the typedef).
      if (m[3] === '{' || line.includes('{')) {
        inEnum = { name: m[2], avail: useAvail };
      } else {
        pendingEnum = { name: m[2], avail: useAvail };
      }
      continue;
    }
    if (/^typedef\b/.test(line)) {
      const doc = takeDoc();
      const bm = line.match(/\^(\w+)/); // block typedef: (^Name)
      if (bm) {
        emit(bm[1], 'typealias', line, useAvail, lineNumber, undefined, doc);
        continue;
      }
      const tm = line.match(/(\w+)\s*;\s*$/);
      if (tm && !/^(typedef|struct|enum|union)$/.test(tm[1])) {
        emit(tm[1], 'typealias', line, useAvail, lineNumber, undefined, doc);
      }
      continue;
    }
    m = line.match(/^(?:typedef\s+)?(enum|struct|union)\s+(\w+)\s*\{?/);
    if (m && !line.includes('(')) {
      emit(m[2], m[1] === 'struct' ? 'struct' : 'enum', line, useAvail, lineNumber, undefined, takeDoc());
      continue;
    }
    m = line.match(/^(extern|FOUNDATION_EXPORT|NS_EXPORT|UIKIT_EXTERN|APPKIT_EXTERN|WATCHKIT_EXTERN|SWIFT_CLASS_EXTRA)\b\s*([\s\S]*)$/);
    if (m) {
      const rest = m[2].trim();
      const fm = rest.match(/(\w+)\s*\(/);
      const doc = takeDoc();
      if (fm && rest.includes('(') && !/typedef/.test(rest)) {
        emit(fm[1], 'func', line, useAvail, lineNumber, undefined, doc);
      } else {
        const vm = rest.match(/(\w+)\s*(?:\[[^\]]*\])?\s*(?:=\s*[^;]+)?\s*;?\s*$/);
        if (vm) emit(vm[1], 'var', line, useAvail, lineNumber, undefined, doc);
      }
      continue;
    }
    m = line.match(/^static\s+(?:const\s+)?[\w\s:*<>]+\s+(\w+)\s*(?:=\s*[^;]+)?\s*;/);
    if (m) {
      emit(m[1], 'var', line, useAvail, lineNumber, undefined, takeDoc());
      continue;
    }
    // Unrecognized: keep pendingDoc (next decl may still own it) but cap growth.
    if (pendingDoc.length > 30) pendingDoc = pendingDoc.slice(-15);
  }

  return symbols;
}
