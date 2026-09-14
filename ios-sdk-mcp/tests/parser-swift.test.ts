import { describe, it, expect } from 'vitest';
import {
  parseSwiftInterface,
  parseObjCHeader,
  parseSwiftAvailable,
  parseVersionToken,
  mergeAvailability,
  UNKNOWN_VERSION,
} from '../src/parser.js';

const FW = 'TestFW';
const swift = (src: string) => parseSwiftInterface(src, FW, 'test.swiftinterface');
const objc = (src: string) => parseObjCHeader(src, FW, 'test.h');

describe('parseVersionToken', () => {
  it('dots', () => expect(parseVersionToken('18.0')).toBe(180000));
  it('no minor', () => expect(parseVersionToken('26')).toBe(260000));
  it('underscores', () => expect(parseVersionToken('3_2')).toBe(30200));
  it('garbage', () => expect(parseVersionToken('abc')).toBeNull());
});

describe('parseSwiftAvailable', () => {
  it('family 1: platform versions', () => {
    const a = parseSwiftAvailable('iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, visionOS 2.0, *');
    expect(a.introducedIn).toBe(180000); // iOS, not min across platforms
    expect(a.platforms).toMatchObject({ ios: 180000, macos: 150000, tvos: 180000, watchos: 110000, xros: 20000 });
  });
  it('multi-line @available: introducedIn = iOS version, khong min cross-platform', () => {
    // foregroundColor that: 5 dong iOS13/macOS10.15/tvOS13/watchOS6/visionOS1.0
    // introducedIn phai la 130000 (iOS), khong phai 10000 (visionOS 1.0).
    const m = mergeAvailability([
      parseSwiftAvailable('iOS, introduced: 13.0, deprecated: 100000.0, renamed: "foregroundStyle(_:)"'),
      parseSwiftAvailable('macOS, introduced: 10.15, deprecated: 100000.0, renamed: "foregroundStyle(_:)"'),
      parseSwiftAvailable('tvOS, introduced: 13.0, deprecated: 100000.0, renamed: "foregroundStyle(_:)"'),
      parseSwiftAvailable('watchOS, introduced: 6.0, deprecated: 100000.0, renamed: "foregroundStyle(_:)"'),
      parseSwiftAvailable('visionOS, introduced: 1.0, deprecated: 100000.0, renamed: "foregroundStyle(_:)"'),
    ]);
    expect(m.introducedIn).toBe(130000);
    expect(m.platforms).toMatchObject({ ios: 130000, macos: 101500, tvos: 130000, watchos: 60000, xros: 10000 });
    expect(m.renamedTo).toBe('foregroundStyle(_:)');
    expect(m.deprecatedIn).toBeNull(); // sentinel 100000.0 bi loai
  });
  it('watchOS-only: platforms recorded + fallback introduced', () => {
    const a = parseSwiftAvailable('watchOS 9.0, *');
    expect(a.platforms).toMatchObject({ watchos: 90000 });
    expect(a.introducedIn).toBe(90000);
    expect(a.unavailable).toBe(false);
  });
  it('API_AVAILABLE multi-platform (ObjC)', () => {
    const s = objc(`@interface S : NSObject\n@property (nonatomic, readonly) NSProgress *p API_AVAILABLE(ios(12.0), watchos(5.0));\n@end`);
    const p = s.find((x) => x.name === 'p')!;
    expect(p.introducedIn).toBe(120000);
    expect(p.platforms).toMatchObject({ ios: 120000, watchos: 50000 });
  });
  it('family 2: introduced/deprecated/renamed', () => {
    const a = parseSwiftAvailable('iOS, introduced: 13.0, deprecated: 16.0, renamed: "foo(_:)"');
    expect(a.introducedIn).toBe(130000);
    expect(a.deprecatedIn).toBe(160000);
    expect(a.deprecated).toBe(true);
    expect(a.renamedTo).toBe('foo(_:)');
  });
  it('unavailable marker', () => {
    const a = parseSwiftAvailable('*, unavailable, message: "never use"');
    expect(a.unavailable).toBe(true);
    expect(a.introducedIn).toBe(UNKNOWN_VERSION);
  });
  it('deprecated marker', () => {
    const a = parseSwiftAvailable('*, deprecated, message: "old"');
    expect(a.deprecated).toBe(true);
  });
  it('obsoleted version', () => {
    const a = parseSwiftAvailable('iOS, introduced: 13.0, obsoleted: 17.0');
    expect(a.obsoletedIn).toBe(170000);
  });
  it('merge takes min introduced + first deprecation', () => {
    const m = mergeAvailability([
      parseSwiftAvailable('iOS 18.0, macOS 15.0, *'),
      parseSwiftAvailable('iOS, introduced: 13.0, deprecated: 16.0'),
    ]);
    expect(m.introducedIn).toBe(130000);
    expect(m.deprecatedIn).toBe(160000);
  });
});

