#!/usr/bin/env python3
"""Cai dat OpenCode Zen cho qwen-code — chay duoc macOS / Linux / Windows.

Chu y: file nay co y viet KHONG DAU (console Windows cu).

Ghi vao <qwen-home>/settings.json: 2 nhom provider (openai cho model
completions, openai-responses cho ho muse-spark) + headers x-opencode-*
voi ${session_id} dong (can outboundCorrelation.allowDynamicHeaderValues).
Key viet vao <qwen-home>/.env (merge, chmod 600 tru Win).

Cach dung:
  install.py [--key <literal>] [--key-env NAME] [--default [MODEL]]
             [--qwen-home DIR] [--uninstall]
Vi du:
  install.py --key "sk-..." --default
"""
import argparse
import os
import secrets
import shutil
import struct
import sys
import time
from pathlib import Path
import json

ZEN_BASE = "https://opencode.ai/zen/v1"
DEFAULT_KEY_ENV = "OPENCODE_ZEN_API_KEY"
DEFAULT_MODEL = "mimo-v2.5-free"  # default khoi dong: wire openai on dinh
REPO_DIR = Path(__file__).resolve().parent

# Bang thong so da verify — mirror voi pi-zen/omp-zen.
# Nhom completions -> auth type "openai"; ho muse-spark -> "openai-responses".
PRESETS_COMPLETIONS = [
    {"id": "big-pickle", "contextWindow": 128000, "reasoning": True},
    {"id": "ling-3.0-flash-fin-free", "contextWindow": 256000, "reasoning": True},
    {"id": "mimo-v2.5-free", "input": ["text", "image"],
     "contextWindow": 1048576, "reasoning": True},
    {"id": "nemotron-3-ultra-free", "contextWindow": 1048576, "reasoning": False},
    {"id": "nemotron-3.5-lightning-free", "contextWindow": 1048576, "reasoning": False},
]
PRESETS_RESPONSES = [
    {"id": "muse-spark-1.3-contributor-free", "input": ["text", "image"],
     "contextWindow": 1048576, "reasoning": True},
    {"id": "muse-spark-1.2-contributor-free", "input": ["text", "image"],
     "contextWindow": 1048576, "reasoning": True},
]
ALL_IDS = ([m["id"] for m in PRESETS_COMPLETIONS] +
           [m["id"] for m in PRESETS_RESPONSES])

CUSTOM_HEADERS_COMPLETIONS = {
    # Wire openai co expand ${session_id} theo conversation that.
    "x-opencode-session": "${session_id}",
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "User-Agent": "opencode/1.18.30",
}

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def new_id(prefix: str, descending: bool) -> str:
    t = (int(time.time() * 1000) * 0x1000 + 1) & ((1 << 64) - 1)
    if descending:
        t = (~t) & ((1 << 64) - 1)
    hexpart = struct.pack(">Q", t)[2:].hex()
    rand = "".join(secrets.choice(BASE62) for _ in range(14))
    return prefix + hexpart + rand


def static_session_headers() -> dict:
    # Wire openai-responses KHONG expand placeholder (gui literal) —
    # dung id that sinh luc cai (chay install.py lai de doi session).
    return {
        "x-opencode-session": new_id("ses_", True),
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "User-Agent": "opencode/1.18.30",
    }


def qwen_home(override=None) -> Path:
    if override:
        return Path(override)
    env = os.environ.get("QWEN_HOME")
    if env:
        return Path(env)
    return Path.home() / ".qwen"


def load_json(path: Path) -> dict:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def save_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")


def backup(path: Path) -> None:
    if path.is_file():
        shutil.copy(path, str(path) + ".bak")


def chmod_private(path: Path) -> None:
    if os.name != "nt":
        os.chmod(path, 0o600)


def short_name(mid: str) -> str:
    return mid.split("/")[0].replace("-contributor-free", "").replace("-free", "")


def apply_models(mlist: list, presets: list, key_env: str, dynamic: bool) -> None:
    headers = CUSTOM_HEADERS_COMPLETIONS if dynamic else static_session_headers()
    by_id = {m.get("id"): m for m in mlist if isinstance(m, dict)}
    for preset in presets:
        m = by_id.get(preset["id"])
        if m is None:
            m = {"id": preset["id"]}
            mlist.append(m)
            by_id[preset["id"]] = m
        m["name"] = m.get("name") or f"{short_name(preset['id'])} (Zen free)"
        m["envKey"] = key_env
        m["baseUrl"] = ZEN_BASE
        gen = m.setdefault("generationConfig", {})
        gen["customHeaders"] = {**(gen.get("customHeaders") or {}), **headers}
        if preset.get("input"):
            gen.setdefault("modalities", {})["image"] = "image" in preset["input"]
        if "contextWindow" in preset:
            gen["contextWindowSize"] = preset["contextWindow"]
        # Khong dung samplingParams: docs canh bao no se nuot reasoning injection.


