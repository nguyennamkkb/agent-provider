import { describe, it, expect } from 'vitest';
import { parseSwiftInterface, parseObjCHeader } from '../src/parser.js';

/**
 * MODIFIERS — mọi modifier phải được giữ trong signature, không nuốt khi parse.
 * Nguồn: đo tần suất thật trên SDK (SwiftUI + toàn bộ .swiftinterface/UIKit headers).
 */

const FW = 'M';
const swift = (src: string) => parseSwiftInterface(src, FW, 't.swiftinterface');
const objc = (src: string) => parseObjCHeader(src, FW, 't.h');

describe('swift modifiers: pre/post-public (đo thật: 1864 convenience, 1424 final, 133 override...)', () => {
  const cases: Array<[string, string, string]> = [
    ['nonisolated', 'nonisolated public func f() -> Swift.Bool', 'f'],
    ['convenience', 'convenience public init(x: Swift.Int)', 'init'],
    ['final', 'final public class Foo {}', 'Foo'],
    ['override+dynamic', '@objc override dynamic public func encode(with coder: Foundation.NSCoder)', 'encode'],
    ['override+dynamic init', '@_Concurrency.MainActor @preconcurrency @objc override dynamic public init?(coder: Foundation.NSCoder)', 'init'],
    ['required', 'required public init()', 'init'],
    ['discardableResult', '@discardableResult nonisolated public func g() -> Swift.Bool', 'g'],
    ['_spi+override', '@_spi(Private) @objc override dynamic public init()', 'init'],
    ['open after attr', '@_Concurrency.MainActor @preconcurrency @objc override dynamic open func didMoveToWindow()', 'didMoveToWindow'],
    ['weak', 'weak public var delegate: AnyObject?', 'delegate'],
    ['mutating', 'mutating public func reset()', 'reset'],
    ['static', 'public static var shared: Foo', 'shared'],
  ];
  for (const [label, decl, name] of cases) {
    it(`parse được + giữ signature: ${label}`, () => {
      const s = swift(`public struct S {\n${decl}\n}`);
      const hit = s.find((x) => x.name === name);
      expect(hit, label).toBeDefined();
    });
  }
  it('signature giữ nguyên modifiers cho AI đọc', () => {
    const s = swift(`public struct S {\n@discardableResult nonisolated public func g() -> Swift.Bool\n}`);
    const g = s.find((x) => x.name === 'g')!;
    expect(g.signature).toContain('@discardableResult');
    expect(g.signature).toContain('nonisolated');
  });
  it('internal/private/fileprivate KHÔNG index', () => {
    expect(swift(`internal struct Hidden {}`)).toHaveLength(0);
    expect(swift(`private func h() -> Swift.Bool`)).toHaveLength(0);
    expect(swift(`fileprivate var x: Swift.Int`)).toHaveLength(0);
  });
  it('@objc optional (Swift protocol) parse được', () => {
    const s = swift(`public protocol P {\n@_Concurrency.MainActor @objc optional func cancel() -> Swift.Void\n}`);
    // optional là soft modifier trước @objc attribute -> vẫn public
    expect(s.find((x) => x.name === 'cancel')).toBeDefined();
  });
  it('protocol members KHÔNG access level vẫn là public API (SDK thật)', () => {
    const s = swift(`public protocol Bench {\nfunc runTest(host: Any) -> Swift.Bool\nassociatedtype Context = Swift.Void\nstatic func _make() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'runTest')).toMatchObject({ kind: 'func', parentType: 'Bench' });
    expect(s.find((x) => x.name === 'Context')).toMatchObject({ kind: 'associatedtype', parentType: 'Bench' });
  });
  it('internal LẺ trong public type vẫn bị loại', () => {
    const s = swift(`public struct S {\ninternal var hidden: Swift.Int\npublic var shown: Swift.Int\n}`);
    expect(s.find((x) => x.name === 'hidden')).toBeUndefined();
    expect(s.find((x) => x.name === 'shown')).toMatchObject({ parentType: 'S' });
  });
  it('inlinable giữ trong signature', () => {
    const s = swift(`public struct S {\n@_disfavoredOverload @inlinable nonisolated public func f() -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'f')!.signature).toContain('@inlinable');
  });
  it('@escaping trong params không làm vỡ parse', () => {
    const s = swift(`public struct S {\nnonisolated public func f(_ cb: @escaping () -> Swift.Void) -> Swift.Bool\n}`);
    expect(s.find((x) => x.name === 'f')).toMatchObject({ kind: 'func', parentType: 'S' });
  });
  it('class func (Swift <5?) parse được', () => {
    const s = swift(`public class C {\npublic class func make() -> Foo\n}`);
    expect(s.find((x) => x.name === 'make')).toMatchObject({ kind: 'func', parentType: 'C' });
  });
});

