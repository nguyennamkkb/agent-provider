#!/usr/bin/env python3
"""Lệnh chung cho OpenCode Zen + Pi (1 file duy nhất).

Cách dùng:
  zen add <provider-id> <api-key> [--default]
  zen sync [--provider <id>] [--key <key>] [--dry-run]
  zen install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]
  zen doctor
"""
import argparse
import json
import secrets
import shutil
import struct
import sys
import time
import urllib.request
from pathlib import Path
from typing import Optional

ZEN_BASE = "https://opencode.ai/zen/v1"
EXT_FILE = "zen-session-headers.ts"
DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
REPO_DIR = Path(__file__).resolve().parent

# Pi bắt buộc mỗi model có `cost` (thiếu là crash
# "Cannot read properties of undefined (reading 'tiers')" ở khâu tính cost,
# dù API vẫn trả lời OK). Free model Zen => cost 0.
COST_ZERO = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
# responses (muse-spark) cần thinking map + compat giống catalog của Pi,
# completions cần compat maxTokensField để Pi gửi đúng trường max_tokens.
THINK_MAP_SPARK = {"off": None, "minimal": "minimal", "low": "low",
                   "medium": "medium", "high": "high", "xhigh": "xhigh",
                   "max": None}
COMPAT_RESPONSES = {"sessionAffinityFormat": "openai-nosession"}
COMPAT_COMPLETIONS = {"supportsStore": False, "supportsDeveloperRole": False,
                      "maxTokensField": "max_tokens"}

# Bảng thông số đã verify — nguồn duy nhất (trước đây trùng ở zen-add.sh).
# muse-1.3: context/output đo bằng curl; ảnh test nhận; thinking thấy trace thật.
# Còn lại: output/context theo cấu hình tay đã chốt, thinking theo trace
# quan sát được (reasoning_content / reasoning_tokens / reasoning_details).
PRESETS = [
    {"id": "muse-spark-1.3-contributor-free", "api": "openai-responses",
     "name": "Muse Spark 1.3 Free",
     "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 1000000,
     "reasoning": True, "cost": COST_ZERO,
     "thinkingLevelMap": THINK_MAP_SPARK, "compat": COMPAT_RESPONSES},
    {"id": "muse-spark-1.2-contributor-free", "api": "openai-responses",
     "name": "Muse Spark 1.2 Free",
     "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 1000000,
     "reasoning": True, "cost": COST_ZERO,
     "thinkingLevelMap": THINK_MAP_SPARK, "compat": COMPAT_RESPONSES},
    {"id": "big-pickle", "api": "openai-completions",
     "name": "Big Pickle",
     "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
     "reasoning": True, "cost": COST_ZERO, "compat": COMPAT_COMPLETIONS},
    {"id": "ling-3.0-flash-fin-free", "api": "openai-completions",
     "name": "Ling 3.0 Flash Fin Free",
     "input": ["text"], "contextWindow": 256000, "maxTokens": 32000,
     "reasoning": True, "cost": COST_ZERO, "compat": COMPAT_COMPLETIONS},
    {"id": "mimo-v2.5-free", "api": "openai-completions",
     "name": "MiMo V2.5 Free",
     "input": ["text", "image"], "contextWindow": 1048576, "maxTokens": 128000,
     "reasoning": True, "cost": COST_ZERO, "compat": COMPAT_COMPLETIONS},
    {"id": "nemotron-3-ultra-free", "api": "openai-completions",
     "name": "Nemotron 3 Ultra Free",
     "input": ["text"], "contextWindow": 1048576, "maxTokens": 128000,
     "reasoning": False, "cost": COST_ZERO, "compat": COMPAT_COMPLETIONS},
    {"id": "nemotron-3.5-lightning-free", "api": "openai-completions",
     "name": "Nemotron 3.5 Lightning Free",
     "input": ["text"], "contextWindow": 1048576, "maxTokens": 500000,
     "reasoning": False, "cost": COST_ZERO, "compat": COMPAT_COMPLETIONS},
]
BY_ID = {m["id"]: m for m in PRESETS}

