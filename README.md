# agent-provider

Đưa model của OpenCode vào coding agent. Các module độc lập:

| Module | Agent | Nguồn model | Cài đặt |
|---|---|---|---|
| [`pi-zen/`](pi-zen/) | [Pi](https://github.com/badlogic/pi-mono) | Zen free (`opencode.ai/zen/v1`, 7 models) | `./pi-zen/install.py install` rồi `zen add <id> <key> --default` |
| [`pi-go/`](pi-go/) | [Pi](https://github.com/badlogic/pi-mono) | Go subscription $10/tháng (`opencode.ai/zen/go/v1`, 37 models) | `./pi-go/install.py install` rồi `pigo add <id> <key> --default` |
| [`omp-zen/`](omp-zen/) | [omp](https://omp.sh) (fork của Pi) | Zen free | `./omp-zen/install.py <id> --key 'sk-...' --default` |
| [`qwen-zen/`](qwen-zen/) | [qwen-code](https://github.com/QwenLM/qwen-code) | Zen free | `./qwen-zen/install.py --key "sk-..." --default` |

Cả hai cùng ghi 1 provider (baseUrl tương ứng, headers `x-opencode-*` vì
Zen/Go bắt buộc `x-opencode-session`).

## Lấy API key (Zen free và Go khác nhau)

**Zen free** (dùng chung cho pi-zen/omp-zen/qwen-zen):

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

**Go** (riêng cho pi-go — gói subscription $10/tháng, key khác key Zen):

1. Vào https://opencode.ai/ → đăng nhập → subscribe **Go**.
2. Copy API key Go.
3. Dùng key đó cho pi-go (`op-go-hoang` chỉ là tên provider tự đặt):

```bash
pigo add op-go-hoang <dán-api-key-go> --default
# nếu chưa chạy `./pi-go/install.py install` thì dùng:
python3 pi-go/install.py add op-go-hoang <dán-api-key-go> --default
```

Chi tiết xem README trong từng thư mục.
