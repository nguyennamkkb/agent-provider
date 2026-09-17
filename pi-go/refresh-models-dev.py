#!/usr/bin/env python3
"""Tải mới pi-go/models.dev.json từ https://models.dev/.

Chỉ trích provider `opencode-go`, giữ nguyên các key metadata, sắp xếp
models theo id, đóng dấu _fetched_at. Không đụng install.py — chạy thêm
`python3 assemble.py` nếu muốn (assemble không đọc file này; GO_PRESETS
chép tay — xem README).
"""
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SRC = "https://models.dev/api.json"
OUT = Path(__file__).resolve().parent / "models.dev.json"

req = urllib.request.Request(SRC, headers={"User-Agent": "pi-go-refresh/1.0"})
with urllib.request.urlopen(req, timeout=60) as r:
    full = json.load(r)

go = full["opencode-go"]
sub = {
    "_source": "https://models.dev/ (trích provider opencode-go)",
    "_note": "Tham khảo context/maxTokens/cost/reasoning/input. "
             "Pi cần thêm api/compat/thinkingLevelMap "
             "(lấy từ catalog builtin của Pi, xem README).",
    "id": go.get("id"),
    "name": go.get("name"),
    "env": go.get("env"),
    "api": go.get("api"),
    "doc": go.get("doc"),
    "models": dict(sorted(go.get("models", {}).items())),
    "_fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
}

OUT.write_text(json.dumps(sub, indent=1, ensure_ascii=False) + "\n",
               encoding="utf-8")
print(f"Đã ghi {OUT}: {len(sub['models'])} models "
      f"({', '.join(sorted(sub['models']))[:120]}...)")