# id free không theo quy tắc *-free
KNOWN_FREE_EXTRA = {"big-pickle"}
DEFAULT_SPECS = (128000, 32768, False)  # ctx mặc định khi model lạ
OUTPUT_LADDER = [1000000, 131072, 32768]
BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def pi_paths(home: Path):
    d = home / ".pi" / "agent"
    return d / "models.json", d / "auth.json", d / "settings.json"


def load_json(path: Path):
    # Pin UTF-8: không phụ thuộc locale của máy (vd. LANG=POSIX).
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def apply_preset(entry: dict, preset: dict) -> None:
    mlist = entry.setdefault("models", [])
    by_id = {m.get("id"): m for m in mlist}
    m = by_id.get(preset["id"])
    if m is None:
        m = {"id": preset["id"]}
        mlist.append(m)
    m["input"] = preset["input"]
    m["contextWindow"] = preset["contextWindow"]
    m["maxTokens"] = preset["maxTokens"]
    m["reasoning"] = preset["reasoning"]
    m["name"] = preset.get("name", preset["id"])
    # cost bắt buộc: Pi đọc model.cost.tiers không guard undefined.
    m["cost"] = dict(preset.get("cost", COST_ZERO))
    if "thinkingLevelMap" in preset:
        m["thinkingLevelMap"] = dict(preset["thinkingLevelMap"])
    if "compat" in preset:
        m["compat"] = {**(m.get("compat") or {}), **preset["compat"]}
    if preset["api"] == "openai-responses":
        m["api"] = "openai-responses"
    else:
        m.pop("api", None)


def ensure_provider(models_cfg: dict, provider: str) -> dict:
    providers = models_cfg.setdefault("providers", {})
    entry = providers.setdefault(provider, {})
    entry["baseUrl"] = ZEN_BASE
    entry["api"] = "openai-completions"  # default; model responses override riêng
    entry.setdefault("compat", {}).setdefault("supportsDeveloperRole", False)
    # Headers tĩnh như omp (Pi hỗ trợ headers ở provider): giữ header custom
    # của user, chỉ set/refresh nhóm x-opencode-* (Zen bắt buộc session).
    entry["headers"] = {**(entry.get("headers") or {}), **zen_headers_static()}
    return entry


def cmd_add(provider: str, key: str, make_default: bool, home: Path) -> None:
    models_path, auth_path, settings_path = pi_paths(home)
    shutil.copy(models_path, str(models_path) + ".bak")
    shutil.copy(auth_path, str(auth_path) + ".bak")

    models_cfg = load_json(models_path)
    auth = load_json(auth_path)
    entry = ensure_provider(models_cfg, provider)
    for preset in PRESETS:
        apply_preset(entry, preset)
    auth[provider] = {"type": "api_key", "key": key}

    save_json(models_path, models_cfg)
    save_json(auth_path, auth)
    print(f"Đã ghi provider '{provider}' + {len(PRESETS)} models")

    if make_default:
        shutil.copy(settings_path, str(settings_path) + ".bak")
        settings = load_json(settings_path)
        settings["defaultProvider"] = provider
        settings["defaultModel"] = DEFAULT_MODEL
        save_json(settings_path, settings)
        print(f"Đã đặt default: {provider}/{DEFAULT_MODEL}")

    print(f"Kiểm tra: pi --list-models | grep {provider}")


def new_id(prefix: str, descending: bool) -> str:
    t = (int(time.time() * 1000) * 0x1000 + 1) & ((1 << 64) - 1)
    if descending:
        t = (~t) & ((1 << 64) - 1)
    hexpart = struct.pack(">Q", t)[2:].hex()
    rand = "".join(secrets.choice(BASE62) for _ in range(14))
    return prefix + hexpart + rand


def zen_headers_static() -> dict:
    # Headers tĩnh ghi vào models.json (không gồm Authorization — Pi tự gắn
    # từ auth.json). Thực nghiệm (omp): Zen chỉ kiểm tra presence session.
    return {
        "User-Agent": "opencode/1.18.30",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": new_id("ses_", True),
        "x-opencode-request": new_id("msg_", False),
    }


