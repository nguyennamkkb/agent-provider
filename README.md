# agent-provider

Đưa model FREE của OpenCode Zen vào coding agent. 2 module độc lập:

| Module | Agent | Cài đặt |
|---|---|---|
| [`pi-zen/`](pi-zen/) | [Pi](https://github.com/badlogic/pi-mono) | `./pi-zen/install.py install` rồi `zen add <id> <key> --default` |
| [`omp-zen/`](omp-zen/) | [omp](https://omp.sh) (fork của Pi) | `./omp-zen/install.py <id> --key 'sk-...' --default` |
| [`qwen-zen/`](qwen-zen/) | [qwen-code](https://github.com/QwenLM/qwen-code) | `./qwen-zen/install.py --key "sk-..." --default` |

Cả hai cùng ghi 1 provider Zen (baseUrl `https://opencode.ai/zen/v1`, 7 models
free đã verify, headers `x-opencode-*` vì Zen bắt buộc `x-opencode-session`).

## Lấy API key OpenCode Zen (dùng chung cho cả 3 module)

1. Vào https://opencode.ai/ → nhấn **Zen**.
2. Nhấn **Get started with Zen**.
3. Đăng nhập bằng Gmail.
4. Đăng nhập xong vào mục **API Keys** → copy API key.
5. Dùng key đó cho module tương ứng:

```bash
# pi-zen (zen-phu chỉ là tên provider tự đặt):
zen add zen-phu <dán-api-key-vừa-copy> --default
# nếu chưa chạy `./pi-zen/install.py install` thì dùng:
python3 pi-zen/install.py add zen-phu <dán-api-key-vừa-copy> --default

# omp-zen:
./omp-zen/install.py <id> --key '<dán-api-key-vừa-copy>' --default

# qwen-zen:
./qwen-zen/install.py --key "<dán-api-key-vừa-copy>" --default
```

Chi tiết xem README trong từng thư mục.
