# Nghiên cứu SDK iOS & Kiến trúc MCP tối ưu

> Phương pháp: đọc trực tiếp Xcode SDK trên máy (`iPhoneOS.sdk`, Xcode hiện tại = **iOS 26.2**,
> `CanonicalName: iphoneos26.2`), đo đếm bằng grep, chạy index thật.
> Ngày: 2026-09-14. Tài liệu này là **nguồn sự thật duy nhất** cho mọi quyết định parser/schema/tool tiếp theo.

---

## 1. Toàn cảnh corpus (số liệu đo thật)

| Thành phần | Số lượng | Ghi chú |
|---|---|---|
| Frameworks | 271 thư mục `.framework` | `System/Library/Frameworks` |
| `.swiftinterface` | 175 file | Mỗi framework Swift có 1 file/arch (`arm64e-apple-ios`) |
| `.h` headers | 4.157 file | Mọi framework ObjC/C |
| Tổng dung lượng text | ~51 MB | Vừa đủ load toàn bộ vào RAM |
| Tốc độ index hiện tại | ~2 s / 45.075 symbols | Nhưng **đang bỏ sót đa số** (xem §4) |
| `///` doc comments trong `.swiftinterface` | **0** (đo ở SwiftUI) | Swift không có docs inline |
| `//` comments trong ObjC header | Có, nhiều (152 dòng ở `UIViewController.h`, gồm block `/* */` mô tả class) | Nguồn docs duy nhất trong SDK |

Kết luận: toàn bộ SDK parse được trong ~2–5 s, giữ trọn trong SQLite in-memory là khả thi.
Không cần vector DB, không cần embedding — bài toán là **trích xuất chính xác + tra cứu nhanh**, không phải semantic search.

---

## 2. Giải phẫu `.swiftinterface` (phát hiện quan trọng)

Ví dụ thật (SwiftUI):

```swift
@available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, visionOS 2.0, *)
extension SwiftUICore.View {
  nonisolated public func accessibilityValue(_ valueDescription: SwiftUICore.Text, ...) -> ...
  @_disfavoredOverload @_alwaysEmitIntoClient nonisolated public func accessibilityValue(...) { ... }
}
```

### 2.1. Quy tắc đã kiểm chứng bằng grep

1. **`@available` luôn nằm DÒNG RIÊNG phía trên**, áp dụng cho block `extension` hoặc member kế tiếp.
   Không tồn tại dạng `@available(...) public struct` cùng dòng (grep = 0).
2. **Availability có tính KẾ THỪA theo scope**: annotation trên `extension` áp dụng cho mọi member
   bên trong, trừ member nào có `@available` riêng (dạng indent `  @available(iOS 16.0, ...)` — đã thấy thật).
3. **Member nằm trong extension, thụt đầu dòng, mang prefix**: `nonisolated`, `@_disfavoredOverload`,
   `@_alwaysEmitIntoClient`, `@MainActor`/`@_Concurrency.MainActor`, `@preconcurrency`, `@frozen`,
   `@propertyWrapper`, `@dynamicMemberLookup`, `@resultBuilder`... — phải **strip hết attributes**
   trước khi nhận diện `public/open`.
4. Có **`open class`** (`open class UIHostingController`), không chỉ `public class`.
5. Hai họ `@available`:
   - `@available(iOS 18.0, macOS 15.0, ..., *)` → regex `iOS\s+(\d+\.\d+)` bắt được.
   - `@available(iOS, introduced: 13.0, deprecated: 100000.0, renamed: "...")` → regex hiện tại **bó tay**.
     Phải parse thêm `introduced:` / `deprecated:` / `obsoleted:` / `renamed:` / `message:`.
   - `@available(*, deprecated|unavailable, ...)` → đánh dấu trạng thái, không phải version.
6. Thống kê prefix ở SwiftUI (26.771 dòng): `nonisolated public func` 660, `public static` 629+112,
   `public init` 558, `public typealias` 475, `public struct` 468, `nonisolated public init` 259... —
   parser hiện tại (chỉ nhận dòng bắt đầu `public `) **bỏ sót >50%**.
7. Không có docs inline → cột `doc_comment` của Swift **luôn rỗng**. Muốn "cách sử dụng, ví dụ"
   phải lấy từ lớp docs riêng (§5).

