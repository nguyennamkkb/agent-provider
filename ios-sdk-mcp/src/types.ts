export type ApiKind =
  | 'struct' | 'class' | 'enum' | 'protocol'
  | 'func' | 'var' | 'typealias' | 'extension' | 'init' | 'operator'
  | 'macro' | 'case' | 'associatedtype';

export type ApiLang = 'swift' | 'objc';

export interface ApiSymbol {
  name: string;
  kind: ApiKind;
  framework: string;
  module: string;
  /** 'swift' | 'objc' */
  lang: ApiLang;
  signature: string;
  /** Raw availability text (compat): joined @available(...) / ObjC macros */
  availability: string;
  /** = introducedIn (compat with v1). UNKNOWN_VERSION when unparseable. */
  minIOSVersion: number;
  /** iOS version as major*10000+minor*100, e.g. 180000 = iOS 18.0 */
  introducedIn: number;
  deprecatedIn: number | null;
  obsoletedIn: number | null;
  renamedTo?: string;
  unavailable: boolean;
  deprecated: boolean;
  parentType?: string;
  docComment?: string;
  filePath: string;
  lineNumber: number;
}

export interface FrameworkInfo {
  name: string;
  path: string;
  apiCount: number;
  minIOSVersion: number;
  isNew: boolean;
}

export interface SearchResult {
  name: string;
  kind: string;
  framework: string;
  lang?: string;
  parentType?: string;
  signature: string;
  availability: string;
  introducedIn: number;
  deprecatedIn: number | null;
  renamedTo?: string;
}

export interface TypeMember {
  name: string;
  kind: string;
  framework: string;
  lang?: string;
  parentType?: string;
  signature: string;
  availability: string;
  introducedIn: number;
  deprecatedIn: number | null;
}

export interface DeprecatedApi extends SearchResult {
  unavailable: boolean;
  obsoletedIn: number | null;
}

export interface DocGuide {
  topic: string;
  framework?: string;
  symbol?: string;
  snippet: string;
}
