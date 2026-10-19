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

`zen` chính là `install.py` sau khi cài (lệnh `install` tạo symlink `~/.local/bin/zen` → `install.py`). Chưa cài thì thay `zen ...` bằng `python3 install.py ...` (hoặc `./install.py ...`) — tác dụng như nhau.

```bash
zen add <provider-id> <api-key> [--default]
zen sync [--provider <id>] [--key <key>] [--dry-run]
zen install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]
zen doctor
# tương đương khi chưa cài zen vào PATH:
python3 install.py add <provider-id> <api-key> --default
```

| Lệnh | Tác dụng |
|---|---|
| `add` | Ghi provider + 9 models free (specs từ `models.dev.json`) vào `models.json`/`auth.json`. `--default` đặt làm provider mặc định. |
| `sync` | Quét `/models` trên Zen, lọc model free, probe `Say OK` từng model, đo trần output, merge vào `models.json`. `--dry-run` chỉ in, không ghi. |
| `doctor` | Kiểm tra pi, extension, lệnh `zen`, provider Zen trong `models.json`. |

Mọi lần ghi file đều backup `.bak` trước. Ví dụ:

```bash
zen add zen-phu sk-abc...xxx --default
zen sync --provider zen-phu --dry-run
```

## Models free (bảng specs trong `install.py`, nguồn `models.dev.json`)

| Model | API | Context | Max output | Reasoning | Input |
|---|---|---|---|---|---|
| `muse-spark-1.3/1.2-contributor-free` | responses | 400k | 400k (trần client; đo tay 1M) | ✅ | text+image |
| `big-pickle` | completions | 200k | 32k | ✅ | text |
| `ling-3.1-flash-free` | completions | 262k | 32k | ✅ | text |
| `longcat-2.5-preview-free` | completions | 400k | 128k | ✅ | text+image |
| `mimo-v2.6-flash-free` | completions | 200k | 32k | ✅ | text+image |
| `nemotron-3.5-lightning-free` | completions | 262k | 262k | ✅ | text |
| `space-bunny-free` | completions | 400k | 400k (trần client; models.dev 512k) | ✅ | text+image |
| `step-5-preview-free` | completions | 400k | 64k | ✅ | text+image |

`jev-1.13-free` có trên endpoint live nhưng Pi/omp đều báo `ModelProtocolUnsupported` (cả 3 API) nên loại khỏi bảng.

Model lạ ngoài bảng: `sync` tự probe, context default 128k.

## Cấu trúc

```
pi-zen/
  install.py                # lệnh chung duy nhất (Python 3, không cần dep ngoài stdlib)
  models.dev.json           # 38 models free trích từ https://models.dev/ (chạy refresh-models-dev.py để tải mới)
  refresh-models-dev.py     # tải mới models.dev.json (provider opencode, chỉ giữ cost-0)
  zen-session-headers.ts    # Pi extension: gắn header + giữ session id ổn định
  README.md                 # file này
```

Extension nhận diện provider Zen qua `baseUrl` chứa `opencode.ai/zen` (fallback tên `zen-*`/`op-zen-*`), gắn `User-Agent: opencode/...` + `x-opencode-session`/`x-opencode-request` (mô phỏng ID OpenCode), giữ 1 session id cho cả conversation. Lệnh `/zen-session` trong Pi để xem session id hiện tại. File này bắt buộc là TypeScript theo API extension của Pi, không gộp vào `zen` được.

Extension còn strip toàn bộ `reasoning` items khỏi payload Responses gửi Zen (hook `before_provider_request`): Zen thỉnh thoảng từ chối replay reasoning cũ với lỗi `encrypted_content was not issued to this caller` do blob gắn với backend đã cấp nó mà Zen route lệch. Bỏ reasoning khỏi wire (giữ nguyên function_call/output/text) thì lỗi này không thể xảy ra; đổi lại model mất chain-of-thought cũ và reason lại mỗi bước.

## Lấy API key

1. Vào https://opencode.ai/ → nhấn **Zen**.
2. Nhấn **Get started with Zen**.
3. Đăng nhập bằng Gmail.
4. Đăng nhập xong vào mục **API Keys** → copy API key.
5. Dùng key đó cho `zen add` (`zen-phu` chỉ là tên provider tự đặt — thích tên gì cũng được, ví dụ `zen`, `op-zen`):

```bash
zen add zen-phu <dán-api-key-vừa-copy> --default
# nếu chưa chạy `./install.py install` thì dùng:
python3 install.py add zen-phu <dán-api-key-vừa-copy> --default
```

## Yêu cầu

- `python3` (tương thích 3.9+), `pi` đã cài.
