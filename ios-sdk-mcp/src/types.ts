export type ApiKind =
  | 'struct' | 'class' | 'enum' | 'protocol'
  | 'func' | 'var' | 'typealias' | 'extension' | 'init' | 'operator'
  | 'macro' | 'case' | 'associatedtype';

export type ApiLang = 'swift' | 'objc';

/** SDK platform: ios | watchos | macos | tvos | xros (visionOS). */
export type SdkPlatform = 'ios' | 'watchos' | 'macos' | 'tvos' | 'xros';

/**
 * Parser output. `platform` (which SDK row came from) is assigned at index
 * time; `platforms` (per-platform versions parsed from @available) at parse time.
 */
export interface ParsedSymbol extends Omit<ApiSymbol, 'platform' | 'platforms'> {
  platforms?: Partial<Record<SdkPlatform, number>>;
}

export interface ApiSymbol {
  name: string;
  kind: ApiKind;
  framework: string;
  module: string;
  /** 'swift' | 'objc' */
  lang: ApiLang;
  /** Which SDK this row was indexed from. Same API can appear on many platforms. */
  platform: SdkPlatform;
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
  /** Platforms whose SDK contains this framework (deduped). */
  platforms: SdkPlatform[];
}

export interface SearchResult {
  name: string;
  kind: string;
  framework: string;
  lang?: string;
  /** Platforms where this API exists (deduped across SDKs). */
  platforms?: SdkPlatform[];
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

/** Compact member row for detail output: no redundant framework/lang/parent.
 * `availability` included only when it differs from the parent type's
 * (members can have their own @available, e.g. GridItem.== is iOS 26 in a iOS 14 type). */
export interface MemberSummary {
  name: string;
  kind: string;
  signature: string;
  availability?: string;
  introducedIn: number;
  deprecatedIn?: number;
  renamedTo?: string;
}

export interface ApiDetail extends ApiSymbol {
  /** Top direct members (compact, internal `_` APIs excluded by default). */
  members: MemberSummary[];
  /** Total member count (same filter) — call get_type_members for the full list. */
  memberCount: number;
  /** `renamedTo` target resolved to its own declaration (members stripped), if present. */
  renamedToDetail?: (ApiSymbol & { memberCount: number }) | null;
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
