# ios-sdk-mcp v0.4 — direct SDK mode (không SQLite)

MCP server đọc **trực tiếp file SDK trong Xcode.app** bằng ripgrep + hàm convert
output (không index, không database, không build-index).

## Vì sao đổi

SQLite/sql.js (WASM) trên DB 1M symbols: `search "view"` ~7s (SCAN + GROUP BY toàn
bảng). Chọc thẳng file bằng rg: cùng query ~0.1–0.2s (nhanh 10–30x), luôn đúng với
SDK hiện tại, không tốn 700MB db, không rebuild khi lên Xcode.

## Kiến trúc

```
SDK sources (.swiftinterface + .h, 5 platforms)
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
| `src/convert.ts` | `convertLine` (dòng -> object), `objcLineMap`, `rankHits` (exact > prefix > contains, NOCASE, `_` phạt) |
| `src/parser.ts` | Parser cũ, giờ là **thư viện hàm**: version/availability (`parseSwiftAvailable`, `mergeAvailability`, `inheritAvail`), decl match, ObjC macros, doc. Export thêm helpers cho convert. |
| `src/types.ts` | `ApiSymbol`, `ConvertedHit`-tương thích, `SdkPlatform` |
| `src/index.ts` | 10 tools MCP (stdio). Không import sql.js. |
| `src/indexer.ts`, `src/build-index.ts` | **Legacy, không dùng ở runtime.** Giữ lại vì tests cũ (indexer/output/multiplatform/realdb) vẫn import. Sẽ xóa khi các tests đó migrate. |

## Tools (10)

| Tool | Làm gì |
|---|---|
| `search_apis` | rg token dài nhất -> convert -> lọc tokens còn lại -> rank. Case-insensitive, multi-word. |
| `get_api_detail` | Locate decl + `analyzeContext` (version/doc/file+line) + `readScopeMembers` (scope-aware, không đoán theo tên). |
| `get_type_members` | rg theo tên type trong framework files, lọc parentType scope, dedup. |
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

## Tests

- `tests/direct.test.ts` (18): ground truth trên Xcode thật — ScrollView,
  foregroundColor (intro 13, renamed, sentinel), Text+ (depr 26 xuyên marker),
  ARSession standalone macro, UIScrollView members, TimelineEntry watchos,
  WKInterfaceController, tokenize/rank. Yêu cầu rg trong PATH.
- `tests/{parser-swift,modifiers}.test.ts`: unit parser (không cần SDK).
- `tests/{indexer,output,multiplatform,realdb}.test.ts`: legacy SQLite —
  vẫn pass, sẽ migrate/xóa.
