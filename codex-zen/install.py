#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cai provider OpenCode Zen cho Codex CLI (~/.codex/config.toml).

Codex chi noi Responses API voi provider custom (wire_api = "responses"
la gia tri duy nhat duoc ho tro) -> chi ho muse-spark chay duoc;
nhom completions (mimo, big-pickle, ...) khong tuong thich.

Khong phu thuoc thu vien ngoai (chay ca Python 3.9 mac dinh macOS):
sua config.toml bang splice text nen giu nguyen 100% dinh dang,
comment va cac section khac. Moi lan ghi deu backup .bak.
"""
import argparse
import os
import re
import secrets
import shutil
import struct
import sys
import time
from pathlib import Path

ZEN_BASE = "https://opencode.ai/zen/v1"
PROVIDER_ID = "op-zen-hoang"
PROVIDER_NAME = "opencode-zen"
# Chi model responses-capable (Codex khong noi /chat/completions).
RESPONSE_MODELS = [
    "muse-spark-1.3-contributor-free",
    "muse-spark-1.2-contributor-free",
]
DEFAULT_MODEL = RESPONSE_MODELS[0]
REPO_DIR = Path(__file__).resolve().parent

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def new_session() -> str:
    t = (int(time.time() * 1000) * 0x1000 + 1) & ((1 << 64) - 1)
    t = (~t) & ((1 << 64) - 1)  # descending nhu pi-zen/omp-zen
    hexpart = struct.pack(">Q", t)[2:].hex()
    rand = "".join(secrets.choice(BASE62) for _ in range(14))
    return "ses_" + hexpart + rand


def toml_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def codex_home(override=None) -> Path:
    if override:
        return Path(override)
    env = os.environ.get("CODEX_HOME")
    if env:
        return Path(env)
    return Path.home() / ".codex"


def backup(path: Path) -> None:
    if path.is_file():
        shutil.copy(path, str(path) + ".bak")


def provider_block(key_value_line: str, session: str) -> list:
    # Thu tu key mirror block minimax dang chay that tren may user.
    return [
        f"[model_providers.{PROVIDER_ID}]",
        f"name = {toml_str(PROVIDER_NAME)}",
        f"base_url = {toml_str(ZEN_BASE)}",
        key_value_line,
        'wire_api = "responses"',
        "http_headers = { "
        f"{toml_str('x-opencode-session')} = {toml_str(session)}, "
        f"{toml_str('x-opencode-client')} = {toml_str('cli')}, "
        f"{toml_str('x-opencode-project')} = {toml_str('global')} }}",
    ]


def split_sections(lines: list):
    """Tra ve (top_end, start, end): block [model_providers.<id>] hien co."""
    pat = re.compile(
        r'^\s*\[model_providers\.("?)' + re.escape(PROVIDER_ID) + r'\1\]\s*(#.*)?$')
    sec = re.compile(r'^\s*\[')
    dotted = re.compile(r'^\s*model_providers\.' + re.escape(PROVIDER_ID) + r'\.')
    start = None
    end = len(lines)
    top_end = None
    for i, ln in enumerate(lines):
        if top_end is None and sec.match(ln):
            top_end = i
        if pat.match(ln):
            start = i
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if sec.match(lines[j]):
                    end = j
                    break
            break
    if top_end is None:
        top_end = len(lines)
    return top_end, start, end, dotted


def existing_token(lines: list):
    """Lay bearer token cu trong block provider (de giu khi khong --key)."""
    _, start, end, _ = split_sections(lines)
    if start is None:
        return None
    m = re.search(r'experimental_bearer_token\s*=\s*"((?:[^"\\]|\\.)*)"',
                  "\n".join(lines[start:end]))
    if not m:
        return None
    return m.group(1).replace('\\"', '"').replace("\\\\", "\\")


def set_top_level(lines: list, key: str, value_toml: str) -> list:
    top_end, _, _, _ = split_sections(lines)
    pat = re.compile(r'^(\s*)' + re.escape(key) + r'\s*=')
    for i in range(top_end):
        m = pat.match(lines[i])
        if m:
            lines[i] = f"{m.group(1)}{key} = {value_toml}"
            return lines
    lines.insert(top_end, f"{key} = {value_toml}")
    return lines


def cmd_add(key_literal, key_env, session, default_model, ch: Path) -> None:
    cfg_path = ch / "config.toml"
    lines = (cfg_path.read_text(encoding="utf-8").splitlines()
             if cfg_path.is_file() else [])
    if key_env:
        key_line = f"env_key = {toml_str(key_env)}"
    else:
        token = key_literal or existing_token(lines)
        if not token:
            print("Thieu key: lan dau chay can --key <API_KEY> "
                  "(hoac --key-env <TEN_BIEN>).", file=sys.stderr)
            sys.exit(2)
        key_line = f"experimental_bearer_token = {toml_str(token)}"
    if session is None:
        session = new_session()

    backup(cfg_path)
    top_end, start, end, dotted = split_sections(lines)
    # Xoa block cu + dong dotted-style neu co, giu moi thu khac nguyen ven.
    kept = [ln for i, ln in enumerate(lines)
            if not (start is not None and start <= i < end)
            and not dotted.match(ln)]
    # Chen block moi truoc section dau tien (giua vung top-level) de config gon.
    top_end2 = next((i for i, ln in enumerate(kept)
                     if re.match(r'^\s*\[', ln)), len(kept))
    new_lines = (kept[:top_end2] + provider_block(key_line, session)
                 + kept[top_end2:])

    if default_model is not None:
        mid = default_model or DEFAULT_MODEL
        if mid not in RESPONSE_MODELS:
            print(f"Canh bao: {mid} khong phai model responses "
                  f"(goi y: {', '.join(RESPONSE_MODELS)}).")
        new_lines = set_top_level(new_lines, "model", toml_str(mid))
        new_lines = set_top_level(new_lines, "model_provider",
                                  toml_str(PROVIDER_ID))
        print(f"Da dat default: {mid} (model_provider={PROVIDER_ID}).")

    ch.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
    print(f"Da ghi provider {PROVIDER_ID} vao {cfg_path}")
    print("Kiem tra: codex exec -m "
          f"{DEFAULT_MODEL} -c model_provider={PROVIDER_ID} \"Say OK\"")


def cmd_uninstall(ch: Path) -> None:
    cfg_path = ch / "config.toml"
    if not cfg_path.is_file():
        print("Khong co config.toml.")
        return
    lines = cfg_path.read_text(encoding="utf-8").splitlines()
    _, start, end, dotted = split_sections(lines)
    if start is None and not any(dotted.match(l) for l in lines):
        print("Khong co provider Zen.")
        return
    backup(cfg_path)
    kept = [ln for i, ln in enumerate(lines)
            if not (start is not None and start <= i < end)
            and not dotted.match(ln)]
    # Don blank thua do block de lai (toi da 1 dong trang lien tiep).
    out, blank = [], False
    for ln in kept:
        if ln.strip() == "":
            if blank:
                continue
            blank = True
        else:
            blank = False
        out.append(ln)
    cfg_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"Da go provider {PROVIDER_ID} (key literal da xoa theo).")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="install.py",
                                description="Cai dat OpenCode Zen cho Codex CLI")
    p.add_argument("--key", default=None,
                   help="key literal -> experimental_bearer_token")
    p.add_argument("--key-env", default=None,
                   help="dung bien env cho key thay vi literal")
    p.add_argument("--session", default=None,
                   help="x-opencode-session co dinh (mac dinh: sinh moi)")
    p.add_argument("--default", nargs="?", const=DEFAULT_MODEL, default=None,
                   help="dat model mac dinh (chi ho muse-spark)")
    p.add_argument("--codex-home", default=None)
    p.add_argument("--uninstall", action="store_true")
    return p


def main() -> None:
    args = build_parser().parse_args()
    ch = codex_home(args.codex_home)
    if args.uninstall:
        cmd_uninstall(ch)
        return
    cmd_add(args.key, args.key_env, args.session, args.default, ch)


if __name__ == "__main__":
    main()
