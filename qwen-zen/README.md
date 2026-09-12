# qwen-zen

Cai dat OpenCode Zen cho [qwen-code](https://github.com/QwenLM/qwen-code).
1 file, 1 lenh:

```bash
./install.py --key "sk-..." --default     # macOS / Linux
py install.py --key "sk-..." --default    # Windows (best-effort)
```

(Chua co key? Bo `--key`, tu `export OPENCODE_ZEN_API_KEY=sk-...`.)

Kiem tra:

```bash
qwen -p "Say OK"                                        # default mimo
qwen --model muse-spark-1.3-contributor-free -p "Say OK"  # ho muse
```

## No lam gi

Ghi vao `<qwen-home>/settings.json` (mac dinh `~/.qwen`, doi bang
`--qwen-home` hoac `QWEN_HOME`): 5 models completions duoi auth type
`openai` + 2 models `muse-spark` duoi `openai-responses`, headers
`x-opencode-*` voi `${session_id}` dong theo session (can
`outboundCorrelation.allowDynamicHeaderValues`, tu bat). Key viet vao
`.env` (merge, chmod 600 tru Win). `--default` dat model mac dinh
(luon wire `openai` on dinh; model responses dung qua `--model`).

Gioi han da biet (qwen-code 0.23.3): dat `selectedType: openai-responses`
lam default se crash luc khoi dong — script khong bao gio ghi gia tri do.

Moi lan ghi deu backup `.bak`. Go models: `./install.py --uninstall`
(key trong `.env` giu lai).

## Yeu cau

`python3` (3.9+) — khong can dep ngoai. `qwen-code` da cai.

```
qwen-zen/
  install.py      # tat ca trong 1 file
  README.md       # file nay
```
