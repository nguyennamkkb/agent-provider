#!/usr/bin/env python3
"""Cai dat tron goi OpenCode Zen cho omp — chay duoc macOS / Linux / Windows.

Chu y: file nay co y viet KHONG DAU tieng Viet de khong vo console Windows
cu (codepage non-UTF8). Windows: best-effort (khong co may test).

Cach dung:
  install.py <provider-id> [--key <literal>] [--key-env NAME] [--default]
             [--agent-dir DIR] [--uninstall]
Vi du:
  install.py op-zen-hoang --key "sk-..." --default
"""
import argparse
import os
import shutil
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("Thieu PyYAML: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

ZEN_BASE = "https://opencode.ai/zen/v1"
DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
DEFAULT_KEY_ENV = "OPENCODE_API_KEY"
HELPER_NAME = "zen-session-id"
REPO_DIR = Path(__file__).resolve().parent

# Bang thong so da verify — mirror voi pi-zen (giu dong bo tay khi doi).
PRESETS = [
    {"id": "muse-spark-1.3-contributor-free", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 1000000,
     "reasoning": True},
    {"id": "muse-spark-1.2-contributor-free", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 1000000,
     "reasoning": True},
    {"id": "big-pickle", "api": "openai-completions",
     "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
     "reasoning": True},
    {"id": "ling-3.0-flash-fin-free", "api": "openai-completions",
     "input": ["text"], "contextWindow": 256000, "maxTokens": 32000,
     "reasoning": True},
    {"id": "mimo-v2.5-free", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 128000,
     "reasoning": True},
    {"id": "nemotron-3-ultra-free", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1048576, "maxTokens": 128000,
     "reasoning": False},
    {"id": "nemotron-3.5-lightning-free", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1048576, "maxTokens": 500000,
     "reasoning": False},
]


def find_python() -> str:
    # Ten lenh python de ghi vao headers `!command` (omp exec qua shell).
    for exe in ("python3", "python", "py"):
        if shutil.which(exe):
            return exe
    print("Khong tim thay python3/python/py trong PATH", file=sys.stderr)
    sys.exit(1)


def agent_dir(override=None) -> Path:
    if override:
        return Path(override)
    env = os.environ.get("OMP_AGENT_DIR")
    if env:
        return Path(env)
    return Path.home() / ".omp" / "agent"


def load_yml(path: Path) -> dict:
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def save_yml(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(obj, allow_unicode=True, sort_keys=False),
                    encoding="utf-8")


def backup(path: Path) -> None:
    if path.is_file():
        shutil.copy(path, str(path) + ".bak")


def chmod_private(path: Path) -> None:
    if os.name != "nt":  # Windows khong co POSIX perms
        os.chmod(path, 0o600)


def apply_preset(mlist: list, preset: dict) -> None:
    by_id = {m.get("id"): m for m in mlist if isinstance(m, dict)}
    m = by_id.get(preset["id"])
    if m is None:
        m = {"id": preset["id"]}
        mlist.append(m)
    m["input"] = preset["input"]
    m["contextWindow"] = preset["contextWindow"]
    m["maxTokens"] = preset["maxTokens"]
    m["reasoning"] = preset["reasoning"]
    if preset["api"] == "openai-responses":
        m["api"] = "openai-responses"
    else:
        m.pop("api", None)


def install_helper(dst_dir: Path) -> Path:
    # Copy helper vao agent dir de models.yml tro duong dan on dinh.
    src = REPO_DIR / HELPER_NAME
    if not src.is_file():
        print(f"Thieu file: {src}", file=sys.stderr)
        sys.exit(1)
    dst = dst_dir / HELPER_NAME
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    if os.name != "nt":
        os.chmod(dst, 0o755)
    return dst


def cmd_add(provider: str, key_literal, key_env, make_default: bool,
            adir: Path) -> None:
    models_path = adir / "models.yml"
    config_path = adir / "config.yml"
    helper = install_helper(adir)
    py = find_python()
    # Quote duong dan: Windows hay co space (C:\Users\Ten Co Dau ...).
    ses_cmd = f'{py} "{helper}" ses'
    msg_cmd = f'{py} "{helper}" msg'

    backup(models_path)
    cfg = load_yml(models_path)
    providers = cfg.setdefault("providers", {})
    entry = providers.setdefault(provider, {})
    entry["baseUrl"] = ZEN_BASE
    entry["api"] = "openai-completions"  # default; model responses override rieng
    # Merge headers: giu header custom, chi set/refresh nhom x-opencode-*.
    entry["headers"] = {
        **(entry.get("headers") or {}),
        "User-Agent": "opencode/1.18.30",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": f"!{ses_cmd}",
        "x-opencode-request": f"!{msg_cmd}",
    }
    if key_literal:
        entry["apiKey"] = key_literal
        print("WARN: key literal ghi thang vao models.yml.")
    elif key_env or "apiKey" not in entry:
        entry["apiKey"] = key_env or DEFAULT_KEY_ENV
    mlist = entry.setdefault("models", [])
    for preset in PRESETS:
        apply_preset(mlist, preset)
    save_yml(models_path, cfg)
    if key_literal:
        chmod_private(models_path)
    print(f"Da ghi provider '{provider}' + {len(PRESETS)} models vao {models_path}")

    if make_default:
        backup(config_path)
        ccfg = load_yml(config_path)
        ccfg.setdefault("modelRoles", {})["default"] = f"{provider}/{DEFAULT_MODEL}"
        save_yml(config_path, ccfg)
        print(f"Da dat default: {provider}/{DEFAULT_MODEL}")

    print(f"Kiem tra: omp models {provider}")


def cmd_uninstall(adir: Path) -> None:
    helper = adir / HELPER_NAME
    if helper.is_file():
        try:
            ours = helper.read_bytes() == (REPO_DIR / HELPER_NAME).read_bytes()
        except OSError:
            ours = False
        if ours:
            helper.unlink()
            print(f"Da go helper: {helper}")
    print("Xong. (Muon xoa provider trong models.yml thi xoa entry tay.)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="install.py", description="Cai dat OpenCode Zen cho omp")
    p.add_argument("provider_id", nargs="?",
                   help="id provider, vd. op-zen-hoang (bat buoc tru khi --uninstall)")
    p.add_argument("--key", default=None, help="key literal (file se chmod 600, tru Win)")
    p.add_argument("--key-env", default=None,
                   help=f"ten bien moi truong chua key (mac dinh {DEFAULT_KEY_ENV})")
    p.add_argument("--default", action="store_true")
    p.add_argument("--agent-dir", default=None)
    p.add_argument("--uninstall", action="store_true")
    return p


def main() -> None:
    args = build_parser().parse_args()
    adir = agent_dir(args.agent_dir)
    if args.uninstall:
        cmd_uninstall(adir)
        return
    if not args.provider_id:
        print("Thieu provider-id. VD: install.py op-zen-hoang --key 'sk-...' --default",
              file=sys.stderr)
        sys.exit(1)
    cmd_add(args.provider_id, args.key, args.key_env, args.default, adir)


if __name__ == "__main__":
    main()