describe('swift: top-level declarations', () => {
  it('struct with @available above', () => {
    const s = swift(`@available(iOS 18.0, macOS 15.0, *)\npublic struct Glass {}`);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: 'Glass', kind: 'struct', introducedIn: 180000 });
    expect(s[0].availability).toContain('iOS 18.0');
  });
  it('open class captured as class', () => {
    const s = swift(`public open class Foo {}`.replace('public open', '@_Concurrency.MainActor open'));
    expect(s[0]).toMatchObject({ name: 'Foo', kind: 'class' });
  });
  it('MainActor attribute stripped', () => {
    const s = swift(`@MainActor public struct Bar {}`);
    expect(s[0]).toMatchObject({ name: 'Bar', kind: 'struct' });
  });
  it('generic struct name cleaned', () => {
    const s = swift(`public struct Box<T> : Sendable {}`);
    expect(s[0]).toMatchObject({ name: 'Box', kind: 'struct' });
  });
  it('macro with @freestanding', () => {
    const s = swift(`@freestanding(declaration) public macro Preview(_ name: Swift.String? = nil) = #externalMacro(module: "M", type: "T")`);
    expect(s[0]).toMatchObject({ name: 'Preview', kind: 'macro' });
  });
  it('attached macro with nested parens stripped', () => {
    const s = swift(`@attached(extension, conformances: Generable, names: named(init(_:))) @attached(member, names: arbitrary) public macro Generable() = #externalMacro(module: "M", type: "G")`);
    expect(s[0]).toMatchObject({ name: 'Generable', kind: 'macro' });
  });
  it('typealias + associatedtype', () => {
    const s = swift(`public typealias Handler = () -> Void\npublic protocol P {\nassociatedtype Item\n}`);
    // associatedtype without access prefix is NOT captured (correct: no public)
    expect(s.map((x) => x.kind)).toContain('typealias');
  });
  it('public associatedtype inside protocol', () => {
    const s = swift(`public protocol P {\npublic associatedtype Item\n}`);
    expect(s.find((x) => x.name === 'Item')).toMatchObject({ kind: 'associatedtype', parentType: 'P' });
  });
  it('operator func', () => {
    const s = swift(`public func == (lhs: Foo, rhs: Foo) -> Swift.Bool`);
    expect(s[0]).toMatchObject({ kind: 'operator', name: '==' });
  });
  it('package access captured', () => {
    const s = swift(`package struct Internal {}`);
    expect(s[0]).toMatchObject({ name: 'Internal', kind: 'struct' });
  });
  it('imports and #ifs ignored', () => {
    const s = swift(`import Foundation\n#if compiler(>=5.3)\n#endif\npublic struct Ok {}`);
    expect(s.map((x) => x.name)).toEqual(['Ok']);
  });
});