### 2.2. Cách parse đúng

- Duyệt theo **scope stack**: khi gặp `@available` → lưu pending; khi gặp `extension X {` →
  push scope `{type: X, availability}`; member bên trong **thừa hưởng** availability của scope
  nếu không có annotation riêng; `}` → pop.
- Normalize mỗi dòng: strip attributes (`@...` ở đầu, kể cả nhiều cái liền nhau), strip
  `nonisolated`/`open`→kind class, rồi mới match `public|open|extension`.
- Trích version từ cả 2 họ `@available`; lưu thêm `deprecated_in`, `renamed_to`, `unavailable: bool`.
- Bỏ qua body `{ ... }` của function inline (chỉ giữ signature 1 dòng đã join).

---

## 3. Giải phẫu ObjC header (phát hiện quan trọng)

Ví dụ thật (UIKit):

```objc
typedef NS_ENUM(NSInteger, UIModalPresentationStyle) {
    UIModalPresentationPopover API_AVAILABLE(ios(8.0)) API_UNAVAILABLE(tvos),
} API_UNAVAILABLE(watchos);
```

### 3.1. Quy tắc đã kiểm chứng

1. **Availability nằm INLINE cùng dòng** (`API_AVAILABLE(ios(8.0))` là suffix), KHÔNG phải dòng riêng.
   Parser hiện tại (đợi `API_AVAILABLE` dòng trước + decl dòng sau) **sai toàn bộ**.
2. Các macro: `API_AVAILABLE(ios(x))`, `API_DEPRECATED(...)`, `API_UNAVAILABLE(...)`,
   `NS_AVAILABLE_IOS(x_y)`, `NS_DEPRECATED_IOS(...)`. Version dạng `ios(3.2)` và `3_2` — cần normalizer riêng.
3. Loại decl cần bắt: `@interface`, `@protocol`, `@property`, method `-/+`, `typedef NS_ENUM/NS_OPTIONS/
   NS_CLOSED_ENUM`, `enum`, `struct`, `extern`/`FOUNDATION_EXPORT` (hàm + hằng C), `typedef ... (^Block)`.
4. **Comments là docs**: block `/* */` trước `@interface` = mô tả class; `//` dòng trước method = mô tả method.
   Parser hiện tại bỏ qua hết → phải thu preceding-comment (tối đa N dòng, gom cả `/* */`).
5. `#if/#import/NS_HEADER_AUDIT_BEGIN` → bỏ qua.

---

## 4. Đối chiếu parser hiện tại với sự thật

| Giả định của parser | Sự thật | Hậu quả |
|---|---|---|
| Decl bắt đầu bằng `public ` | Member có prefix `nonisolated`/`@...`, thụt đầu dòng; có `open class` | Mất >50% API Swift |
| `@available` + decl cùng dòng | `@available` dòng riêng, kế thừa theo scope | `availability` rỗng, `minIOS=999999` hàng loạt |
| ObjC availability dòng riêng phía trên | Inline suffix cùng dòng | Gần như không bắt được version ObjC |
| Chỉ ghi ObjC symbol khi có availability | Đa số API cũ không annotate | Mất hàng loạt API ObjC |
| `docComment` từ `///` | Swift = 0 dòng `///`; ObjC docs ở `//` + `/* */` bị bỏ qua | Cột docs luôn rỗng |

Triệu chứng đã quan sát: `getNewApis(270000,'SwiftUI')` = `[]` (một phần do máy chỉ có SDK 26.2,
nhưng kể cả 26.x cũng rỗng vì version không được trích).

---

## 5. Lớp tri thức không nằm trong SDK

1. **`ios27-full-knowledge.md`** (trong repo): 1.101 API iOS 27, 66 frameworks, tóm tắt 20 file docs —
   hiện là file tĩnh, chưa nối vào MCP.
2. **20 file AdditionalDocumentation** (chỉ có trên Xcode 27; máy này Xcode 26.2 nên **không tồn tại**,
   đã `find` kiểm chứng). Đây là nguồn "cách sử dụng + ví dụ" chuẩn Apple (Liquid Glass, FoundationModels,
   Swift Concurrency, AppIntents...).
3. `.swiftdoc` (binary 4.2 MB/SwiftUI) = AST serialize — cần compiler để đọc, **bỏ qua**.
4. `.tbd` = mangled symbols cho linker — **vô dụng cho AI, bỏ qua**.

