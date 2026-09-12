# omp-zen

Thêm model FREE của OpenCode Zen vào [omp](https://omp.sh). 1 file, 1 lệnh:

```bash
./install.py op-zen-hoang --key 'sk-...' --default     # macOS / Linux
py install.py op-zen-hoang --key "sk-..." --default    # Windows (best-effort)
```

(Chưa có key? `export OPENCODE_API_KEY=sk-...` rồi bỏ `--key`.)

Kiểm tra:

```bash
omp models op-zen-hoang                      # phải hiện đủ 7 models
omp -p "Say OK"                               # phải trả về OK
```

## Nó làm gì

Ghi 1 provider vào `~/.omp/agent/models.yml`: baseUrl Zen, apiKey, 7 models
free đã verify (`muse-spark-1.3/1.2`, `big-pickle`, `ling-3.0-flash-fin`,
`mimo-v2.5`, `nemotron-3-ultra`, `nemotron-3.5-lightning`), và headers
`x-opencode-*` (Zen bắt buộc có `x-opencode-session`, thiếu là lỗi
`MissingSessionID`). `--default` đặt model mặc định trong `config.yml`.

Headers session gọi helper `zen-session-id` (tự copy vào `~/.omp/agent/`):
mỗi lần mở omp là session mới. Provider khác không bị đụng (đã test).

## Tùy chọn

```bash
zen-omp <provider-id> [--key-env NAME] [--key <literal>] [--default]
```

- Không truyền key: dùng tên biến môi trường (`OPENCODE_API_KEY`).
- `--key <literal>`: ghi key thẳng vào file (file chmod 600).
- Chạy lại cùng provider: giữ key cũ, giữ headers custom, chỉ refresh specs.

Mỗi lần ghi đều backup `.bak`. Gỡ helper: `./install.py --uninstall`.

## Sửa tay (không dùng script)

File config: `~/.omp/agent/models.yml` (provider/model), `~/.omp/agent/config.yml`
(default role). Backup trước: `cp models.yml models.yml.bak`. Sửa xong mở
session omp mới (config load theo lần mở).

```yaml
# ~/.omp/agent/models.yml — thêm vào DƯỚI dòng `providers:` có sẵn
# (thụt 2 spaces; đừng tạo khối providers: mới vì YAML kỵ trùng key):
  ten-moi:
    baseUrl: https://opencode.ai/zen/v1
    api: openai-completions
    apiKey: TEN_BIEN_MOI_TRUONG   # hoặc key literal (chmod 600 file)
    models:
      - id: ten-model
        contextWindow: 128000
        maxTokens: 8192
```

- Sửa model: đổi `contextWindow`/`maxTokens`, thêm `reasoning: true`,
  `input: [text, image]`, hoặc `api: openai-responses` cho từng model.
- Xóa model: xóa block `- id: ...` đó.
- Xóa provider: xóa cả block provider đó. Muốn ẩn tạm thay vì xóa:

```yaml
# ~/.omp/agent/config.yml — ẩn provider nhưng giữ config + key
disabledProviders:
  - ten-moi
```

```bash
# Đổi model mặc định
# ~/.omp/agent/config.yml -> modelRoles: {default: ten-moi/ten-model}
omp models ten-moi     # kiểm tra lại sau khi sửa
```

## Sự cố

| Hiện tượng | Xử lý |
|---|---|
| `MissingSessionID` | Chạy `zen-omp <provider-id>` lại để ghi headers |
| Dời repo đi chỗ khác | Chạy `zen-omp <provider-id>` lại (helper tự copy mới) |
| Muốn xóa provider | Xóa entry trong `models.yml`, hoặc `/logout` nếu login qua omp |

## Yêu cầu

`python3` (3.9+) + `PyYAML`, `omp` đã cài.

```
omp-zen/
  install.py        # cài đặt (Python, chạy macOS/Linux/Windows)
  zen-session-id    # helper sinh session id (bản gốc, bản chạy nằm ở agent dir)
  README.md         # file này
```

Windows dùng `py install.py ...`, khác biệt tự xử lý: bỏ chmod, tự tìm
`python3`/`python`/`py`, quote đường dẫn có dấu cách. Chưa có máy Windows
để test nên mục này best-effort — báo lỗi giúp mình nếu gặp.