def write_env_key(env_path: Path, name: str, value: str) -> None:
    # Merge theo dong, giu comment + bien khac; username chi thay dong name=.
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.is_file() else []
    prefix = name + "="
    out = [l for l in lines if not l.startswith(prefix)]
    out.append(f"{prefix}{value}")
    backup(env_path)
    env_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    chmod_private(env_path)


def cmd_add(key_literal, key_env, default_model, qh: Path) -> None:
    settings_path = qh / "settings.json"
    backup(settings_path)
    cfg = load_json(settings_path)
    providers = cfg.setdefault("modelProviders", {})
    apply_models(providers.setdefault("openai", []), PRESETS_COMPLETIONS,
                 key_env or DEFAULT_KEY_ENV, dynamic=True)
    apply_models(providers.setdefault("openai-responses", []), PRESETS_RESPONSES,
                 key_env or DEFAULT_KEY_ENV, dynamic=False)
    cfg.setdefault("outboundCorrelation", {})["allowDynamicHeaderValues"] = True
    save_json(settings_path, cfg)
    print(f"Da ghi {len(ALL_IDS)} models Zen vao {settings_path}")

    if key_literal:
        write_env_key(qh / ".env", key_env or DEFAULT_KEY_ENV, key_literal)
        print(f"Da ghi key vao {qh / '.env'} (chmod 600, tru Win).")

    if default_model is not None:
        mid = default_model or DEFAULT_MODEL
        cfg = load_json(settings_path)
        cfg["model"] = {"name": mid}
        # selectedType LUON openai: ban qwen-code cu crash voi openai-responses
        # khi khoi dong (thieu key AUTH_ENV_MAPPINGS); model responses van
        # chay qua --model hoac /model picker.
        cfg.setdefault("security", {}).setdefault("auth", {})["selectedType"] = "openai"
        save_json(settings_path, cfg)
        print(f"Da dat default: {mid} (selectedType=openai).")
        if mid not in [m["id"] for m in PRESETS_COMPLETIONS]:
            print("Luu y: model responses lam default chi chay khi qwen-code "
                  "resolve runtime; neu loi, doi default ve mimo.")

    print("Kiem tra: qwen --model <id> -p \"Say OK\"")


def cmd_uninstall(qh: Path) -> None:
    settings_path = qh / "settings.json"
    if not settings_path.is_file():
        print("Khong co settings.json.")
        return
    backup(settings_path)
    cfg = load_json(settings_path)
    removed = []
    for auth in ("openai", "openai-responses"):
        mlist = (cfg.get("modelProviders", {}) or {}).get(auth, [])
        keep = [m for m in mlist
                if not (isinstance(m, dict) and m.get("id") in ALL_IDS
                        and ZEN_BASE in str(m.get("baseUrl", "")))]
        removed += [m.get("id") for m in mlist if m not in keep]
        cfg["modelProviders"][auth] = keep
    save_json(settings_path, cfg)
    print(f"Da go models: {', '.join(removed) or '(khong co)'}")
    print("Key trong .env giu lai (xoa tay neu muon).")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="install.py",
                                description="Cai dat OpenCode Zen cho qwen-code")
    p.add_argument("--key", default=None, help="key literal -> ghi .env")
    p.add_argument("--key-env", default=None,
                   help=f"ten bien env (mac dinh {DEFAULT_KEY_ENV})")
    p.add_argument("--default", nargs="?", const=DEFAULT_MODEL, default=None,
                   help="dat model mac dinh (mac dinh: mimo; chi dung wire openai)")
    p.add_argument("--qwen-home", default=None)
    p.add_argument("--uninstall", action="store_true")
    return p


def main() -> None:
    args = build_parser().parse_args()
    qh = qwen_home(args.qwen_home)
    if args.uninstall:
        cmd_uninstall(qh)
        return
    cmd_add(args.key, args.key_env, args.default, qh)


if __name__ == "__main__":
    main()
