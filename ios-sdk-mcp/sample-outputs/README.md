# Sample outputs (v0.6) — chạy thật trên Xcode 27.0 (27A266a)

Output JSON thật của MCP, để xem/review không cần chạy server.
Gen lại: `npm run build` rồi chạy từng tool qua MCP stdio
(xem các lệnh `demo.sh` trong lịch sử phát triển).

| File | Tool + args | Size | Ghi chú |
|---|---|---|---|
| `01-search-apis-Text.json` | `search_apis {"query":"Text","limit":5}` | ~500 tok | NGANG: 5 hits `match:"exact"`, platform ios, hoist chung header |
| `02-search-apis-glassEffect.json` | `search_apis {"query":"glassEffect","limit":8}` | ~211 tok | NGANG từ khóa → chủ: SwiftUI+SwiftUICore, iOS 26, `match:"exact"` |
| `03-list-frameworks-Widget.json` | `list_frameworks {"query":"Widget"}` | ~20 tok | DỌC entry: filter thay vì full list 332 FW (~10k tok) |
| `04-list-types-WidgetKit.json` | `list_types {"framework":"WidgetKit","limit":8}` | ~132 tok | DỌC framework → types, sort alpha, `total/count/offset` |
| `05-members-Text-names.json` | `get_type_members {"name":"Text","framework":"SwiftUI","limit":10}` | ~183 tok | DỌC cha→con: names-only (kind+name+line), `total:55` + paging |
| `06-members-ScrollView-abstract.json` | `get_type_members {"name":"ScrollView","detail":"abstract","limit":4}` | ~228 tok | abstract: signature + doc 1 dòng để CHỌN member |
| `07-detail-ScrollView.json` | `get_api_detail {"name":"ScrollView"}` | ~655 tok | DỌC 1 API: full doc Apple + ví dụ + 6 members names-only |
| `08-detail-TimelineEntry.json` | `get_api_detail {"name":"TimelineEntry","framework":"WidgetKit"}` | ~470 tok | type ít member: full doc + ví dụ code CharacterDetailEntry |