def zen_headers(key: str) -> dict:
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "opencode/1.18.30",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-session": new_id("ses_", True),
        "x-opencode-request": new_id("msg_", False),
    }


def post(path: str, key: str, body: dict, timeout=90) -> dict:
    req = urllib.request.Request(
        ZEN_BASE + path,
        data=json.dumps(body).encode(),
        headers=zen_headers(key),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get_models(key: str) -> list:
    req = urllib.request.Request(
        ZEN_BASE + "/models",
        headers={
            "Authorization": f"Bearer {key}",
            "User-Agent": "opencode/1.18.30",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["data"]


def is_free(model_id: str) -> bool:
    return model_id.endswith("-free") or model_id in KNOWN_FREE_EXTRA


def probe(model_id: str, key: str, api: str, max_out=None):
    """Trả về (completed: bool, info: str)."""
    try:
        if api == "openai-responses":
            body = {"model": model_id, "input": "Say OK"}
            if max_out:
                body["max_output_tokens"] = max_out
            d = post("/responses", key, body)
            # "incomplete" + error None vẫn chứng tỏ model sống
            # (vd. budget 100 tokens không đủ cho reasoning ~280 tokens)
            ok = d.get("status") == "completed" or (
                d.get("status") == "incomplete" and d.get("error") is None
            )
            return ok, json.dumps(d.get("error"))[:120] if not ok else "ok"
        else:
            body = {
                "model": model_id,
                "messages": [{"role": "user", "content": "Say OK"}],
                "max_tokens": 5,
            }
            d = post("/chat/completions", key, body)
            ok = bool(d.get("choices"))
            return ok, json.dumps(d)[:120] if not ok else "ok"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {str(e)[:120]}"


def measure_max_output(model_id: str, key: str) -> int:
    for m in OUTPUT_LADDER:
        ok, _ = probe(model_id, key, "openai-responses", m)
        time.sleep(2)
        if ok:
            return m
    return 8192


def cmd_sync(provider: str, key_arg: Optional[str], dry_run: bool, home: Path) -> None:
    models_path, auth_path, _ = pi_paths(home)
    try:
        auth = load_json(auth_path)
    except FileNotFoundError:
        auth = {}
    key = key_arg or (auth.get(provider) or {}).get("key")
    if not key:
        print(f"Thiếu key: truyền --key hoặc lưu key cho '{provider}' trong auth.json")
        sys.exit(1)

    all_models = get_models(key)
    free_ids = sorted(m["id"] for m in all_models if is_free(m["id"]))
    print(f"Free models trên Zen ({len(free_ids)}): {', '.join(free_ids)}\n")

    results = []
    for mid in free_ids:
        preset = BY_ID.get(mid)
        api = (preset or {}).get("api", "openai-completions")
        ok, info = probe(mid, key, api, 8192 if api == "openai-responses" else None)
        time.sleep(2)
        if not ok and api == "openai-completions":
            # thử endpoint còn lại trước khi kết luận chết
            ok2, info2 = probe(mid, key, "openai-responses", 8192)
            time.sleep(2)
            if ok2:
                api, ok, info = "openai-responses", True, "ok (via responses)"
            else:
                info = f"completions: {info} | responses: {info2}"
        if not ok:
            print(f"- {mid}: SKIP ({info})")
            results.append((mid, api, None))
            continue
        if preset is not None:
            specs = (preset["contextWindow"], preset["maxTokens"], preset["reasoning"])
            src = "verified"
        else:
            mx = measure_max_output(mid, key) if api == "openai-responses" else 8192
            ctx, _, rs = DEFAULT_SPECS
            specs = (ctx, mx, rs)
            src = f"probed-max={mx}" if api == "openai-responses" else "default (chat endpoint, chưa đo)"
        ctx, mx, rs = specs
        print(f"+ {mid}: api={api} ctx={ctx} max={mx} reasoning={rs} [{src}]")
        results.append((mid, api, specs))

    if dry_run:
        print("\n(dry-run, không ghi file)")
        return

    shutil.copy(models_path, str(models_path) + ".bak")
    shutil.copy(auth_path, str(auth_path) + ".bak")

    auth = load_json(auth_path)
    if provider not in auth and key_arg:
        # Chỉ ghi file khi thực sự thêm key mới — không đụng các key khác.
        auth[provider] = {"type": "api_key", "key": key_arg}
        save_json(auth_path, auth)

    models_cfg = load_json(models_path)
    entry = ensure_provider(models_cfg, provider)
    mlist = entry.setdefault("models", [])
    by_id = {m.get("id"): m for m in mlist}
    for mid, api, specs in results:
        if specs is None:
            continue
        ctx, mx, rs = specs
        m = by_id.get(mid)
        if m is None:
            m = {"id": mid}
            mlist.append(m)
            by_id[mid] = m
        m["input"] = BY_ID.get(mid, {}).get("input", ["text"])
        m["contextWindow"] = ctx
        m["maxTokens"] = mx
        m["reasoning"] = rs
        m["name"] = BY_ID.get(mid, {}).get("name", mid)
        # cost bắt buộc: Pi đọc model.cost.tiers không guard undefined.
        m["cost"] = dict(BY_ID.get(mid, {}).get("cost", COST_ZERO))
        if "thinkingLevelMap" in BY_ID.get(mid, {}):
            m["thinkingLevelMap"] = dict(BY_ID[mid]["thinkingLevelMap"])
        if "compat" in BY_ID.get(mid, {}):
            m["compat"] = {**(m.get("compat") or {}), **BY_ID[mid]["compat"]}
        if api == "openai-responses":
            m["api"] = "openai-responses"
        else:
            m.pop("api", None)

    save_json(models_path, models_cfg)
    print(f"\nĐã ghi {models_path} (backup .bak)")


def cmd_install(bin_dir: Optional[Path], uninstall: bool, home: Path,
                with_ext: bool = False) -> None:
    # Extension là optional (headers tĩnh trong models.json đã đủ chạy).
    # Chỉ link extension khi --with-ext (cần ses_ riêng mỗi conversation Pi
    # và msg_ mới mỗi request thay vì id tĩnh).
    pi_dir = home / ".pi" / "agent"
    ext_dst = pi_dir / "extensions" / EXT_FILE
    ext_src = REPO_DIR / EXT_FILE
    zen_src = Path(__file__).resolve()

    if with_ext and not ext_src.is_file():
        print(f"Thiếu file: {ext_src}", file=sys.stderr)
        sys.exit(1)

    if uninstall:
        if ext_dst.is_symlink() and Path(ext_dst.readlink()) == ext_src:
            ext_dst.unlink()
            print(f"Đã gỡ extension: {ext_dst}")
        if bin_dir is not None:
            bin_dst = bin_dir / "zen"
            if bin_dst.is_symlink() and Path(bin_dst.readlink()) == zen_src:
                bin_dst.unlink()
                print(f"Đã gỡ lệnh: {bin_dst}")
        print("Xong.")
        return

    if with_ext:
        (pi_dir / "extensions").mkdir(parents=True, exist_ok=True)
        if ext_dst.is_symlink() or ext_dst.exists():
            ext_dst.unlink()
        ext_dst.symlink_to(ext_src)
        print(f"Đã link extension: {ext_dst} -> {ext_src}")

    if bin_dir is not None:
        bin_dir.mkdir(parents=True, exist_ok=True)
        bin_dst = bin_dir / "zen"
        if bin_dst.is_symlink() or bin_dst.exists():
            bin_dst.unlink()
        bin_dst.symlink_to(zen_src)
        print(f"Đã cài lệnh: {bin_dst} -> {zen_src}")
        import os as _os
        if str(bin_dir) not in _os.environ.get("PATH", "").split(":"):
            print(f'WARN: {bin_dir} chưa có trong PATH — thêm: export PATH="{bin_dir}:$PATH"')

    # Dọn symlink legacy thời chưa có lệnh chung.
    for legacy in (pi_dir / "zen-add.sh", pi_dir / "zen-sync-free.py"):
        if legacy.is_symlink():
            legacy.unlink()
            print(f"Đã dọn symlink cũ: {legacy} (dùng 'zen add' / 'zen sync' thay thế)")

    print("\nKiểm tra: zen doctor")


def cmd_doctor(home: Path) -> int:
    from shutil import which
    fail = 0
    print("== zen doctor ==")
    if which("pi"):
        print(f"[OK] pi: {which('pi')}")
    else:
        print("[FAIL] thiếu lệnh pi trong PATH")
        fail = 1

    ext_dst = home / ".pi" / "agent" / "extensions" / EXT_FILE
    if ext_dst.is_symlink():
        target = Path(ext_dst.readlink())
        print(f"[OK] extension: {ext_dst} -> {target}")
        if target != REPO_DIR / EXT_FILE:
            print("[WARN] extension đang trỏ sang repo khác, chạy: zen install --with-ext")
    elif ext_dst.is_file():
        print("[WARN] extension là file copy (không phải symlink)")
    else:
        print("[INFO] chưa cài extension (optional — headers tĩnh đã đủ chạy;")
        print("       cần id động theo conversation thì chạy: zen install --with-ext)")

    if which("zen"):
        print(f"[OK] zen: {which('zen')}")
    else:
        print("[FAIL] lệnh zen chưa vào PATH, chạy: zen install")
        fail = 1

    try:
        models_path, _, _ = pi_paths(home)
        providers = load_json(models_path).get("providers", {})
        zen_providers = [k for k, v in providers.items()
                         if "opencode.ai/zen" in str(v.get("baseUrl", ""))]
        if zen_providers:
            print(f"[OK] provider Zen trong models.json: {', '.join(zen_providers)}")
            for pid in zen_providers:
                headers = (providers[pid] or {}).get("headers", {}) or {}
                if "x-opencode-session" in headers:
                    print(f"[OK] headers tĩnh cho '{pid}' (đủ chạy không cần extension)")
                else:
                    print(f"[WARN] '{pid}' thiếu headers tĩnh, chạy lại: zen add {pid} <key>")
        else:
            print("[WARN] chưa có provider Zen nào, chạy: zen add <id> <key>")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] không đọc được models.json: {e}")
        fail = 1

    print("Mọi thứ ổn." if fail == 0 else "Có lỗi — xem dòng [FAIL] ở trên.")
    return fail


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="zen", description="Lệnh chung cho OpenCode Zen + Pi")
    sub = p.add_subparsers(dest="cmd")

    a = sub.add_parser("add", help="Thêm provider Zen (7 models free verify sẵn)")
    a.add_argument("provider_id")
    a.add_argument("api_key")
    a.add_argument("--default", action="store_true")

    s = sub.add_parser("sync", help="Quét model free trên Zen, probe và ghi models.json")
    s.add_argument("--provider", default="op-zen-hoang")
    s.add_argument("--key", default=None)
    s.add_argument("--dry-run", action="store_true")

    i = sub.add_parser("install", help="Cài lệnh zen vào PATH (+extension nếu --with-ext)")
    i.add_argument("--bin-dir", default=str(Path.home() / ".local" / "bin"))
    i.add_argument("--no-bin", action="store_true")
    i.add_argument("--uninstall", action="store_true")
    i.add_argument("--with-ext", action="store_true",
                   help="link extension gắn headers động (optional, mặc định không)")

    sub.add_parser("doctor", help="Kiểm tra cài đặt (pi, bin, provider, headers)")
    return p


def main() -> None:
    parser = build_parser()
    if len(sys.argv) == 1:
        parser.print_help()
        return
    args = parser.parse_args()
    home = Path.home()

    if args.cmd == "add":
        cmd_add(args.provider_id, args.api_key, args.default, home)
    elif args.cmd == "sync":
        cmd_sync(args.provider, args.key, args.dry_run, home)
    elif args.cmd == "install":
        cmd_install(None if args.no_bin else Path(args.bin_dir), args.uninstall,
                    home, args.with_ext)
    elif args.cmd == "doctor":
        sys.exit(cmd_doctor(home))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
