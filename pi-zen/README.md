# agent-provider

Đưa model FREE của [OpenCode Zen](https://opencode.ai/zen/v1) vào [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Zen yêu cầu giả lập header `x-opencode-*` nên repo gồm 2 phần: lệnh `zen` để cấu hình provider/model, và 1 extension TypeScript để tự gắn header cho mọi request Zen.

## Cài đặt

```bash
./zen install
zen doctor
```

`install` làm 2 việc:

- Symlink `zen-session-headers.ts` → `~/.pi/agent/extensions/` (Pi tự load).
- Symlink `zen` → `~/.local/bin/zen` (đã có trong PATH).

Tùy chọn: `--bin-dir DIR`, `--no-bin` (chỉ link extension), `--uninstall`.

## Cách dùng

```bash
zen add <provider-id> <api-key> [--default]
zen sync [--provider <id>] [--key <key>] [--dry-run]
zen install [--bin-dir DIR] [--no-bin] [--uninstall]
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

## Models free (bảng verify sẵn trong `zen`)

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
  zen                       # lệnh chung duy nhất (Python 3, không cần dep ngoài stdlib)
  zen-session-headers.ts    # Pi extension: gắn header + giữ session id ổn định
  README.md                 # file này
```

Extension nhận diện provider Zen qua `baseUrl` chứa `opencode.ai/zen` (fallback tên `zen-*`/`op-zen-*`), gắn `User-Agent: opencode/...` + `x-opencode-session`/`x-opencode-request` (mô phỏng ID OpenCode), giữ 1 session id cho cả conversation. Lệnh `/zen-session` trong Pi để xem session id hiện tại. File này bắt buộc là TypeScript theo API extension của Pi, không gộp vào `zen` được.

## Yêu cầu

- `python3` (tương thích 3.9+), `pi` đã cài.
