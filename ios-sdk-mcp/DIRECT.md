# ios-sdk-mcp v0.6 — direct SDK mode + doc thật của Apple

MCP server đọc **trực tiếp file SDK trong Xcode.app** bằng ripgrep + hàm convert
output (không index, không database, không build-index).

## v0.5: nguồn tài liệu

`.swiftinterface` trong SDK **đã bị strip toàn bộ doc comment** → mọi hit Swift
trước đây thiếu `docComment` (chỉ ObjC `.h` có). Xcode không đọc file đó: khi
Cmd-click 1 API, nó gọi sourcekitd sinh **generated interface** tại chỗ
(breadcrumb `Simulator - iOS 26.2 › SwiftUI`) — declaration + doc `///` đầy đủ.

v0.5 sinh đúng file đó (`scripts/gen-iface.py`, request
`source.request.editor.open.interface`), cache ra đĩa 1 lần/module, rồi **rg/đọc
trực tiếp trên nó như mọi file SDK khác**. Vẫn không index, không database —
cache chỉ là source Swift thuần, toàn bộ convert/analyzeContext giữ nguyên.

| | .swiftinterface | generated interface |
|---|---|---|
| SwiftUI/ios | 26.771 dòng, **0 doc** | ~144.000 dòng, **doc đầy đủ** |
| Chi phí | có sẵn | 0,4–3s/module (lần đầu), sau đó đọc file |

- Cache: `~/.cache/ios-sdk-mcp/<XcodeBuild>/<platform>/<Framework>.swift`
  (đổi Xcode → key đổi, không stale). Override bằng `IOS_SDK_MCP_CACHE`.
- Lazy: chỉ sinh khi tool cần doc hỏi tới framework đó. `prewarm_docs` sinh trước.
- Sinh lỗi (module ObjC-only, không có trên platform) → fallback `.swiftinterface`.
- Yêu cầu: `python3` (chỉ dùng ctypes trong stdlib) + Xcode.

## Vì sao đổi

SQLite/sql.js (WASM) trên DB 1M symbols: `search "view"` ~7s (SCAN + GROUP BY toàn
bảng). Chọc thẳng file bằng rg: cùng query ~0.1–0.2s (nhanh 10–30x), luôn đúng với
SDK hiện tại, không tốn 700MB db, không rebuild khi lên Xcode.

## Kiến trúc

```
SDK sources (.swiftinterface + .h, 5 platforms)
  + generated interface đã cache (.swift, CÓ doc) — src/iface.ts
  │  rg --json -i -F  (fixed-string, case-insensitive, ~0.05-0.2s)
  ▼
src/convert.ts — convertLine(): dòng match -> API object
  │  Swift: stripLeadingAttributes/stripPublicPrefix/matchSwiftDecl (DÙNG parser.ts,
  │         không parse lại) + analyzeContext() giải tích phía trên
  │  ObjC: parseObjCHeader() nguyên file 1 lần -> map lineNumber (chuẩn 100%)
  ▼
src/index.ts — 10 MCP tools (JSON gọn cho AI)
```

## Files

| File | Vai trò |
|---|---|
| `src/sdk.ts` | `discoverFiles` (cache), `rgMatches`/`rgFiles`, `readWindow`, `analyzeContext` (scope-chain + doc), `tokenize`, `listFrameworksFast` |
| `src/iface.ts` | **Nguồn doc**: `ensureIface` (sinh + cache, dedup in-flight), `withCachedIfaces` (đổi nguồn Swift sang cache), `ensureIfacesFor` (prewarm), `isCachePath` |
| `scripts/gen-iface.py` | Gọi sourcekitd (ctypes) → ghi generated interface, atomic |
| `src/convert.ts` | `convertLine` (dòng -> object), `objcLineMap`, `rankHits` (exact > prefix > contains, NOCASE, `_` phạt) |
| `src/parser.ts` | Parser cũ, giờ là **thư viện hàm**: version/availability (`parseSwiftAvailable`, `mergeAvailability`, `inheritAvail`), decl match, ObjC macros, doc. Export thêm helpers cho convert. |
| `src/types.ts` | `ApiSymbol`, `ConvertedHit`-tương thích, `SdkPlatform` |
| `src/index.ts` | 12 tools MCP (stdio). Không import sql.js. |
| `src/indexer.ts`, `src/build-index.ts` | **Legacy, không dùng ở runtime.** Giữ lại vì tests cũ (indexer/output/multiplatform/realdb) vẫn import. Sẽ xóa khi các tests đó migrate. |

