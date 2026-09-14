# agent-provider

Đưa model FREE của [OpenCode Zen](https://opencode.ai/zen/v1) vào [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Zen yêu cầu giả lập header `x-opencode-*` (thiếu `x-opencode-session` là lỗi
`MissingSessionID`). `zen add` ghi headers tĩnh thẳng vào `models.json`
(Pi hỗ trợ `headers` ở provider) — thực nghiệm chạy được không cần gì thêm.
Extension TypeScript chỉ còn tác dụng nâng cao: sinh `ses_` ổn định theo
conversation Pi và `msg_` mới mỗi request (thay vì id tĩnh chung mọi request).

## Cài đặt

```bash
./install.py install
zen doctor
```

`install` chỉ cài lệnh `zen` vào `~/.local/bin` (đã có trong PATH).
Extension là optional — chỉ thêm `--with-ext` khi cần id động theo conversation
(headers tĩnh trong `models.json` đã đủ chạy).

Tùy chọn: `--bin-dir DIR`, `--no-bin`, `--with-ext`, `--uninstall`.

## Cách dùng

```bash
zen add <provider-id> <api-key> [--default]
zen sync [--provider <id>] [--key <key>] [--dry-run]
zen install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]
zen doctor
```

| Lệnh | Tác dụng |
|---|---|
| `add` | Ghi provider + 7 models free đã verify vào `models.json`/`auth.json`. `--default` đặt làm provider mặc định. |
| `sync` | Quét `/models` trên Zen, lọc model free, probe `Say OK` từng model, đo trần output, merge vào `models.json`. `--dry-run` chỉ in, không ghi. |
| `doctor` | Kiểm tra pi, extension, lệnh `zen`, provider Zen trong `models.json`. |

Mọi lần ghi file đều backup `.bak` trước. Ví dụ:

```bash
zen add zen-phu sk-abc...xxx --default
zen sync --provider zen-phu --dry-run
```

## Models free (bảng verify sẵn trong `install.py`)

| Model | API | Context | Max output | Reasoning | Input |
|---|---|---|---|---|---|
| `muse-spark-1.3/1.2-contributor-free` | responses | 1M | 1M | ✅ | text+image |
| `big-pickle` | completions | 128k | 8k | ✅ | text |
| `ling-3.0-flash-fin-free` | completions | 256k | 32k | ✅ | text |
| `mimo-v2.5-free` | completions | 1M | 128k | ✅ | text+image |
| `nemotron-3-ultra-free` | completions | 1M | 128k | ❌ | text |
| `nemotron-3.5-lightning-free` | completions | 1M | 500k | ❌ | text |

Model lạ ngoài bảng: `sync` tự probe, context default 128k.

## Cấu trúc

```
pi-zen/
  install.py                # lệnh chung duy nhất (Python 3, không cần dep ngoài stdlib)
  zen-session-headers.ts    # Pi extension: gắn header + giữ session id ổn định
  README.md                 # file này
```

Extension nhận diện provider Zen qua `baseUrl` chứa `opencode.ai/zen` (fallback tên `zen-*`/`op-zen-*`), gắn `User-Agent: opencode/...` + `x-opencode-session`/`x-opencode-request` (mô phỏng ID OpenCode), giữ 1 session id cho cả conversation. Lệnh `/zen-session` trong Pi để xem session id hiện tại. File này bắt buộc là TypeScript theo API extension của Pi, không gộp vào `zen` được.

Extension còn strip toàn bộ `reasoning` items khỏi payload Responses gửi Zen (hook `before_provider_request`): Zen thỉnh thoảng từ chối replay reasoning cũ với lỗi `encrypted_content was not issued to this caller` do blob gắn với backend đã cấp nó mà Zen route lệch. Bỏ reasoning khỏi wire (giữ nguyên function_call/output/text) thì lỗi này không thể xảy ra; đổi lại model mất chain-of-thought cũ và reason lại mỗi bước.

## Yêu cầu

- `python3` (tương thích 3.9+), `pi` đã cài.
