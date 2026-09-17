#!/usr/bin/env python3
"""Assemble pi-go/install.py từ pi-zen/install.py + các mảnh Go đã tách.

Chiến lược: pi-go là bản sao pi-zen với:
- add/sync/install/doctor giữ nguyên khung Zen (headers, extension, bin...)
- GO block (const + GO_PRESETS từ models.dev) chèn sau COMPAT_COMPLETIONS
- apply_preset/ensure_provider/cmd_sync/cmd_doctor/parser/main: patch tối thiểu
- cmd_add_go/post_go/post_anthropic_go/probe_go/cmd_sync_go: def mới
- add-go/sync-go: subcommand riêng (giữ add/sync Zen nguyên — phòng user
  muốn quản trị cả 2 provider từ 1 lệnh pigo)

Chạy: python3 pi-go/assemble.py  (ghi đè pi-go/install.py)
"""

import pickle
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZEN = ROOT / "pi-zen" / "install.py"
OUT = ROOT / "pi-go" / "install.py"

p = pickle.load(open("/tmp/go-parts.pkl", "rb"))
src = ZEN.read_text(encoding="utf-8")


def rep(old: str, new: str, count: int = 1) -> None:
    global src
    assert old in src, f"ANCHOR MISSING: {old[:80]!r}"
    src = src.replace(old, new, count)


# --- 0. Docstring: giữ phần Zen, thêm phần Go ---
rep('"""Lệnh chung cho OpenCode Zen + Pi (1 file duy nhất).\n\nCách dùng:\n'
    '  zen add <provider-id> <api-key> [--default]\n'
    '  zen sync [--provider <id>] [--key <key>] [--dry-run]\n'
    '  zen install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]\n'
    '  zen doctor\n"""',
    '"""Lệnh chung cho OpenCode Go + Pi (1 file duy nhất).\n\n'
    'Go = gói subscription $10/tháng (https://opencode.ai/docs/go): key và\n'
    'endpoint riêng (https://opencode.ai/zen/go/v1), khác key Zen free.\n'
    'Thông số model lấy từ pi-go/models.dev.json (trích https://models.dev/).\n\n'
    'Cách dùng:\n'
    '  pigo add <provider-id> <api-key> [--default]\n'
    '  pigo sync [--provider <id>] [--key <key>] [--dry-run] [--only <id|họ>]\n'
    '  pigo install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]\n'
    '  pigo doctor\n"""')

# --- 1. GO block (const + GO_PRESETS) sau COMPAT_COMPLETIONS ---
rep('COMPAT_COMPLETIONS = {"supportsStore": False, "supportsDeveloperRole": False,\n'
    '                      "maxTokensField": "max_tokens"}',
    'COMPAT_COMPLETIONS = {"supportsStore": False, "supportsDeveloperRole": False,\n'
    '                      "maxTokensField": "max_tokens"}\n'
    + p["go_block"].rstrip() + "\n")

# --- 2. GO_BY_ID + GO_API_FALLBACK sau BY_ID ---
rep('BY_ID = {m["id"]: m for m in PRESETS}',
    'BY_ID = {m["id"]: m for m in PRESETS}\n' + p["go_by_fallback"].rstrip() + "\n")

# --- 3a. apply_preset: thinkingLevelMap else + per-model base ---
rep('    if "thinkingLevelMap" in preset:\n'
    '        m["thinkingLevelMap"] = dict(preset["thinkingLevelMap"])',
    p["apply_mod_think_base"])

# --- 3b. apply_preset: api else-branch (giữ api riêng Go) ---
rep('    if preset["api"] == "openai-responses":\n'
    '        m["api"] = "openai-responses"\n'
    "    else:\n"
    '        m.pop("api", None)',
    p["apply_mod_api"])

# --- 4. ensure_provider: thêm param base ---
rep("def ensure_provider(models_cfg: dict, provider: str) -> dict:",
    "def ensure_provider(models_cfg: dict, provider: str, base: str = GO_BASE) -> dict:")
