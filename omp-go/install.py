#!/usr/bin/env python3
"""Cai dat tron goi OpenCode Go cho omp — chay duoc macOS / Linux / Windows.

Go = goi subscription $10/thang (https://opencode.ai/docs/go): key va
endpoint rieng (https://opencode.ai/zen/go/v1), khac key Zen free.
Thong so model mirror voi pi-go (giu dong bo tay khi doi).

Chu y: file nay co y viet KHONG DAU tieng Viet de khong vo console Windows
cu (codepage non-UTF8). Windows: best-effort (khong co may test).

Cach dung:
  install.py <provider-id> [--key <literal>] [--key-env NAME] [--default]
              [--agent-dir DIR] [--uninstall]
Vi du:
  install.py op-go-nam --key "sk-..." --default
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

GO_BASE = "https://opencode.ai/zen/go/v1"
GO_BASE_ANTHROPIC = "https://opencode.ai/zen/go"
DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_KEY_ENV = "OPENCODE_API_KEY"
HELPER_NAME = "zen-session-id"
REPO_DIR = Path(__file__).resolve().parent

# Bang thong so mirror voi pi-go/GO_PRESETS (bo cost/compat/thinkingLevelMap
# vi omp khong dung; giu id/api/input/context/maxTokens/reasoning + base
# rieng cho nhom anthropic-messages chay o base rut gon khong co /v1).
GO_PRESETS = [
    {"id": "deepseek-v4-flash", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 384000,
     "reasoning": True},
    {"id": "deepseek-v4-flash-vision-exp", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 384000, "reasoning": True},
    {"id": "deepseek-v4-pro", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 384000,
     "reasoning": True},
    {"id": "deepseek-v4.1-flash", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 384000, "reasoning": True},
    {"id": "glm-5.1", "api": "openai-completions",
     "input": ["text"], "contextWindow": 202752, "maxTokens": 32768,
     "reasoning": True},
    {"id": "glm-5.2", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072,
     "reasoning": True},
    {"id": "glm-5.3", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072,
     "reasoning": True},
    {"id": "glm-5.3-flash", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True},
    {"id": "glm-5", "api": "openai-completions",
     "input": ["text"], "contextWindow": 202752, "maxTokens": 32768,
     "reasoning": True},
    {"id": "hy3", "api": "openai-completions",
     "input": ["text"], "contextWindow": 256000, "maxTokens": 128000,
     "reasoning": True},
    {"id": "hy4-preview", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1024000, "maxTokens": 64000,
     "reasoning": True},
    {"id": "kimi-k2.6", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 65536, "reasoning": True},
    {"id": "kimi-k2.7-code", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 262144, "reasoning": True},
    {"id": "kimi-k3", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1048576,
     "maxTokens": 131072, "reasoning": True},
    {"id": "kimi-k2.5", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 65536, "reasoning": True},
    {"id": "longcat-2.0", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072,
     "reasoning": True},
    {"id": "mimo-v2.5", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 128000, "reasoning": True},
    {"id": "mimo-v2.5-pro", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1048576, "maxTokens": 128000,
     "reasoning": True},
    {"id": "mimo-v2-pro", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1048576, "maxTokens": 128000,
     "reasoning": True},
    {"id": "mimo-v2-omni", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 128000, "reasoning": True},
    {"id": "minimax-m2.7", "api": "openai-completions",
     "input": ["text"], "contextWindow": 204800, "maxTokens": 131072,
     "reasoning": True},
    {"id": "omen-alpha", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 500000,
     "maxTokens": 128000, "reasoning": True},
    {"id": "qwen3.6-plus", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 65536, "reasoning": True},
    {"id": "qwen3.7-max", "api": "openai-completions",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 65536,
     "reasoning": True},
    {"id": "qwen3.7-plus", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 65536, "reasoning": True},
    {"id": "qwen3.8-max", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True},
    {"id": "qwen3.5-plus", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 65536, "reasoning": True},
    # -- anthropic-messages (base rieng GO_BASE_ANTHROPIC, khong co /v1) --
    {"id": "minimax-m3", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC,
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True},
    {"id": "minimax-m2.5", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC,
     "input": ["text"], "contextWindow": 204800, "maxTokens": 65536,
     "reasoning": True},
    {"id": "qwen3.8-flash", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC,
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True},
    # Free trong goi Go (cost 0 theo models.dev).
    {"id": "ox-alpha-free", "api": "openai-completions",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True},
    {"id": "union-alpha", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC,
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 131072, "reasoning": True},
    # -- openai-responses (base GO_BASE) --
    {"id": "gpt-5.6-luna", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 1050000,
     "maxTokens": 128000, "reasoning": True},
    {"id": "grok-4.6", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 500000,
     "maxTokens": 500000, "reasoning": True},
    {"id": "grok-4.5", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 500000,
     "maxTokens": 500000, "reasoning": True},
    {"id": "muse-spark-1.3-contributor", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 1048576,
     "maxTokens": 131072, "reasoning": True},
    {"id": "muse-spark-1.2-contributor", "api": "openai-responses",
     "input": ["text", "image"], "contextWindow": 1048576,
     "maxTokens": 131072, "reasoning": True},
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
    if preset.get("base"):
        # Model dung endpoint rieng (nhom anthropic-messages cua Go
        # chay o https://opencode.ai/zen/go, khong phai .../go/v1).
        m["baseUrl"] = preset["base"]
    else:
        m.pop("baseUrl", None)  # ke thua baseUrl cua provider
    if preset["api"] == "openai-completions":
        m.pop("api", None)  # trung default provider-level thi bo cho gon
    else:
        # responses / anthropic-messages: giu api rieng.
        m["api"] = preset["api"]


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
    entry["baseUrl"] = GO_BASE
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
    for preset in GO_PRESETS:
        apply_preset(mlist, preset)
    save_yml(models_path, cfg)
    if key_literal:
        chmod_private(models_path)
    print(f"Da ghi provider '{provider}' + {len(GO_PRESETS)} models vao {models_path}")

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
        prog="install.py", description="Cai dat OpenCode Go cho omp")
    p.add_argument("provider_id", nargs="?",
                   help="id provider, vd. op-go-nam (bat buoc tru khi --uninstall)")
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
        print("Thieu provider-id. VD: install.py op-go-nam --key 'sk-...' --default",
              file=sys.stderr)
        sys.exit(1)
    cmd_add(args.provider_id, args.key, args.key_env, args.default, adir)


if __name__ == "__main__":
    main()
