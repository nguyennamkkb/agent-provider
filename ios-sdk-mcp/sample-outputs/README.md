# Sample outputs (v0.6, không file/line) — chạy thật trên Xcode 27.0 (27A266a)

Output JSON thật của MCP. Tham chiếu giữa các tool bằng **name (+framework)** —
không còn `filePath`/`line`/`lineNumber`/bảng `files` trong output
(vị trí file chỉ dùng nội bộ; cần đọc source thì `read_source {name}`).

| File | Tool + args | Size | Ghi chú |
|---|---|---|---|
| `01-search-apis-Text.json` | `search_apis {"query":"Text","limit":3}` | ~185 tok | NGANG: 3 hits `match:"exact"`, header hoist platform/lang |
| `02-detail-ScrollView.json` | `get_api_detail {"name":"ScrollView"}` | ~609 tok | DỌC 1 API: full doc Apple + 6 members kind+name |
| `03-members-Text-names.json` | `get_type_members {"name":"Text","framework":"SwiftUI","limit":5}` | ~78 tok | DỌC cha→con: kind+name, `total:55` + paging |
| `04-list-types-WidgetKit.json` | `list_types {"framework":"WidgetKit","limit":5}` | ~73 tok | DỌC framework → types, sort alpha |
| `05-grep-deprecated.json` | `grep_sdk {"pattern":"deprecated: 26.0","framework":"SwiftUI","limit":3}` | ~139 tok | LEAF/debug: text + framework, không file/line |
| `06-detail-ActivityConfiguration.json` | `get_api_detail {"name":"ActivityConfiguration"}` | ~145 tok | Case Live Activity: đủ 3 members (init/body/Body) sau fix generic-init |
| `07-members-ActivityConfiguration-abstract.json` | `get_type_members {"name":"ActivityConfiguration","framework":"WidgetKit","detail":"abstract"}` | ~216 tok | abstract: signature init đầy đủ params — đọc là biết dùng thế nào |
