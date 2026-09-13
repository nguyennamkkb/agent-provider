import type { ApiSymbol } from './types.js';

const IOS_VERSION_MAP: Record<string, number> = {};
for (let major = 2; major <= 30; major++) {
  IOS_VERSION_MAP[`${major}.0`] = major * 10000;
  for (let minor = 1; minor <= 5; minor++) {
    IOS_VERSION_MAP[`${major}.${minor}`] = major * 10000 + minor * 100;
  }
}

function extractIOSVersion(availability: string): number {
  const match = availability.match(/iOS\s+(\d+\.\d+)/);
  if (!match) return 999999;
  return IOS_VERSION_MAP[match[1]] ?? parseInt(match[1].replace('.', '')) * 100;
}

const SWIFT_DECL_KINDS: { pattern: RegExp; kind: ApiSymbol['kind'] }[] = [
  { pattern: /^public\s+(final\s+)?class\s+/, kind: 'class' },
  { pattern: /^public\s+(final\s+)?struct\s+/, kind: 'struct' },
  { pattern: /^public\s+(final\s+)?enum\s+/, kind: 'enum' },
  { pattern: /^public\s+(final\s+)?actor\s+/, kind: 'class' },
  { pattern: /^public\s+protocol\s+/, kind: 'protocol' },
  { pattern: /^public\s+(static\s+)?func\s+/, kind: 'func' },
  { pattern: /^public\s+(static\s+)?var\s+/, kind: 'var' },
  { pattern: /^public\s+(static\s+)?let\s+/, kind: 'var' },
  { pattern: /^public\s+typealias\s+/, kind: 'typealias' },
  { pattern: /^public\s+init\s*\(/, kind: 'init' },
  { pattern: /^public\s+prefix\s+func\s+/, kind: 'operator' },
  { pattern: /^public\s+subscript\s*\(/, kind: 'func' },
];

function extractDeclName(line: string, kind: ApiSymbol['kind']): string {
  if (kind === 'init') return 'init';
  const cleaned = line.replace(/@\w+\s+/g, '').trim();
  if (kind === 'operator') {
    const m = cleaned.match(/func\s+(\S+)/);
    return m ? m[1] : 'operator';
  }
  const patterns: Record<string, RegExp> = {
    class: /class\s+(\w[\w.]*)/,
    struct: /struct\s+(\w[\w.]*)/,
    enum: /enum\s+(\w[\w.]*)/,
    protocol: /protocol\s+(\w[\w.]*)/,
    func: /func\s+(\w[\w.]*)/,
    var: /var\s+(\w[\w.]*)/,
    let: /let\s+(\w[\w.]*)/,
    typealias: /typealias\s+(\w[\w.]*)/,
    subscript: /subscript/,
  };
  const m = cleaned.match(patterns[kind] ?? /(\w+)/);
  return m ? m[1] : cleaned.slice(0, 60);
}

export function parseSwiftInterface(
  content: string,
  framework: string,
  filePath: string
): ApiSymbol[] {
  const lines = content.split('\n');
  const symbols: ApiSymbol[] = [];
  let pendingAvailability: string[] = [];
  let pendingDocComment: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Collect @available
    if (line.startsWith('@available(') || line.startsWith('@available (')) {
      const availMatch = line.match(/@available\s*\((.+?)\)/);
      if (availMatch) pendingAvailability.push(availMatch[1]);
      continue;
    }

    // Collect doc comments
    if (line.startsWith('///') || line.startsWith('/**')) {
      pendingDocComment.push(line.replace(/^\/\/[/ ]?\s?/, ''));
      continue;
    }

    // Skip non-public
    if (!line.startsWith('public ') && !line.startsWith('@_has')) {
      if (line.startsWith('@objc') || line.startsWith('@_disfavoredOverload') || line.startsWith('@_exported') || line.startsWith('@preconcurrency') || line.startsWith('@dynamicMemberLookup') || line.startsWith('@frozen') || line.startsWith('@propertyWrapper') || line.startsWith('@available')) {
        continue;
      }
      pendingAvailability = [];
      pendingDocComment = [];
      continue;
    }

    const availability = pendingAvailability.join('; ');
    pendingAvailability = [];
    const docComment = pendingDocComment.join('\n');
    pendingDocComment = [];

    // Extension declaration
    const extMatch = line.match(/^(?:public\s+)?extension\s+([\w:]+)/);
    if (extMatch) {
      symbols.push({
        name: extMatch[1].replace(/::/g, '.'),
        kind: 'extension',
        framework,
        module: framework,
        signature: line,
        availability,
        minIOSVersion: extractIOSVersion(availability),
        parentType: extMatch[1].replace(/::/g, '.'),
        filePath,
        lineNumber: i + 1,
      });
      continue;
    }

    // Match declaration
    for (const { pattern, kind } of SWIFT_DECL_KINDS) {
      if (pattern.test(line)) {
        const name = extractDeclName(line, kind);
        symbols.push({
          name: name.replace(/::/g, '.'),
          kind,
          framework,
          module: framework,
          signature: line,
          availability,
          minIOSVersion: extractIOSVersion(availability),
          filePath,
          lineNumber: i + 1,
          docComment: docComment || undefined,
        });
        break;
      }
    }
  }

  return symbols;
}

export function parseObjCHeader(
  content: string,
  framework: string,
  filePath: string
): ApiSymbol[] {
  const lines = content.split('\n');
  const symbols: ApiSymbol[] = [];
  let pendingAvailability = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Collect API_AVAILABLE
    const availMatch = line.match(/API_AVAILABLE\s*\((.+?)\)/);
    if (availMatch) {
      pendingAvailability = availMatch[1];
      continue;
    }

    // Match ObjC methods
    const methodMatch = line.match(/^[-+]\s*\(([^)]+)\)\s*(\S+)/);
    if (methodMatch && pendingAvailability) {
      symbols.push({
        name: methodMatch[2],
        kind: 'func',
        framework,
        module: framework,
        signature: line,
        availability: pendingAvailability,
        minIOSVersion: extractIOSVersion(pendingAvailability.replace(/\(+/g, '').replace(/\)+/g, '')),
        filePath,
        lineNumber: i + 1,
      });
    }

    // Match @interface
    const ifaceMatch = line.match(/^@interface\s+(\w+)/);
    if (ifaceMatch && pendingAvailability) {
      symbols.push({
        name: ifaceMatch[1],
        kind: 'class',
        framework,
        module: framework,
        signature: line,
        availability: pendingAvailability,
        minIOSVersion: extractIOSVersion(pendingAvailability.replace(/\(+/g, '').replace(/\)+/g, '')),
        filePath,
        lineNumber: i + 1,
      });
    }

    if (line === '@end' || line === '') {
      pendingAvailability = '';
    }
  }

  return symbols;
}