## Tools (12)

| Tool | Làm gì |
|---|---|
| `search_apis` | NGANG theo từ khóa: 2 tier EXACT (decl-anchored, budget riêng) + FUZZY, nhãn `match`, `mode: auto/exact/fuzzy`, ios-first, deterministic (`--sort path`). Doc **abstract** (≤240 ký tự). |
| `get_api_detail` | DỌC 1 API:Locate decl **decl-anchored** + sinh generated interface -> **doc đầy đủ** + version + members **names-only**. |
| `list_types` | **MỚI (v0.6)**: DỌC framework → types (không cần từ khóa). Ưu tiên cache CÓ doc, sort alpha, paging `limit/offset`, `detail: names/abstract`. |
| `get_type_members` | DỌC type → members: block scope + **mọi `extension <Type>`** trong file. `detail: names/abstract`, `kind` filter, paging `limit/offset` + `total`. |
| `prewarm_docs` | Sinh trước generated interface (theo danh sách framework, hoặc tất cả). |
| `read_source` | Đọc source gốc có số dòng (chỉ trong Xcode.app). |
| `grep_sdk` | rg thô file+dòng+text (khám phá rộng). |
| `list_frameworks` | Từ discovery, không parse. |
| `get_new_apis` | Quét `introduced:`/`iOS x.y`/`ios(x.y)` trực tiếp. |
| `get_deprecated` | Quét `deprecated:`/`API_DEPRECATED`/renamed trực tiếp. |
| `get_sdk_stats` | Đếm files theo platform/lang (không index). |
| `get_guide` | Đọc markdown docs trực tiếp (không SQLite). |

## Luật convert (không đoán bừa)

1. Swift dùng đúng hàm parser (strip/match), không regex riêng.
2. ObjC tra bảng parse full-file theo lineNumber.
3. `analyzeContext`: scope-chain ngược (member thừa hưởng extension/type),
   xuyên `@_originallyDefinedIn`/`#if`/trống, merge đúng luật parser,
   sentinel 100000.0 bỏ, introducedIn = version iOS.
4. `rg -F` match substring -> caller lọc regex neo từ (`\b`).
5. Members đọc block scope thật, không rg theo tên.
6. Output: `availability` chuỗi thô + `introducedIn/deprecatedIn/renamedTo` số;
   member giống cha thì lược availability (giữ introducedIn).
7. Doc lấy từ generated interface, KHÔNG bịa: nếu module không sinh được thì
   trường `docComment` vắng mặt chứ không suy diễn.
8. `analyzeContext` ngó lên 400 dòng (doc Apple dài; giới hạn 15 cũ cắt mất
   abstract ở đầu — phần quan trọng nhất).

## Tests

- `tests/direct.test.ts` (18): ground truth trên Xcode thật — ScrollView,
  foregroundColor (intro 13, renamed, sentinel), Text+ (depr 26 xuyên marker),
  ARSession standalone macro, UIScrollView members, TimelineEntry watchos,
  WKInterfaceController, tokenize/rank. Yêu cầu rg trong PATH.
- `tests/docs.test.ts` (6): sinh interface SwiftUI/ios, doc ScrollView bắt đầu
  đúng "A scrollable view.", member `axes` có doc riêng, **chứng minh
  `.swiftinterface` gốc không có doc**, `withCachedIfaces` đổi nguồn đúng,
  module không tồn tại -> null. Cache tạm qua `IOS_SDK_MCP_CACHE`.
- `tests/{parser-swift,modifiers}.test.ts`: unit parser (không cần SDK).
- `tests/{indexer,output,multiplatform,realdb}.test.ts`: legacy SQLite —
  vẫn pass, sẽ migrate/xóa.
