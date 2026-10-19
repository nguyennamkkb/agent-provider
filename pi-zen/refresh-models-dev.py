#!/usr/bin/env python3
"""Tải mới pi-zen/models.dev.json từ https://models.dev/.

Chỉ giữ models cost-0 (free) của provider `opencode`, sắp xếp theo id,
kèm _live_ids (ids free endpoint /models trả về lúc fetch) và _fetched_at.
Không đụng install.py — PRESETS trong install.py chép tay từ file này
(api/compat/thinkingLevelMap lấy thêm từ catalog builtin của Pi, xem README).
"""
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SRC = "https://models.dev/api.json"
LIVE = "https://opencode.ai/zen/v1/models"
OUT = Path(__file__).resolve().parent / "models.dev.json"

req = urllib.request.Request(SRC, headers={"User-Agent": "pi-zen-refresh/1.0"})
with urllib.request.urlopen(req, timeout=60) as r:
    full = json.load(r)

op = full["opencode"]
free = {mid: m for mid, m in op.get("models", {}).items()
        if m.get("cost", {}).get("input") == 0
        and m.get("cost", {}).get("output") == 0}

try:
    lreq = urllib.request.Request(LIVE, headers={"User-Agent": "opencode/1.18.30"})
    with urllib.request.urlopen(lreq, timeout=30) as r:
        live_ids = sorted(m["id"] for m in json.load(r)["data"]
                          if m["id"].endswith("-free") or m["id"] == "big-pickle")
except Exception as e:  # noqa: BLE001
    live_ids = []
    print(f"WARN: không lấy được live endpoint ({e}) — _live_ids để trống")

sub = {
    "_source": "https://models.dev/ (trích models free của provider opencode)",
    "_note": "Tham khảo context/output/reasoning/input. "
             "Pi cần thêm api/compat/thinkingLevelMap "
             "(lấy từ catalog builtin của Pi, xem README).",
    "id": op.get("id"),
    "name": op.get("name"),
    "env": op.get("env"),
    "api": op.get("api"),
    "doc": op.get("doc"),
    "models": dict(sorted(free.items())),
    "_live_ids": live_ids,
    "_fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
}

OUT.write_text(json.dumps(sub, indent=1, ensure_ascii=False) + "\n",
               encoding="utf-8")
print(f"Đã ghi {OUT}: {len(sub['models'])} models free, "
      f"{len(live_ids)} live trên endpoint")