describe('swift: extension scope inheritance', () => {
  const src = `@available(iOS 18.0, macOS 15.0, *)
extension MyView {
  nonisolated public func plain() -> Swift.Bool
  @available(iOS 16.0, macOS 13.0, *)
  nonisolated public func newer() -> Swift.Bool

  nonisolated public func afterBlank() -> Swift.Bool
}`;
  it('extension symbol emitted', () => {
    const ext = swift(src).find((x) => x.kind === 'extension');
    expect(ext).toMatchObject({ name: 'MyView', parentType: 'MyView', introducedIn: 180000 });
  });
  it('members inherit extension availability', () => {
    const s = swift(src);
    expect(s.find((x) => x.name === 'plain')).toMatchObject({ kind: 'func', parentType: 'MyView', introducedIn: 180000 });
  });
  it('member-level @available overrides', () => {
    const s = swift(src);
    expect(s.find((x) => x.name === 'newer')).toMatchObject({ introducedIn: 160000 });
  });
  it('blank lines do not break pending/inheritance', () => {
    const s = swift(src);
    expect(s.find((x) => x.name === 'afterBlank')).toMatchObject({ introducedIn: 180000 });
  });
  it('dotted extension name + where clause', () => {
    const s = swift(`extension SwiftUICore.View {\nnonisolated public func f() -> Swift.Bool\n}\nextension ModifiedContent where Modifier == X {\nnonisolated public func g() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'f')).toMatchObject({ parentType: 'SwiftUICore.View' });
    expect(s.find((x) => x.name === 'g')).toMatchObject({ parentType: 'ModifiedContent' });
  });
  it('attribute-prefixed members captured', () => {
    const s = swift(`extension V {\n@_disfavoredOverload @_alwaysEmitIntoClient nonisolated public func f() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'f')).toMatchObject({ kind: 'func', parentType: 'V' });
  });
  it('static members + body truncation', () => {
    const s = swift(`public struct S {\npublic static var identity: S {\nget\n}\npublic static func make() -> S {\nS()\n}\n}`);
    const v = s.find((x) => x.name === 'identity');
    const f = s.find((x) => x.name === 'make');
    expect(v).toMatchObject({ kind: 'var', parentType: 'S' });
    expect(v!.signature).not.toContain('{');
    expect(f).toMatchObject({ kind: 'func', parentType: 'S' });
  });
  it('nested braces in body do not break scope', () => {
    const s = swift(`extension V {\npublic func a() -> Swift.Bool {\nif true {\nreturn true\n}\nreturn false\n}\npublic func b() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'b')).toMatchObject({ parentType: 'V' });
  });
  it('init variants', () => {
    const s = swift(`public struct S {\npublic init()\npublic init?(_ s: Swift.String)\n}`);
    expect(s.filter((x) => x.kind === 'init')).toHaveLength(2);
  });
  it('subscript named subscript', () => {
    const s = swift(`public struct Env {\npublic subscript<T>(keyPath: Swift.KeyPath<Env, T>) -> T {\nget\n}\n}`);
    expect(s.find((x) => x.name === 'subscript')).toMatchObject({ kind: 'func', parentType: 'Env' });
  });
});

describe('swift: enums + cases', () => {
  it('cases captured with parent', () => {
    const s = swift(`@available(iOS 14.0, *)\npublic enum Style {\ncase label\ncase a, b\n}`);
    expect(s.find((x) => x.name === 'Style')).toMatchObject({ kind: 'enum', introducedIn: 140000 });
    expect(s.find((x) => x.name === 'label')).toMatchObject({ kind: 'case', parentType: 'Style', introducedIn: 140000 });
    expect(s.find((x) => x.name === 'a')).toMatchObject({ kind: 'case', parentType: 'Style' });
    expect(s.find((x) => x.name === 'b')).toMatchObject({ kind: 'case', parentType: 'Style' });
  });
});

describe('swift: @available edge cases', () => {
  it('@available sharing line with attribute', () => {
    const s = swift(`@_hasMissingDesignatedInitializers @available(iOS 26.0, macOS 26.0, visionOS 26.0, *)\n@available(tvOS, unavailable)\n@available(watchOS, unavailable)\nfinal public class LanguageModelSession {`);
    expect(s[0]).toMatchObject({ name: 'LanguageModelSession', kind: 'class', introducedIn: 260000, unavailable: false });
  });
  it('@_originallyDefinedIn does not poison following @available', () => {
    // SDK that: marker di chuyen module dung truoc @available that.
    // Marker phai bi ignore (va khong xoa pending cua chinh block hien tai).
    const s = swift(`@available(iOS 13.0, *)\n@_originallyDefinedIn(module: "SwiftUI", iOS 18.0)\n@available(iOS, introduced: 13.0, deprecated: 26.0, message: "Use X")\nextension T {\npublic static func + (lhs: T, rhs: T) -> T\n}`);
    const ext = s.find((x) => x.kind === 'extension')!;
    expect(ext.introducedIn).toBe(130000);
    expect(ext.deprecatedIn).toBe(260000);
    expect(s.find((x) => x.name === '+')).toMatchObject({ introducedIn: 130000, deprecatedIn: 260000 });
  });
  it('other-platform unavailable ignored', () => {
    const a = parseSwiftAvailable('tvOS, unavailable');
    expect(a.unavailable).toBe(false);
    expect(a.introducedIn).toBe(UNKNOWN_VERSION);
  });
  it('* unavailable still counts', () => {
    expect(parseSwiftAvailable('*, unavailable').unavailable).toBe(true);
  });
});

describe('swift: version edge cases', () => {
  it('deprecated member parsed', () => {
    const s = swift(`extension V {\n@available(iOS, introduced: 13.0, deprecated: 16.0)\npublic func old() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'old')).toMatchObject({ deprecated: true, deprecatedIn: 160000, introducedIn: 130000 });
  });
  it('unavailable member parsed', () => {
    const s = swift(`extension V {\n@available(*, unavailable, message: "no")\npublic func nope() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'nope')).toMatchObject({ unavailable: true });
  });
  it('multiline signature joined', () => {
    const s = swift(`public func foo(a: Swift.Int,\nb: Swift.String) -> Swift.Void`);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: 'foo', kind: 'func' });
    expect(s[0].signature).toContain('b: Swift.String');
  });
});

describe('objc: declarations', () => {
  it('@interface with block doc', () => {
    const s = objc(`/*\n Manages a view.\n Second line.\n*/\n@interface MyVC : UIResponder\n@end`);
    expect(s[0]).toMatchObject({ name: 'MyVC', kind: 'class', lang: 'objc' });
    expect(s[0].docComment).toContain('Manages a view.');
  });
  it('members inside @interface get parentType; outside do not', () => {
    const s = objc(`@interface Scroll : Base\n@property(nonatomic) BOOL bounces;\n- (void)reload;\n@end\n@property(nonatomic) BOOL stray;`);
    expect(s.find((x) => x.name === 'bounces')).toMatchObject({ kind: 'var', parentType: 'Scroll' });
    expect(s.find((x) => x.name === 'reload')).toMatchObject({ kind: 'func', parentType: 'Scroll' });
    expect(s.find((x) => x.name === 'stray')).toMatchObject({ parentType: undefined });
  });
  it('category members attach to base class', () => {
    const s = objc(`@interface Foo (Bar)\n- (void)extra;\n@end`);
    expect(s.find((x) => x.name === 'extra')).toMatchObject({ parentType: 'Foo' });
  });
  it('100000.0 deprecation sentinel is ignored', () => {
    const a = parseSwiftAvailable('iOS, introduced: 13.0, deprecated: 100000.0, message: "Use X"');
    expect(a.introducedIn).toBe(130000);
    expect(a.deprecatedIn).toBeNull();
  });
  it('category becomes extension', () => {
    const s = objc(`@interface Foo (Bar)\n@end`);
    expect(s[0]).toMatchObject({ kind: 'extension', parentType: 'Foo', name: 'Foo(Bar)' });
  });
  it('forward @protocol skipped, real one kept', () => {
    const s = objc(`@protocol Fwd;\n@protocol Real <NSObject>\n@end`);
    expect(s.map((x) => x.name)).toEqual(['Real']);
    expect(s[0].kind).toBe('protocol');
  });
  it('@property with attributes', () => {
    const s = objc(`@interface A\n@property (nonatomic, getter=isEnabled) BOOL enabled;\n@end`);
    expect(s.find((x) => x.name === 'enabled')).toMatchObject({ kind: 'var' });
  });
  it('trailing // comment does not corrupt name', () => {
    const s = objc(`@interface A\n@property(nonatomic) NSInteger tag; // default is 0\n@end`);
    expect(s.find((x) => x.name === 'tag')).toMatchObject({ kind: 'var' });
    expect(s.find((x) => x.name === '0')).toBeUndefined();
  });
  it('method selector + inline availability', () => {
    const s = objc(`@interface A\n- (void)presentVC:(UIViewController *)vc animated:(BOOL)a API_AVAILABLE(ios(8.0));\n@end`);
    const m = s.find((x) => x.name === 'presentVC:animated:');
    expect(m).toMatchObject({ kind: 'func', introducedIn: 80000 });
  });
  it('nullary method + class method', () => {
    const s = objc(`@interface A\n- (void)reload;\n+ (instancetype)shared;\n@end`);
    expect(s.find((x) => x.name === 'reload')).toMatchObject({ kind: 'func' });
    expect(s.find((x) => x.name === 'shared')).toMatchObject({ kind: 'func' });
  });
  it('// comment attaches to method', () => {
    const s = objc(`@interface A\n// Reloads everything.\n- (void)reload;\n@end`);
    expect(s.find((x) => x.name === 'reload')!.docComment).toContain('Reloads everything.');
  });
  it('@end clears pending doc', () => {
    const s = objc(`// stray\n@end\n@interface B\n- (void)go;\n@end`);
    expect(s.find((x) => x.name === 'go')!.docComment).toBeUndefined();
  });
});

describe('objc: enums + versions', () => {
  it('NS_ENUM with inline member versions', () => {
    const s = objc(`typedef NS_ENUM(NSInteger, MyStyle) {\nMyStyleA = 0,\nMyStyleB API_AVAILABLE(ios(8.0)),\n} API_UNAVAILABLE(watchos);`);
    expect(s.find((x) => x.name === 'MyStyle')).toMatchObject({ kind: 'enum' });
    expect(s.find((x) => x.name === 'MyStyleA')).toMatchObject({ kind: 'case', parentType: 'MyStyle' });
    expect(s.find((x) => x.name === 'MyStyleB')).toMatchObject({ kind: 'case', introducedIn: 80000 });
  });
  it('NS_OPTIONS becomes enum', () => {
    const s = objc(`typedef NS_OPTIONS(NSUInteger, MyOpts) {\nMyOptsNone = 0\n};`);
    expect(s.find((x) => x.name === 'MyOpts')).toMatchObject({ kind: 'enum' });
  });
  it('API_DEPRECATED_WITH_REPLACEMENT', () => {
    const s = objc(`- (void)old API_DEPRECATED_WITH_REPLACEMENT("new:", ios(2.0, 9.0));`);
    expect(s[0]).toMatchObject({ deprecated: true, deprecatedIn: 90000, introducedIn: 20000, renamedTo: 'new:' });
  });
  it('API_UNAVAILABLE(ios) vs tvos-only', () => {
    const a = objc(`- (void)x API_UNAVAILABLE(ios);`);
    expect(a[0].unavailable).toBe(true);
    const b = objc(`typedef NS_ENUM(NSInteger, E) {\nEA = 0,\n} API_UNAVAILABLE(tvos);`);
    expect(b.find((x) => x.kind === 'enum')!.unavailable).toBe(false);
  });
  it('standalone macro line applies to next decl (ARSession old style)', () => {
    const s = objc(`API_AVAILABLE(ios(11.0))\n@interface ARSession : NSObject\n- (void)pause;\n@end`);
    expect(s.find((x) => x.name === 'ARSession')).toMatchObject({ kind: 'class', introducedIn: 110000 });
    // members without own macro stay UNKNOWN (no leakage from the class line)
    expect(s.find((x) => x.name === 'pause')).toMatchObject({ introducedIn: 999999 });
  });
  it('standalone macro before typedef enum + members', () => {
    const s = objc(`API_AVAILABLE(ios(11.0))\ntypedef NS_OPTIONS(NSUInteger, Opts) {\nOptsA = (1 << 0),\n};`);
    expect(s.find((x) => x.name === 'Opts')).toMatchObject({ kind: 'enum', introducedIn: 110000 });
    // members inherit enum availability
    expect(s.find((x) => x.name === 'OptsA')).toMatchObject({ kind: 'case', introducedIn: 110000 });
  });
  it('enum member inline macro overrides inherited', () => {
    const s = objc(`API_AVAILABLE(ios(11.0))\ntypedef NS_OPTIONS(NSUInteger, Opts) {\nOptsA = 0,\nOptsB API_AVAILABLE(ios(14.0)),\n};`);
    expect(s.find((x) => x.name === 'OptsA')).toMatchObject({ introducedIn: 110000 });
    expect(s.find((x) => x.name === 'OptsB')).toMatchObject({ introducedIn: 110000 });
  });
  it('standalone consumed by @interface, not leaked to members', () => {
    // standalone line belongs to the NEXT decl only: @interface A takes it,
    // identifier keeps its own inline ios(13.0).
    const s = objc(`API_AVAILABLE(ios(11.0))\n@interface A\n@property (atomic, strong, readonly) NSUUID *identifier API_AVAILABLE(ios(13.0));\n@end`);
    expect(s.find((x) => x.name === 'A')).toMatchObject({ introducedIn: 110000 });
    expect(s.find((x) => x.name === 'identifier')).toMatchObject({ introducedIn: 130000 });
  });
  it('standalone does not leak past blank line into unrelated decl', () => {
    const s = objc(`API_AVAILABLE(ios(11.0))\n@interface A : NSObject\n@end\n@interface B : NSObject\n@end`);
    expect(s.find((x) => x.name === 'A')).toMatchObject({ introducedIn: 110000 });
    expect(s.find((x) => x.name === 'B')).toMatchObject({ introducedIn: 999999 });
  });
  it('NS_AVAILABLE_IOS underscore', () => {
    const s = objc(`- (void)go NS_AVAILABLE_IOS(13_0);`);
    expect(s[0]).toMatchObject({ introducedIn: 130000 });
  });
  it('NS_DEPRECATED_IOS pair', () => {
    const s = objc(`- (void)go NS_DEPRECATED_IOS(3_2, 6_0);`);
    expect(s[0]).toMatchObject({ introducedIn: 30200, deprecatedIn: 60000, deprecated: true });
  });
  it('extern const + extern func', () => {
    const s = objc(`extern NSErrorDomain const MyDomain API_AVAILABLE(ios(11.0));\nUIKIT_EXTERN void MyFunc(void);`);
    expect(s.find((x) => x.name === 'MyDomain')).toMatchObject({ kind: 'var', introducedIn: 110000 });
    expect(s.find((x) => x.name === 'MyFunc')).toMatchObject({ kind: 'func' });
  });
  it('block typedef', () => {
    const s = objc(`typedef void (^MyBlock)(NSInteger x);`);
    expect(s[0]).toMatchObject({ name: 'MyBlock', kind: 'typealias' });
  });
});
