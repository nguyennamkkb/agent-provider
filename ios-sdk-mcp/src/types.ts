export interface ApiSymbol {
  name: string;
  kind: 'struct' | 'class' | 'enum' | 'protocol' | 'func' | 'var' | 'typealias' | 'extension' | 'init' | 'operator';
  framework: string;
  module: string;
  signature: string;
  availability: string;
  minIOSVersion: number;
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
  signature: string;
  availability: string;
}

export interface TypeHierarchy {
  name: string;
  kind: string;
  framework: string;
  supertype?: string;
  protocols: string[];
  extensions: { types: string[]; availability: string }[];
}
