# pi-go

Đưa model của [OpenCode Go](https://opencode.ai/docs/go) (gói subscription
$10/tháng) vào [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Go dùng **key và endpoint riêng** (`https://opencode.ai/zen/go/v1`), khác key
Zen free (`https://opencode.ai/zen/v1`). Giống Zen, Go yêu cầu giả lập header
`x-opencode-*` (thiếu `x-opencode-session` là lỗi `MissingSessionID`).
`pigo add` ghi headers tĩnh thẳng vào `models.json` (Pi hỗ trợ `headers` ở
provider) — thực nghiệm chạy được không cần gì thêm. Extension TypeScript chỉ
còn tác dụng nâng cao: sinh `ses_` ổn định theo conversation Pi và `msg_` mới
mỗi request (thay vì id tĩnh chung mọi request).

## Cài đặt

```bash
./install.py install
pigo doctor
```

`install` chỉ cài lệnh `pigo` vào `~/.local/bin` (đã có trong PATH).
Extension là optional — chỉ thêm `--with-ext` khi cần id động theo conversation
(headers tĩnh trong `models.json` đã đủ chạy).

Tùy chọn: `--bin-dir DIR`, `--no-bin`, `--with-ext`, `--uninstall`.

## Cách dùng

`pigo` chính là `install.py` sau khi cài (lệnh `install` tạo symlink
`~/.local/bin/pigo` → `install.py`). Chưa cài thì thay `pigo ...` bằng
`python3 install.py ...` (hoặc `./install.py ...`) — tác dụng như nhau.

```bash
pigo add <provider-id> <api-key> [--default]
pigo sync [--provider <id>] [--key <key>] [--dry-run] [--only <id|họ>]
pigo install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]
pigo doctor
# tương đương khi chưa cài pigo vào PATH:
python3 install.py add <provider-id> <api-key> --default
```

| Lệnh | Tác dụng |
|---|---|
| `add` | Ghi provider + 37 models Go (thông số từ `models.dev.json`) vào `models.json`/`auth.json`, tự thêm `<provider>/*` vào `settings.enabledModels` (nếu setting này có — Pi lọc `/model` theo nó, thiếu là chỉ thấy list cũ). `--default` đặt làm provider mặc định (`deepseek-v4-flash`). Alias: `add-go`. |
| `sync` | Quét `/models` trên Go, probe `Say OK` từng model (thử đủ 3 endpoint, mapped trước), giữ spec models.dev cho model đã biết, merge vào `models.json`. `--only deepseek` chỉ probe 1 model/họ. `--dry-run` chỉ in, không ghi. Alias: `sync-go`. Model lạ (có trên `/models` nhưng chưa có spec): ghi với context default; model trong spec nhưng `/models` không còn: vẫn giữ (add ghi đủ 37). |
| `doctor` | Kiểm tra pi, extension, lệnh `pigo`, provider Go trong `models.json`. |
| `install` | Cài lệnh `pigo` vào PATH (+extension nếu `--with-ext`). |

Mọi lần ghi file đều backup `.bak` trước. Ví dụ:

```bash
pigo add op-go-nam sk-xxx --default
pigo sync --provider op-go-nam --only deepseek --dry-run
```

`models.dev.json` là sub-catalog `opencode-go` trích từ https://models.dev/
(nguồn `context`/`maxTokens`/`cost`/`reasoning`/`input`). Chạy
`python3 refresh-models-dev.py` để tải mới (giữ thứ tự key, thêm
`_fetched_at`). Sau khi refresh, chạy `python3 assemble.py` để tái sinh
`install.py` (GO_PRESETS chép tay từ catalog — xem chú thích trong
`assemble.py` nếu models.dev thêm model mới).

## Models Go (37, từ `models.dev.json`)

| Model | API | Context | Max output | Input |
|---|---|---|---|---|
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`, `deepseek-v4.1-flash` | completions | 1M | 384K | text (+image cho vision/4.1) |
| `glm-5.1`, `glm-5` | completions | 202K | 32K | text |
| `glm-5.2`, `glm-5.3`, `glm-5.3-flash` | completions | 1M | 131K | text (+image cho flash) |
| `hy3` | completions | 256K | 128K | text |
| `hy4-preview` | completions | 1M | 64K | text |
| `kimi-k2.5`, `kimi-k2.6` | completions | 262K | 64K | text+image |
| `kimi-k2.7-code` | completions | 262K | 262K | text+image |
| `kimi-k3` | completions | 1M | 131K | text+image |
| `longcat-2.0` | completions | 1M | 131K | text |
| `mimo-v2.5`, `mimo-v2.5-pro`, `mimo-v2-pro` | completions | 1M | 128K | text (+image cho v2.5) |
| `mimo-v2-omni` | completions | 262K | 128K | text+image |
| `minimax-m2.7` | completions | 204K | 131K | text |
| `omen-alpha` | completions | 500K | 128K | text+image |
| `ox-alpha-free` | completions | 1M | 131K | text+image (free) |
| `qwen3.5-plus` | completions | 262K | 64K | text+image |
| `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus` | completions | 1M | 64K | text (+image trừ max) |
| `qwen3.8-max` | completions | 1M | 131K | text+image |
| `minimax-m3` | anthropic-messages | 1M | 131K | text+image |
| `minimax-m2.5` | anthropic-messages | 204K | 64K | text |
| `qwen3.8-flash` | anthropic-messages | 1M | 131K | text+image |
| `union-alpha` | anthropic-messages | 262K | 131K | text+image (free) |
| `gpt-5.6-luna` | responses | 1M | 128K | text+image |
| `grok-4.5`, `grok-4.6` | responses | 500K | 500K | text+image |
| `muse-spark-1.2/1.3-contributor` | responses | 1M | 131K | text+image |

Nhóm `anthropic-messages` chạy ở base rút gọn `https://opencode.ai/zen/go`
(không có `/v1`) — `install.py` ghi per-model `baseUrl` riêng cho 4 model này.
`compat`/`thinkingLevelMap` copy từ catalog builtin của Pi (models.dev không
có các trường riêng của Pi). Cost = giá thật theo models.dev (Go tính tiền
theo usage limit, kể cả 2 model free cost 0 trong gói).

## Cấu trúc

```
pi-go/
  install.py                # lệnh chung duy nhất (Python 3, không cần dep ngoài stdlib)
  assemble.py               # tái sinh install.py từ pi-zen/install.py + mảnh Go
  models.dev.json           # sub-catalog opencode-go trích từ https://models.dev/
  refresh-models-dev.py     # tải mới models.dev.json
  go-session-headers.ts     # Pi extension: gắn header + giữ session id ổn định
  README.md                 # file này
```

`assemble.py` giữ `pi-go/install.py` đồng bộ với khung chung của
`pi-zen/install.py` (headers, extension, bin, doctor): mọi cải tiến khung Zen
chỉ cần chạy `python3 assemble.py` là Go hưởng theo. GO_PRESETS chép tay từ
`models.dev.json` + catalog builtin của Pi (api/compat/thinkingLevelMap).

Extension nhận diện provider Go qua `baseUrl` chứa `opencode.ai/zen/go`
(KHÔNG khớp Zen free `opencode.ai/zen/v1`), nên cài cùng extension Zen cũng
không giành header của nhau. Lệnh `/go-session` trong Pi để xem session id
hiện tại. File này bắt buộc là TypeScript theo API extension của Pi, không gộp
vào `pigo` được.

Extension còn strip toàn bộ `reasoning` items khỏi payload Responses gửi Go
(hook `before_provider_request`), cùng lý do như bản Zen: Go route lệch
backend thì từ chối replay reasoning cũ (`encrypted_content was not issued
to this caller`). Bỏ reasoning khỏi wire (giữ nguyên function_call/output/text)
thì lỗi này không thể xảy ra; đổi lại model mất chain-of-thought cũ và reason
lại mỗi bước.

## Lấy API key Go

1. Vào https://opencode.ai/ → đăng nhập → subscribe **Go** ($10/tháng).
2. Copy API key Go (khác key Zen free).
3. Dùng key đó cho `pigo add` (`op-go-nam` chỉ là tên provider tự đặt):

```bash
pigo add op-go-nam <dán-api-key-go> --default
# nếu chưa chạy `./install.py install` thì dùng:
python3 install.py add op-go-nam <dán-api-key-go> --default
```

## Yêu cầu

- `python3` (tương thích 3.9+), `pi` đã cài.
