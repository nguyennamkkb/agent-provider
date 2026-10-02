# omp-go

Thêm model của [OpenCode Go](https://opencode.ai/docs/go) (gói subscription
$10/tháng) vào [omp](https://omp.sh). 1 file, 1 lệnh:

```bash
./install.py op-go-nam --key 'sk-...' --default     # macOS / Linux
py install.py op-go-nam --key "sk-..." --default    # Windows (best-effort)
```

(Chưa có key? `export OPENCODE_API_KEY=sk-...` rồi bỏ `--key`.)

Kiểm tra:

```bash
omp models op-go-nam                      # phải hiện đủ 37 models
omp -p "Say OK"                           # phải trả về OK (khi đã --default hoặc --model)
```

Go dùng **key và endpoint riêng** (`https://opencode.ai/zen/go/v1`), khác key
Zen free (`https://opencode.ai/zen/v1`). Giống Zen, Go yêu cầu giả lập header
`x-opencode-*` (thiếu `x-opencode-session` là lỗi `MissingSessionID`).

## Nó làm gì

Ghi 1 provider vào `~/.omp/agent/models.yml`: baseUrl Go, apiKey, 37 models
Go (thông số mirror `pi-go`, đã bỏ `cost`/`compat`/`thinkingLevelMap` vì omp
không dùng), và headers `x-opencode-*` (Zen/Go bắt buộc có
`x-opencode-session`). `--default` đặt model mặc định trong `config.yml`
(`deepseek-v4-flash`).

Headers session gọi helper `zen-session-id` (tự copy vào `~/.omp/agent/`):
mỗi lần mở omp là session mới. Helper này cùng nội dung với bản `omp-zen`
nên cài chung không xung đột. Provider khác không bị đụng (đã test).

Nhóm `anthropic-messages` (`minimax-m3`, `minimax-m2.5`, `qwen3.8-flash`,
`union-alpha`) chạy ở base rút gọn `https://opencode.ai/zen/go` (không có
`/v1`) — `install.py` ghi per-model `baseUrl` riêng cho 4 model này.

## Tùy chọn

```bash
zen-omp-go <provider-id> [--key-env NAME] [--key <literal>] [--default]
```

- Không truyền key: dùng tên biến môi trường (`OPENCODE_API_KEY`).
- `--key <literal>`: ghi key thẳng vào file (file chmod 600).
- Chạy lại cùng provider: giữ key cũ, giữ headers custom, chỉ refresh specs.

Mỗi lần ghi đều backup `.bak`. Gỡ helper: `./install.py --uninstall`.

## Models Go (37, mirror `pi-go`)

`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`,
`deepseek-v4.1-flash`, `glm-5.1`, `glm-5.2`, `glm-5.3`, `glm-5.3-flash`,
`glm-5`, `hy3`, `hy4-preview`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`,
`kimi-k2.5`, `longcat-2.0`, `mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2-pro`,
`mimo-v2-omni`, `minimax-m2.7`, `omen-alpha`, `qwen3.6-plus`, `qwen3.7-max`,
`qwen3.7-plus`, `qwen3.8-max`, `qwen3.5-plus`, `minimax-m3`,
`minimax-m2.5`, `qwen3.8-flash`, `ox-alpha-free` (free), `union-alpha`
(free), `gpt-5.6-luna`, `grok-4.5`, `grok-4.6`,
`muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`.

`GO_PRESETS` trong `install.py` mirror tay với `pi-go` (bỏ các trường riêng
của Pi). Khi `pi-go` đổi specs: copy tương ứng sang đây (giữ `id`/`api`/
`input`/`contextWindow`/`maxTokens`/`reasoning`/`base`).

## Sửa tay (không dùng script)

File config: `~/.omp/agent/models.yml` (provider/model), `~/.omp/agent/config.yml`
(default role). Backup trước: `cp models.yml models.yml.bak`. Sửa xong mở
session omp mới (config load theo lần mở).

```yaml
# ~/.omp/agent/models.yml — thêm vào DƯỚI dòng `providers:` có sẵn
# (thụt 2 spaces; đừng tạo khối providers: mới vì YAML kỵ trùng key):
  ten-moi:
    baseUrl: https://opencode.ai/zen/go/v1
    api: openai-completions
    apiKey: TEN_BIEN_MOI_TRUONG   # hoặc key literal (chmod 600 file)
    models:
      - id: ten-model
        contextWindow: 128000
        maxTokens: 8192
```

- Sửa model: đổi `contextWindow`/`maxTokens`, thêm `reasoning: true`,
  `input: [text, image]`, hoặc `api: openai-responses` /
  `api: anthropic-messages` (+ `baseUrl: https://opencode.ai/zen/go` cho
  nhóm messages) cho từng model.
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
| `MissingSessionID` | Chạy `./install.py <provider-id>` lại để ghi headers |
| Dời repo đi chỗ khác | Chạy `./install.py <provider-id>` lại (helper tự copy mới) |
| Muốn xóa provider | Xóa entry trong `models.yml`, hoặc `/logout` nếu login qua omp |

## Yêu cầu

`python3` (3.9+) + `PyYAML`, `omp` đã cài.

```
omp-go/
  install.py        # cài đặt (Python, chạy macOS/Linux/Windows)
  zen-session-id    # helper sinh session id (cùng nội dung bản omp-zen)
  README.md         # file này
```

Windows dùng `py install.py ...`, khác biệt tự xử lý: bỏ chmod, tự tìm
`python3`/`python`/`py`, quote đường dẫn có dấu cách. Chưa có máy Windows
để test nên mục này best-effort — báo lỗi giúp mình nếu gặp.