→ Kiến trúc phải có **2 lớp**: (A) symbols trích từ SDK + (B) docs/usage markdown. Hai lớp join bằng
`(framework, symbol_name)`.

---

## 6. Kiến trúc MCP tối ưu (đề xuất chốt)

### 6.1. Nguyên tắc

- **Tiền xử lý nặng 1 lần, query nhẹ nhiều lần**: build DB file 1 lần (script `build-index`),
  MCP server chỉ mở DB read-only → khởi động <100 ms thay vì parse lại 2 s mỗi lần.
- **Parser chính xác > parser nhanh**: corpus chỉ 51 MB, regex nhiều pass vẫn rẻ.
- **Không embedding/vector**: nhu cầu là tra cứu chính xác theo tên/framework/version — FTS/SQLite đủ,
  rẻ, offline, deterministic.
- **Version là first-class citizen**: mọi query đều lọc được theo iOS version; mỗi symbol lưu
  `introduced_in`, `deprecated_in`, `renamed_to`.

### 6.2. Schema SQLite đề xuất

```sql
symbols(name, kind, framework, parent_type, signature, lang,      -- lang: swift|objc
        introduced_in, deprecated_in, renamed_to, unavailable,    -- INT version iOS*10000
        doc_comment, file_path, line_number);
symbols_fts VIRTUAL TABLE USING fts5(name, signature, doc_comment, framework);
frameworks(name, lang, api_count, min_version, is_new);
docs(topic, framework, symbol, content_md);                       -- lớp B: knowledge + AdditionalDocumentation
meta(sdk_version, xcode_version, built_at);
```

### 6.3. Bộ tool tối ưu (7 tools, gom theo nhu cầu AI)

| # | Tool | AI dùng khi nào |
|---|---|---|
| 1 | `search_apis(query, framework?, ios_version?, kind?, limit?)` | Tìm API — FTS + lọc version/kind |
| 2 | `get_api_detail(name, framework?)` | Lấy signature + version + docs gộp (symbol JOIN docs) |
| 3 | `get_type_members(type, framework?)` | **Mới**: liệt kê members của 1 type (thay `get_type_hierarchy` yếu) — tận dụng parent_type |
| 4 | `get_new_apis(ios_version, framework?)` | API mới theo phiên bản (ví dụ "iOS 26 có gì cho SwiftUI") |
| 5 | `get_deprecated(ios_version, framework?)` | **Mới**: API bị deprecated/unavailable + `renamed_to` → AI tự sửa code cũ |
| 6 | `list_frameworks(new_only?, ios_version?)` | Khám phá framework |
| 7 | `get_guide(topic_or_symbol)` | **Mới**: trả về markdown "cách sử dụng + ví dụ" từ lớp docs |

`get_sdk_stats` giữ lại làm tool phụ/debug. Bỏ `get_type_hierarchy` cũ (regex đoán supertype sai).

### 6.4. Pipeline build

```
swiftinterface ──> swift_parser (scope-stack + strip attrs + 2 họ @available) ──┐
objC headers ────> objc_parser (inline macros + preceding comments) ────────────┤──> symbols.db
knowledge.md + AdditionalDocumentation/*.md ──> docs_loader ────────────────────┘
```

- `npm run build-index -- --sdk <path> --out symbols.db` (chạy 1 lần/máy, khi đổi Xcode).
- MCP server: `IOS_INDEX_PATH=symbols.db node dist/index.js` — read-only, startup tức thì.
- Test khóa parser: fixture 20–30 dòng Swift/ObjC "bẫy" (nonisolated, open class, member-override
  availability, inline API_AVAILABLE, NS_ENUM...) — vitest đã có sẵn trong devDeps.

### 6.5. Roadmap

1. Viết lại `parser.ts` theo §2.2 + §3 (việc nặng nhất, giá trị cao nhất).
2. Migrate schema theo §6.2 (thêm version fields, FTS5, bảng docs).
3. Tách `build-index` khỏi server startup (DB file + read-only).
4. Nạp `ios27-full-knowledge.md` vào bảng docs + tool `get_guide`.
5. Khi có máy Xcode 27: nạp 20 file AdditionalDocumentation, rebuild.
6. Vitest fixtures parser + CI check.
