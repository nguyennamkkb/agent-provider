# agent-provider

Đưa model FREE của OpenCode Zen vào coding agent. 2 module độc lập:

| Module | Agent | Cài đặt |
|---|---|---|
| [`pi-zen/`](pi-zen/) | [Pi](https://github.com/badlogic/pi-mono) | `./pi-zen/install.py install` rồi `zen add <id> <key> --default` |
| [`omp-zen/`](omp-zen/) | [omp](https://omp.sh) (fork của Pi) | `./omp-zen/install.py <id> --key 'sk-...' --default` |

Cả hai cùng ghi 1 provider Zen (baseUrl `https://opencode.ai/zen/v1`, 7 models
free đã verify, headers `x-opencode-*` vì Zen bắt buộc `x-opencode-session`).

Chi tiết xem README trong từng thư mục.