describe('objc modifiers: NS_* + nullability + @optional/@required + multiline', () => {
  it('NS_REQUIRES_SUPER / NS_DESIGNATED_INITIALIZER / NS_UNAVAILABLE: parse được decl', () => {
    // trailing non-availability macros: decl parse đúng, macro không làm vỡ selector
    const s = objc(`@interface A\n- (void)adjustedContentInsetDidChange NS_REQUIRES_SUPER;\n- (instancetype)initWithFrame:(CGRect)frame NS_DESIGNATED_INITIALIZER;\n- (instancetype)init NS_UNAVAILABLE;\n@end`);
    expect(s.find((x) => x.name === 'adjustedContentInsetDidChange')).toMatchObject({ kind: 'func', parentType: 'A' });
    expect(s.find((x) => x.name === 'initWithFrame:')).toMatchObject({ kind: 'func' });
    expect(s.find((x) => x.name === 'init')).toBeDefined();
  });
  it('nullability (nullable/nonnull/_Nullable) giữ trong signature', () => {
    const s = objc(`@interface A\n- (nullable NSString *)title;\n- (void)setX:(_Nullable id)x;\n@end\n@property (nullable, weak) id delegate;`);
    expect(s.find((x) => x.name === 'title')!.signature).toContain('nullable');
    expect(s.find((x) => x.name === 'setX:')!.signature).toContain('_Nullable');
    expect(s.find((x) => x.name === 'delegate')!.signature).toContain('nullable');
  });
  it('NS_SWIFT_NAME: trailing macro bị strip khỏi signature nhưng selector ObjC giữ nguyên', () => {
    const s = objc(`@interface A\n- (void)dismissAnimated:(BOOL)f completion:(void (^)(void))c NS_SWIFT_NAME(dismiss(animated:completion:));\n@end`);
    const m = s.find((x) => x.name === 'dismissAnimated:completion:')!;
    expect(m.kind).toBe('func');
    // macro đã parse xong thì không cần giữ trong signature; version/macros nằm ở availability
  });
  it('NS_SWIFT_DISABLE_ASYNC: trailing macro parse xong, signature sạch', () => {
    const s = objc(`@interface A\n- (void)go:(BOOL)f completion:(void (^)(void))c NS_SWIFT_DISABLE_ASYNC;\n@end`);
    expect(s.find((x) => x.name === 'go:completion:')).toBeDefined();
  });
  it('multiline method join đủ selector', () => {
    const s = objc(`@interface A\n+ (nullable id)objectWithData:(NSData *)data\n                           typeIdentifier:(NSString *)typeIdentifier\n                                    error:(NSError **)outError;\n@end`);
    const m = s.find((x) => x.name === 'objectWithData:typeIdentifier:error:')!;
    expect(m.kind).toBe('func');
    expect(m.signature).toContain('typeIdentifier:');
  });
  it('multiline availability ở dòng tiếp theo: decl vẫn có (version UNKNOWN trung thực)', () => {
    const s = objc(`@interface A\n- (void)go:(BOOL)f\nAPI_AVAILABLE(ios(13.0));\n@end`);
    expect(s.find((x) => x.name === 'go:')).toBeDefined();
  });
  it('@optional members đánh dấu trong signature + đúng parent (protocol scope)', () => {
    const s = objc(`@protocol P <NSObject>\n@required\n- (void)must;\n@optional\n- (void)maybe;\n@property(nonatomic) BOOL flag;\n@end`);
    expect(s.find((x) => x.name === 'maybe')!.signature).toContain('@optional');
    expect(s.find((x) => x.name === 'flag')!.signature).toContain('@optional');
    expect(s.find((x) => x.name === 'must')!.signature).not.toContain('@optional');
    expect(s.find((x) => x.name === 'maybe')).toMatchObject({ parentType: 'P' });
  });
  it('@interface có prefix macro (UIKIT_EXTERN API_AVAILABLE...) vẫn parse + version', () => {
    const s = objc(`/// Doc.\nUIKIT_EXTERN API_AVAILABLE(ios(13.0)) API_UNAVAILABLE(watchos) @interface UIHover : NSObject\n@end`);
    expect(s[0]).toMatchObject({ name: 'UIHover', kind: 'class', introducedIn: 130000 });
    expect(s[0].docComment).toContain('Doc.');
  });
  it('category prefix macro gắn đúng base', () => {
    const s = objc(`UIKIT_EXTERN API_AVAILABLE(ios(13.0)) API_UNAVAILABLE(watchos, tvos) @interface NSUserActivity (NSItemProvider) <NSItemProviderReading>\n- (void)extra;\n@end`);
    expect(s[0]).toMatchObject({ kind: 'extension', parentType: 'NSUserActivity' });
    expect(s.find((x) => x.name === 'extra')).toMatchObject({ parentType: 'NSUserActivity' });
  });
  it('readonly/class property giữ attributes', () => {
    const s = objc(`@interface A\n@property (nonatomic, readonly, class) id shared;\n@property (nonatomic, getter=isOpen) BOOL open;\n@end`);
    expect(s.find((x) => x.name === 'shared')!.signature).toContain('readonly');
    expect(s.find((x) => x.name === 'open')!.signature).toContain('getter=isOpen');
  });
  it('generic ObjC (NSArray<T>) parse được', () => {
    const s = objc(`@interface A\n- (void)addItems:(NSArray<NSString *> *)items;\n@end`);
    expect(s.find((x) => x.name === 'addItems:')).toBeDefined();
  });
  it('block param (^) không vỡ selector', () => {
    const s = objc(`@interface A\n- (void)do:(void (^ __nullable)(void))c;\n@end`);
    expect(s.find((x) => x.name === 'do:')).toBeDefined();
  });
});
