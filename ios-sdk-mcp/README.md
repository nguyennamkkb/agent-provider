# ios-sdk-mcp v0.6 — direct SDK mode + output cho AI Agent

MCP server đọc **trực tiếp file SDK trong Xcode.app** (không index, không database).
AI agent hiểu **API là gì, version nào, dùng thế nào** — kèm **tài liệu gốc của
Apple**, đúng bản Xcode đang cài.

Chi tiết kiến trúc: xem [DIRECT.md](DIRECT.md). Ghi chú nghiên cứu SDK: [RESEARCH.md](RESEARCH.md).

## Vì sao có v0.5

`.swiftinterface` trong SDK đã bị strip hết doc comment. Xcode không đọc file đó:
Cmd-click 1 API thì nó gọi sourcekitd sinh **generated interface** (declaration +
doc `///` đầy đủ). v0.5 sinh đúng file đó, cache ra đĩa, rồi `rg` trực tiếp trên nó.

| Nguồn | SwiftUI/ios | Doc |
|---|---|---|
| `.swiftinterface` (v0.4) | 26.771 dòng | ❌ không có |
| generated interface (v0.5) | ~144.000 dòng | ✅ đầy đủ |

## Features

- **Doc comment thật** cho Swift API: abstract, mô tả, ví dụ code, link ``Type/member``
- Scope-aware Swift parser (`extension` availability inheritance, `open`/`nonisolated`/
  attribute prefixes, `macro`/`associatedtype`/`case`, cả 2 họ `@available`)
- Inline-macro ObjC parser (`API_AVAILABLE` suffixes, `NS_ENUM` members, doc `/* */` + `//`)
- Version-first: `introducedIn`, `deprecatedIn`, `renamedTo`, `unavailable`
- 5 platform: ios, watchos, macos, tvos, xros
- Không index/database: khởi động tức thì, luôn khớp SDK hiện tại
- 204 test (`npm test`)

## Setup

```bash
npm install
npm run build
```

Yêu cầu: Xcode, `rg` (ripgrep) trong PATH, `python3` (chỉ dùng stdlib).

## Usage

```json
{
  "mcpServers": {
    "ios-sdk": {
      "command": "node",
      "args": ["/path/to/ios-sdk-mcp/dist/index.js"]
    }
  }
}
```

Cache doc mặc định ở `~/.cache/ios-sdk-mcp/<XcodeBuild>/` — đổi bằng biến môi
trường `IOS_SDK_MCP_CACHE`. Nâng cấp Xcode thì key cache tự đổi, không cần rebuild.

Lần đầu hỏi 1 framework mất ~0,4–3s để sinh doc; sau đó đọc file, ~0,1s.
Muốn sinh sẵn: gọi tool `prewarm_docs`.

## Workflow cho AI Agent (dọc trước, ngang sau)

```
list_frameworks(query) → list_types(framework) → get_type_members(type) → get_api_detail(name) → get_guide(topic)
              ↘ search_apis(keyword) → get_api_detail(match:"exact")  [chỉ khi CHƯA biết type]
```

- **Dọc** (đã biết cha): rẻ, deterministic — `list_types` (~200 tok) →
  `members names-only` (~20 tok/member) → `detail` full doc 1 API.
- **Ngang** (chỉ có từ khóa): `search_apis` — exact block (`match:"exact"`)
  lên trước, fuzzy (`prefix|contains|fuzzy`) sau. `mode:"exact"` khi đã biết
  tên; `mode:"fuzzy"` khi khám phá.
- **Nhẹ phân tầng**: `detail:"names"` (default, kind+name+line) →
  `"abstract"` (chọn member) → `get_api_detail` (full doc).
- Mặc định **platform ios** (line-number đúng file iPhone); `platform:"all"`
  khi hỏi đa nền tảng. `get_api_detail` không tìm thấy → gợi ý NEXT step.
- `get_deprecated` giữ `renamedTo` (+message trong marker) để migrate;
  `get_new_apis` lọc đúng `introducedIn` version hỏi; `grep_sdk` là leaf/debug.
- Mọi tool: JSON compact (không pretty), annotations MCP
  (`readOnlyHint`, trừ `prewarm_docs`).

## Available Tools (12)

| Tool | AI trả lời được + WHEN/NEXT |
|------|-------------|
| `list_types` | **MỚI (v0.6)**: types trong framework — `names` gọn, paging `limit/offset`, sort alpha |
| `search_apis` | Tìm API — rank exact > prefix > contains; kèm abstract ngắn; lọc `framework`/`kind`/`platform` |
| `get_api_detail` | Signature + version + deprecation + **doc đầy đủ** + members |
| `get_type_members` | Mọi member của type, gồm cả khai báo trong `extension`, mỗi member kèm abstract |
| `prewarm_docs` | Sinh trước doc cho framework (hoặc tất cả) |
| `read_source` | Đọc source gốc quanh 1 dòng (SDK hoặc generated interface) |
| `grep_sdk` | Tìm thô file+dòng+text trên toàn SDK |
| `get_new_apis` | "iOS 26 có gì mới cho SwiftUI?" |
| `get_deprecated` | API deprecated + `renamedTo` để migrate code |
| `get_guide` | Guide/ví dụ từ markdown knowledge docs |
| `list_frameworks` | Framework nào có trên platform nào |
| `get_sdk_stats` | Thống kê file theo platform/lang |

## Architecture

```
ios-sdk-mcp/
├── scripts/
│   └── gen-iface.py    # sourcekitd (ctypes) -> generated interface, ghi atomic
├── src/
│   ├── index.ts        # MCP server (stdio), 12 tools
│   ├── iface.ts        # Nguồn doc: sinh + cache + đổi nguồn Swift
│   ├── sdk.ts          # discoverFiles, ripgrep, analyzeContext (version + doc)
│   ├── convert.ts      # 1 dòng match -> API object, ranking
│   ├── parser.ts       # Swift/ObjC parser dùng làm thư viện hàm
│   └── types.ts
└── tests/              # 204 test (docs, direct/ground-truth, parser, legacy)
```

## Data Flow

```
SwiftUI, UIKit... ──sourcekitd──> generated interface (.swift, CÓ doc) ──┐
.swiftinterface (fallback khi không sinh được) ──────────────────────────┤──rg──> convert ──> MCP tools
.h headers ──────────────────────────────────────────────────────────────┘
```