rep('    entry["baseUrl"] = ZEN_BASE', p["ensure_mod"])

# --- 5. def Go mới: chèn trước "def new_id" ---
go_defs = (p["cmd_add_go"].rstrip() + "\n\n\n"
           + p["post_go"].rstrip() + "\n\n\n"
           + p["post_anthropic_go"].rstrip() + "\n\n\n"
           + p["probe_go"].rstrip() + "\n\n\n"
           + p["cmd_sync_go"].rstrip() + "\n\n\n")
rep("def new_id(prefix: str, descending: bool) -> str:",
    go_defs + "def new_id(prefix: str, descending: bool) -> str:")

# --- 5b. cmd_add_go: tự thêm "<provider>/*" vào settings.enabledModels ---
# Pi lọc /model theo enabledModels (nếu có). Không có pattern khớp provider
# mới => user chỉ thấy list cũ. Thêm vào để models hiện ngay, giữ list cũ.
_add_go_anchor = '    print(f"Đã ghi provider \'{provider}\' + {len(GO_PRESETS)} models Go")\n'
_add_go_note = '''
    # Pi lọc /model và --list-models theo settings.enabledModels (nếu có).
    # Không có entry nào khớp provider mới => user chỉ thấy list cũ.
    # Tự thêm "<provider>/*" để 37 models hiện ngay, giữ nguyên list cũ.
    settings = load_json(settings_path)
    enabled = settings.get("enabledModels")
    if isinstance(enabled, list):
        want = f"{provider}/*"
        if want not in enabled:
            shutil.copy(settings_path, str(settings_path) + ".bak")
            settings["enabledModels"] = enabled + [want]
            save_json(settings_path, settings)
            print(f"Đã thêm \'{want}\' vào enabledModels "
                  f"({len(enabled)} -> {len(enabled) + 1} patterns)")
    else:
        print("INFO: settings chưa có enabledModels (hiện toàn bộ catalogue) "
              "— không cần thêm gì")
'''
rep(_add_go_anchor, _add_go_anchor + _add_go_note)

# --- 6. doctor: lọc /go khỏi Zen + thêm report Go ---
rep(p["zen_old"], p["zen_new"])
rep('            print("[WARN] chưa có provider Zen nào, chạy: zen add <id> <key>")',
    '            print("[INFO] chưa có provider Zen nào (pi-go không quản trị Zen — dùng pi-zen)")\n'
    + p["doctor_bit"].rstrip())

# --- 7. parser: prog + subcommand add-go/sync-go ---
rep('prog="zen", description="Lệnh chung cho OpenCode Zen + Pi"',
    'prog="pigo", description="Lệnh chung cho OpenCode Go + Pi"')
rep('    sub.add_parser("doctor", help="Kiểm tra cài đặt (pi, bin, provider, headers)")',
    '    sub.add_parser("doctor", help="Kiểm tra cài đặt (pi, bin, provider, headers)")\n'
    + p["parser_bits"].rstrip())

# --- 8b. pi-go: sync parser Zen -> sync Go (giữ tên lệnh) ---
rep('    s = sub.add_parser("sync", help="Quét model free trên Zen, probe và ghi models.json")\n'
    '    s.add_argument("--provider", default="op-zen-hoang")\n'
    '    s.add_argument("--key", default=None)\n'
    '    s.add_argument("--dry-run", action="store_true")',
    '    s = sub.add_parser("sync", help="Probe models Go trên endpoint thật, merge vào models.json")\n'
    '    s.add_argument("--provider", default="op-go-nam")\n'
    '    s.add_argument("--key", default=None)\n'
    '    s.add_argument("--dry-run", action="store_true")\n'
    '    s.add_argument("--only", default=None,\n'
    '                   help="chỉ probe 1 model hoặc họ model (vd. deepseek)")')

