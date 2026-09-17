import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  packList,
  packMembers,
  trimAvailability,
  declFromMarker,
  isRealDeprecation,
} from '../src/pack.js';
import type { ConvertedHit, SdkFile } from '../src/convert.js';

const hit = (over: Partial<ConvertedHit> = {}): ConvertedHit => ({
  name: 'Foo', kind: 'struct', framework: 'SwiftUI', lang: 'swift', platform: 'ios',
  signature: 'public struct Foo', filePath: '/sdk/SwiftUI.swift', lineNumber: 10,
  ...over,
});

describe('trimAvailability: bỏ chuỗi khi đã có số', () => {
  it('bỏ khi introducedIn đủ diễn đạt', () => {
    const h = trimAvailability(hit({ availability: '@available(iOS 13.0, *)', introducedIn: 130000 }));
    expect(h.availability).toBeUndefined();
    expect(h.introducedIn).toBe(130000);
  });
  it('GIỮ khi unavailable / renamedTo / không parse được số', () => {
    expect(trimAvailability(hit({ availability: 'x', introducedIn: 1, unavailable: true })).availability).toBe('x');
    expect(trimAvailability(hit({ availability: 'x', introducedIn: 1, renamedTo: 'Bar' })).availability).toBe('x');
    expect(trimAvailability(hit({ availability: 'x' })).availability).toBe('x');
  });
});

describe('packList: hoist field chung, KHÔNG file/line', () => {
  it('field 1 giá trị -> lên header, biến mất khỏi item', () => {
    const p = packList([hit(), hit({ name: 'Bar' })]);
    expect(p.framework).toBe('SwiftUI');
    expect(p.platform).toBe('ios');
    expect(p.count).toBe(2);
    const apis = p.apis as Record<string, unknown>[];
    expect(apis[0].framework).toBeUndefined();
    expect(apis[0].name).toBe('Foo');
  });

  it('không filePath/lineNumber/bảng files trong output', () => {
    const p = packList([
      hit(),
      hit({ name: 'B', filePath: '/sdk/UIKit.swift', framework: 'UIKit' }),
      hit({ name: 'C', filePath: '/sdk/UIKit.swift', framework: 'UIKit' }),
    ]);
    expect(p).not.toHaveProperty('filePath');
    expect(p).not.toHaveProperty('files');
    const apis = p.apis as Record<string, unknown>[];
    for (const a of apis) {
      expect(a).not.toHaveProperty('filePath');
      expect(a).not.toHaveProperty('lineNumber');
      expect(a).not.toHaveProperty('line');
      expect(a).not.toHaveProperty('file');
    }
    // framework khác nhau -> KHÔNG hoist
    expect(p.framework).toBeUndefined();
    expect(apis[0].framework).toBe('SwiftUI');
  });
});

describe('packMembers: bỏ thứ kế thừa từ cha, KHÔNG file/line', () => {
  const parent = hit({ introducedIn: 130000, availability: '@available(iOS 13.0, *)' });
  it('member cùng version với cha -> bỏ version, chỉ còn kind+name', () => {
    const [m] = packMembers(parent, [
      hit({ name: 'axes', kind: 'var', parentType: 'Foo', introducedIn: 130000, availability: '@available(iOS 13.0, *)', lineNumber: 12 }),
    ], 'names');
    expect(m.framework).toBeUndefined();
    expect(m.parentType).toBeUndefined();
    expect(m.filePath).toBeUndefined();
    expect(m.lineNumber).toBeUndefined();
    expect(m).not.toHaveProperty('line');
    expect(m.introducedIn).toBeUndefined();
    expect(m.name).toBe('axes');
    expect(m.kind).toBe('var');
  });
  it('member version KHÁC cha -> giữ lại (thông tin thật)', () => {
    const [m] = packMembers(parent, [hit({ name: 'newer', introducedIn: 260000, lineNumber: 13 })], 'abstract');
    expect(m.introducedIn).toBe(260000);
    expect(m).not.toHaveProperty('lineNumber');
  });
});

describe('marker -> decl thật', () => {
  // convertLine đọc file trên đĩa (analyzeContext quét ngược lấy version/doc),
  // nên phải là file thật chứ không phải path bịa.
  // Thứ tự đúng như generated interface thật: doc -> @available -> (attribute) -> decl.
  const lines = [
    '/// A scene that presents an interface appropriate for Assistive Access.',
    '@available(iOS 26.0, macOS 26.0, tvOS 26.0, watchOS 26.0, *)',
    '@frozen',
    'public struct AssistiveAccess : Scene {',
    '}',
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
  const p = path.join(dir, 'SwiftUI.swift');
  fs.writeFileSync(p, lines.join('\n'));
  const file: SdkFile = { path: p, framework: 'SwiftUI', platform: 'ios', lang: 'swift' };

  it('nhảy qua attribute/comment để lấy dòng khai báo', () => {
    const h = declFromMarker(file, 1, lines);
    expect(h?.name).toBe('AssistiveAccess');
    expect(h?.kind).toBe('struct');
    expect(h?.introducedIn).toBe(260000);
    expect(h?.lineNumber).toBe(4);
  });

  it('không có decl trong tầm -> null (không bịa)', () => {
    const only = ['@available(iOS 26.0, *)', '', ''];
    const p2 = path.join(dir, 'Empty.swift');
    fs.writeFileSync(p2, only.join('\n'));
    expect(declFromMarker({ ...file, path: p2 }, 1, only)).toBeNull();
  });
});

describe('isRealDeprecation: sentinel 100000 không phải deprecated', () => {
  it('loại sentinel', () => {
    expect(isRealDeprecation('@available(iOS, introduced: 13.0, deprecated: 100000.0, message: "use X")')).toBe(false);
    expect(isRealDeprecation('@available(iOS, introduced: 13.0, deprecated: 100000)')).toBe(false);
  });
  it('giữ deprecation thật', () => {
    expect(isRealDeprecation('@available(iOS, introduced: 13.0, deprecated: 26.0)')).toBe(true);
    expect(isRealDeprecation('API_DEPRECATED("x", ios(11.0, 15.0))')).toBe(true);
  });
});