# --- 8. main: add Zen -> add Go (giữ tên 'add'); sync Zen -> sync Go;
# add-go/sync-go giữ làm alias (cùng hàm Go) ---
rep('    if args.cmd == "add":\n'
    '        cmd_add(args.provider_id, args.api_key, args.default, home)',
    '    if args.cmd == "add":\n'
    '        cmd_add_go(args.provider_id, args.api_key, args.default, home)')
rep('    elif args.cmd == "sync":\n'
    '        cmd_sync(args.provider, args.key, args.dry_run, home)',
    '    elif args.cmd == "sync":\n'
    '        cmd_sync_go(args.provider, args.key, args.dry_run, home, args.only)\n'
    + p["main_bits"].rstrip())

# Quy ước models.dev drift (giữ GO_PRESETS == models.dev.json):
# - Model có trên /models live nhưng models.dev chưa có (vd. deepseek-flash,
#   hy3-preview từng gặp): sync sẽ báo "mới trên Go (default ctx...)" và ghi
#   vào models.json với spec default — KHÔNG thêm vào GO_PRESETS.
# - Model có trong models.dev nhưng /models live không còn (vd. ox-alpha-free):
#   giữ nguyên trong GO_PRESETS (add vẫn ghi; sync --dry-run sẽ cho biết).
# - refresh-models-dev.py chỉ cập nhật models.dev.json tham khảo; muốn đổi
#   GO_PRESETS phải sửa tay theo catalog builtin của Pi (api/compat/thinking).

# --- 9. Đổi tên lệnh/bin trong text: zen -> pigo (chỉ chỗ hiển thị) ---
rep('if which("zen"):', 'if which("pigo"):')
rep('print(f"[OK] zen: {which(\'zen\')}")', 'print(f"[OK] pigo: {which(\'pigo\')}")')
rep('print("[FAIL] lệnh zen chưa vào PATH, chạy: zen install")',
    'print("[FAIL] lệnh pigo chưa vào PATH, chạy: pigo install")')
rep('bin_dst = bin_dir / "zen"', 'bin_dst = bin_dir / "pigo"')
rep('EXT_FILE = "zen-session-headers.ts"', 'EXT_FILE = "go-session-headers.ts"')
rep('    zen_src = Path(__file__).resolve()', '    pigo_src = Path(__file__).resolve()')
rep("Path(bin_dst.readlink()) == zen_src", "Path(bin_dst.readlink()) == pigo_src")
rep("bin_dst.symlink_to(zen_src)", "bin_dst.symlink_to(pigo_src)")
rep('        bin_dst = bin_dir / "zen"', '        bin_dst = bin_dir / "pigo"')
rep('print("\\nKiểm tra: zen doctor")', 'print("\\nKiểm tra: pigo doctor")')
rep('print("== zen doctor ==")', 'print("== pigo doctor ==")')
rep('chạy: zen install --with-ext', 'chạy: pigo install --with-ext')
rep('cần id động theo conversation thì chạy: zen install --with-ext)',
    'cần id động theo conversation thì chạy: pigo install --with-ext)')
rep("chạy lại: zen add {pid} <key>", "chạy lại: pigo add {pid} <key> (không quản trị Zen — dùng pi-zen)")
rep('zen add-go --refresh-headers ', 'pigo add-go --refresh-headers ')
rep('chạy: zen add-go <id> <key>', 'chạy: pigo add-go <id> <key>')
rep('Thiếu api-key: zen add-go <provider-id> <api-key> [--default]',
    'Thiếu api-key: pigo add-go <provider-id> <api-key> [--default]')

# --- 10. Help text riêng cho pigo (parser add/sync/install gốc Zen) ---
src = src.replace("Thêm provider Zen (7 models free verify sẵn)",
                  "Thêm provider Go (37 models models.dev, key + endpoint riêng)")
src = src.replace("Cài lệnh zen vào PATH (+extension nếu --with-ext)",
                  "Cài lệnh pigo vào PATH (+extension nếu --with-ext)")

OUT.write_text(src, encoding="utf-8")
print("wrote", OUT, len(src.splitlines()), "lines")
