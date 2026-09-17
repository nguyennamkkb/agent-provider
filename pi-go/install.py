#!/usr/bin/env python3
"""Lệnh chung cho OpenCode Go + Pi (1 file duy nhất).

Go = gói subscription $10/tháng (https://opencode.ai/docs/go): key và
endpoint riêng (https://opencode.ai/zen/go/v1), khác key Zen free.
Thông số model lấy từ pi-go/models.dev.json (trích https://models.dev/).

Cách dùng:
  pigo add <provider-id> <api-key> [--default]
  pigo sync [--provider <id>] [--key <key>] [--dry-run] [--only <id|họ>]
  pigo install [--bin-dir DIR] [--no-bin] [--with-ext] [--uninstall]
  pigo doctor
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
EXT_FILE = "go-session-headers.ts"
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
# --- OpenCode Go (subscription $10/tháng, https://opencode.ai/docs/go).
# Key Go khác key Zen free; endpoint khác: https://opencode.ai/zen/go/v1.
# Context/max-tokens/cost/reasoning/input lấy từ https://models.dev (provider
# `opencode-go`); api/compat/thinkingLevelMap copy từ catalog builtin của Pi
# (pi-ai dist/providers/data/opencode-go.json) vì models.dev không có các
# trường riêng của Pi. Ánh xạ api theo bảng Endpoints trong docs Go:
# /v1/responses -> openai-responses, /v1/messages -> anthropic-messages
# (base rút gọn https://opencode.ai/zen/go), còn lại -> openai-completions.
GO_BASE = "https://opencode.ai/zen/go/v1"

GO_BASE_ANTHROPIC = "https://opencode.ai/zen/go"

DEFAULT_GO_MODEL = "deepseek-v4-flash"

COMPAT_GO_DEEPSEEK = {"supportsStore": False, "supportsDeveloperRole": False,
                      "maxTokensField": "max_tokens",
                      "requiresReasoningContentOnAssistantMessages": True,
                      "thinkingFormat": "deepseek"}

COMPAT_GO_KIMI26 = {"supportsStore": False, "supportsDeveloperRole": False,
                    "maxTokensField": "max_tokens",
                    "thinkingFormat": "deepseek",
                    "supportsReasoningEffort": False,
                    "supportsLongCacheRetention": False}

COMPAT_GO_QWEN = {"supportsStore": False, "supportsDeveloperRole": False,
                  "maxTokensField": "max_tokens", "thinkingFormat": "qwen"}

THINK_GO_DS_FLASH = {"minimal": None, "low": "low", "medium": None,
                     "high": "high", "max": "max"}

THINK_GO_DS_PRO = {"minimal": None, "low": None, "medium": None,
                   "high": "high", "max": "max"}

THINK_GO_GLM2 = {"off": None, "minimal": None, "low": None,
                 "medium": None, "high": "high", "xhigh": None,
                 "max": "max"}

THINK_GO_GLM3 = {"off": None, "minimal": None, "low": "low",
                 "medium": None, "high": "high", "xhigh": None,
                 "max": "max"}

THINK_GO_HY3 = {"off": "none", "minimal": None, "low": "low",
                "medium": None, "high": "high", "xhigh": None,
                "max": None}

THINK_GO_HY4 = {"off": "none", "minimal": None, "low": None,
                "medium": None, "high": "high", "xhigh": None,
                "max": None}

THINK_GO_KIMI3 = {"off": None, "minimal": None, "low": None,
                  "medium": None, "high": None, "xhigh": None,
                  "max": "max"}

THINK_GO_OMEN = {"off": None, "minimal": None, "low": "low",
                 "medium": None, "high": "high", "xhigh": None,
                 "max": None}

THINK_GO_QWEN38MAX = {"off": None, "minimal": None, "low": "low",
                      "medium": "medium", "high": None,
                      "xhigh": "xhigh", "max": None}

THINK_GO_LUNA = {"off": None, "minimal": None, "low": "low",
                 "medium": "medium", "high": "high", "xhigh": "xhigh",
                 "max": "max"}

THINK_GO_GROK46 = {"off": None, "minimal": None, "low": "low",
                   "medium": "medium", "high": "high",
                   "xhigh": "xhigh", "max": None}

THINK_GO_KIMI26 = {"minimal": None, "low": None, "medium": None}

TIER_256K_QWEN = {"inputTokensAbove": 256000, "input": 1.2, "output": 4.8,
                  "cacheRead": 0.12, "cacheWrite": 1.5}

TIER_272K_LUNA = {"inputTokensAbove": 272000, "input": 0.4, "output": 1.8,
                  "cacheRead": 0.04, "cacheWrite": 0.5}

TIER_200K_GROK46 = {"inputTokensAbove": 200000, "input": 4, "output": 12,
                    "cacheRead": 1, "cacheWrite": 0}

TIER_200K_GROK45 = {"inputTokensAbove": 200000, "input": 4, "output": 12,
                    "cacheRead": 0.6, "cacheWrite": 0}

TIER_512K_M3 = {"inputTokensAbove": 512000, "input": 0.6, "output": 2.4,
                "cacheRead": 0.12, "cacheWrite": 0}

TIER_256K_MIMOPRO = {"inputTokensAbove": 256000, "input": 2, "output": 6,
                     "cacheRead": 0.4, "cacheWrite": 0}

# cost = giá thật theo models.dev (Go tính tiền theo usage limit) — khác Zen

# free (cost 0). tiers: giá long-context cho request vượt ngưỡng input.

GO_PRESETS = [
    # -- openai-completions (base GO_BASE) --
    {"id": "deepseek-v4-flash", "api": "openai-completions",
     "name": "DeepSeek V4 Flash", "input": ["text"],
     "contextWindow": 1000000, "maxTokens": 384000, "reasoning": True,
     "cost": {"input": 0.15, "output": 0.6, "cacheRead": 0.003,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_DS_FLASH, "compat": COMPAT_GO_DEEPSEEK},
    {"id": "deepseek-v4-flash-vision-exp", "api": "openai-completions",
     "name": "DeepSeek V4 Flash Vision Exp", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 384000, "reasoning": True,
     "cost": {"input": 0.15, "output": 0.6, "cacheRead": 0.003,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_DS_FLASH, "compat": COMPAT_GO_DEEPSEEK},
    {"id": "deepseek-v4-pro", "api": "openai-completions",
     "name": "DeepSeek V4 Pro (New)", "input": ["text"],
     "contextWindow": 1000000, "maxTokens": 384000, "reasoning": True,
     "cost": {"input": 0.66, "output": 1.98, "cacheRead": 0.022,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_DS_PRO, "compat": COMPAT_GO_DEEPSEEK},
    {"id": "deepseek-v4.1-flash", "api": "openai-completions",
     "name": "DeepSeek V4.1 Flash", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 384000, "reasoning": True,
     "cost": {"input": 0.15, "output": 0.6, "cacheRead": 0.003,
                "cacheWrite": 0},
     # cùng họ deepseek: copy compat/thinking của v4-flash (Pi không có sẵn).
     "thinkingLevelMap": THINK_GO_DS_FLASH, "compat": COMPAT_GO_DEEPSEEK},
    {"id": "glm-5.1", "api": "openai-completions", "name": "GLM-5.1",
     "input": ["text"], "contextWindow": 202752, "maxTokens": 32768,
     "reasoning": True,
     "cost": {"input": 1.4, "output": 4.4, "cacheRead": 0.26,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "glm-5.2", "api": "openai-completions", "name": "GLM-5.2",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072,
     "reasoning": True,
     "cost": {"input": 1.4, "output": 4.4, "cacheRead": 0.26,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_GLM2, "compat": COMPAT_COMPLETIONS},
    {"id": "glm-5.3", "api": "openai-completions", "name": "GLM-5.3",
     "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072,
     "reasoning": True,
     "cost": {"input": 1.4, "output": 4.4, "cacheRead": 0.26,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_GLM3, "compat": COMPAT_COMPLETIONS},
    {"id": "glm-5.3-flash", "api": "openai-completions",
     "name": "GLM-5.3-Flash", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.15, "output": 0.5, "cacheRead": 0.03,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_GLM3, "compat": COMPAT_COMPLETIONS},
    {"id": "glm-5", "api": "openai-completions", "name": "GLM-5",
     "input": ["text"], "contextWindow": 202752, "maxTokens": 32768,
     "reasoning": True,
     "cost": {"input": 1, "output": 3.2, "cacheRead": 0.2,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "hy3", "api": "openai-completions", "name": "Hy3",
     "input": ["text"], "contextWindow": 256000, "maxTokens": 128000,
     "reasoning": True,
     "cost": {"input": 0.14, "output": 0.58, "cacheRead": 0.035,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_HY3, "compat": COMPAT_COMPLETIONS},
    {"id": "hy4-preview", "api": "openai-completions",
     "name": "Hy4 preview", "input": ["text"],
     "contextWindow": 1024000, "maxTokens": 64000, "reasoning": True,
     "cost": {"input": 0.834, "output": 2.501, "cacheRead": 0.042,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_HY4, "compat": COMPAT_COMPLETIONS},
    {"id": "kimi-k2.6", "api": "openai-completions", "name": "Kimi K2.6",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 65536, "reasoning": True,
     "cost": {"input": 0.95, "output": 4, "cacheRead": 0.16,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_KIMI26, "compat": COMPAT_GO_KIMI26},
    {"id": "kimi-k2.7-code", "api": "openai-completions",
     "name": "Kimi K2.7 Code", "input": ["text", "image"],
     "contextWindow": 262144, "maxTokens": 262144, "reasoning": True,
     "cost": {"input": 0.95, "output": 4, "cacheRead": 0.19,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "kimi-k3", "api": "openai-completions", "name": "Kimi K3",
     "input": ["text", "image"], "contextWindow": 1048576,
     "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 3, "output": 15, "cacheRead": 0.3,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_KIMI3, "compat": COMPAT_COMPLETIONS},
    {"id": "kimi-k2.5", "api": "openai-completions", "name": "Kimi K2.5",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 65536, "reasoning": True,
     "cost": {"input": 0.6, "output": 3, "cacheRead": 0.08,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "longcat-2.0", "api": "openai-completions",
     "name": "LongCat-2.0", "input": ["text"],
     "contextWindow": 1000000, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.3, "output": 1.2, "cacheRead": 0.006,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "mimo-v2.5", "api": "openai-completions", "name": "MiMo V2.5",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 128000, "reasoning": True,
     "cost": {"input": 0.14, "output": 0.28, "cacheRead": 0.0028,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "mimo-v2.5-pro", "api": "openai-completions",
     "name": "MiMo V2.5 Pro", "input": ["text"],
     "contextWindow": 1048576, "maxTokens": 128000, "reasoning": True,
     "cost": {"input": 0.435, "output": 0.87, "cacheRead": 0.003625,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "mimo-v2-pro", "api": "openai-completions",
     "name": "MiMo V2 Pro", "input": ["text"],
     "contextWindow": 1048576, "maxTokens": 128000, "reasoning": True,
     "cost": {"input": 1, "output": 3, "cacheRead": 0.2,
                "cacheWrite": 0, "tiers": [TIER_256K_MIMOPRO]},
     "compat": COMPAT_COMPLETIONS},
    {"id": "mimo-v2-omni", "api": "openai-completions",
     "name": "MiMo V2 Omni", "input": ["text", "image"],
     "contextWindow": 262144, "maxTokens": 128000, "reasoning": True,
     "cost": {"input": 0.4, "output": 2, "cacheRead": 0.08,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "minimax-m2.7", "api": "openai-completions",
     "name": "MiniMax-M2.7", "input": ["text"],
     "contextWindow": 204800, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.3, "output": 1.2, "cacheRead": 0.06,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "omen-alpha", "api": "openai-completions",
     "name": "Omen Alpha", "input": ["text", "image"],
     "contextWindow": 500000, "maxTokens": 128000, "reasoning": True,
     "cost": {"input": 0.2, "output": 0.66, "cacheRead": 0.04,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_GO_OMEN, "compat": COMPAT_COMPLETIONS},
    {"id": "qwen3.6-plus", "api": "openai-completions",
     "name": "Qwen3.6 Plus", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 65536, "reasoning": True,
     "cost": {"input": 0.5, "output": 3, "cacheRead": 0.05,
                "cacheWrite": 0.625, "tiers": [TIER_256K_QWEN]},
     "compat": COMPAT_GO_QWEN},
    {"id": "qwen3.7-max", "api": "openai-completions",
     "name": "Qwen3.7 Max", "input": ["text"],
     "contextWindow": 1000000, "maxTokens": 65536, "reasoning": True,
     "cost": {"input": 2.5, "output": 7.5, "cacheRead": 0.5,
                "cacheWrite": 3.125}, "compat": COMPAT_COMPLETIONS},
    {"id": "qwen3.7-plus", "api": "openai-completions",
     "name": "Qwen3.7 Plus", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 65536, "reasoning": True,
     "cost": {"input": 0.4, "output": 1.6, "cacheRead": 0.04,
                "cacheWrite": 0.5, "tiers": [TIER_256K_QWEN]},
     "compat": COMPAT_COMPLETIONS},
    {"id": "qwen3.8-max", "api": "openai-completions",
     "name": "Qwen3.8 Max", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 2, "output": 6, "cacheRead": 0.25,
                "cacheWrite": 2.5},
     "thinkingLevelMap": THINK_GO_QWEN38MAX,
     "compat": COMPAT_COMPLETIONS},
    {"id": "qwen3.5-plus", "api": "openai-completions",
     "name": "Qwen3.5 Plus", "input": ["text", "image"],
     "contextWindow": 262144, "maxTokens": 65536, "reasoning": True,
     "cost": {"input": 0.2, "output": 1.2, "cacheRead": 0.02,
                "cacheWrite": 0.25}, "compat": COMPAT_COMPLETIONS},
    # -- anthropic-messages (base riêng GO_BASE_ANTHROPIC) --
    {"id": "minimax-m3", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC, "name": "MiniMax-M3",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.3, "output": 1.2, "cacheRead": 0.06,
                "cacheWrite": 0, "tiers": [TIER_512K_M3]}},
    {"id": "minimax-m2.5", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC, "name": "MiniMax-M2.5",
     "input": ["text"], "contextWindow": 204800, "maxTokens": 65536,
     "reasoning": True,
     "cost": {"input": 0.3, "output": 1.2, "cacheRead": 0.03,
                "cacheWrite": 0}},
    {"id": "qwen3.8-flash", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC, "name": "Qwen3.8 Flash",
     "input": ["text", "image"], "contextWindow": 1000000,
     "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.15, "output": 0.47, "cacheRead": 0.016,
                "cacheWrite": 0.2}},
    # Free trong gói Go (cost 0) — models.dev.
    {"id": "ox-alpha-free", "api": "openai-completions",
     "name": "Ox Alpha Free (Unlimited)", "input": ["text", "image"],
     "contextWindow": 1000000, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0, "output": 0, "cacheRead": 0,
                "cacheWrite": 0}, "compat": COMPAT_COMPLETIONS},
    {"id": "union-alpha", "api": "anthropic-messages",
     "base": GO_BASE_ANTHROPIC, "name": "Union Alpha Free",
     "input": ["text", "image"], "contextWindow": 262144,
     "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0, "output": 0, "cacheRead": 0,
                "cacheWrite": 0}},
    # -- openai-responses (base GO_BASE) --
    {"id": "gpt-5.6-luna", "api": "openai-responses",
     "name": "GPT-5.6 Luna", "input": ["text", "image"],
     "contextWindow": 1050000, "maxTokens": 128000, "reasoning": True,
     "cost": {"input": 0.2, "output": 1.2, "cacheRead": 0.02,
                "cacheWrite": 0.25, "tiers": [TIER_272K_LUNA]},
     "thinkingLevelMap": THINK_GO_LUNA, "compat": COMPAT_RESPONSES},
    {"id": "grok-4.6", "api": "openai-responses", "name": "Grok 4.6",
     "input": ["text", "image"], "contextWindow": 500000,
     "maxTokens": 500000, "reasoning": True,
     "cost": {"input": 2, "output": 6, "cacheRead": 0.5,
                "cacheWrite": 0, "tiers": [TIER_200K_GROK46]},
     "thinkingLevelMap": THINK_GO_GROK46, "compat": COMPAT_RESPONSES},
    {"id": "grok-4.5", "api": "openai-responses", "name": "Grok 4.5",
     "input": ["text", "image"], "contextWindow": 500000,
     "maxTokens": 500000, "reasoning": True,
     "cost": {"input": 2, "output": 6, "cacheRead": 0.3,
                "cacheWrite": 0, "tiers": [TIER_200K_GROK45]},
     # Pi chưa có grok-4.5: tạm copy thinking của grok-4.6.
     "thinkingLevelMap": THINK_GO_GROK46, "compat": COMPAT_RESPONSES},
    {"id": "muse-spark-1.3-contributor", "api": "openai-responses",
     "name": "Muse Spark 1.3 Contributor", "input": ["text", "image"],
     "contextWindow": 1048576, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0.002,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_MAP_SPARK, "compat": COMPAT_RESPONSES},
    {"id": "muse-spark-1.2-contributor", "api": "openai-responses",
     "name": "Muse Spark 1.2 Contributor", "input": ["text", "image"],
     "contextWindow": 1048576, "maxTokens": 131072, "reasoning": True,
     "cost": {"input": 0.1, "output": 0.2, "cacheRead": 0.002,
                "cacheWrite": 0},
     "thinkingLevelMap": THINK_MAP_SPARK, "compat": COMPAT_RESPONSES},
]


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
GO_BY_ID = {m["id"]: m for m in GO_PRESETS}
# Thứ tự thử endpoint khi probe sync (mapped trước, còn lại sau).
GO_API_FALLBACK = {
    "openai-completions": ["openai-completions", "openai-responses",
                              "anthropic-messages"],
    "openai-responses": ["openai-responses", "openai-completions",
                            "anthropic-messages"],
    "anthropic-messages": ["anthropic-messages", "openai-completions",
                              "openai-responses"],
}


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
    else:
        m.pop("thinkingLevelMap", None)
    if preset.get("base"):
        # Model dùng endpoint riêng (nhóm anthropic-messages của Go
        # chạy ở https://opencode.ai/zen/go, không phải .../go/v1).
        m["baseUrl"] = preset["base"]
    else:
        m.pop("baseUrl", None)  # kế thừa baseUrl của provider
    if "compat" in preset:
        m["compat"] = {**(m.get("compat") or {}), **preset["compat"]}
    if preset["api"] == "openai-completions" and entry.get("api") == "openai-completions":
        m.pop("api", None)  # trùng default provider-level thì bỏ cho gọn
    else:
        # responses / anthropic-messages: giữ api riêng (model Go
        # anthropic-messages chạy base rút gọn, không có /v1).
        m["api"] = preset["api"]


def ensure_provider(models_cfg: dict, provider: str, base: str = GO_BASE) -> dict:
    providers = models_cfg.setdefault("providers", {})
    entry = providers.setdefault(provider, {})
    entry["baseUrl"] = base
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


def cmd_add_go(provider: str, key: str, make_default: bool, home: Path) -> None:
    """Thêm provider OpenCode Go (endpoint + models + key riêng, kiểu Zen).

    Ghi cả `models` (mỗi model có per-model baseUrl khi endpoint khác
    provider-level) và `modelOverrides` (giữ thông số models.dev ngay cả khi
    Pi đổi builtin). Key Go khác key Zen (provider trong auth.json riêng).
    """
    models_path, auth_path, settings_path = pi_paths(home)
    shutil.copy(models_path, str(models_path) + ".bak")
    shutil.copy(auth_path, str(auth_path) + ".bak")

    models_cfg = load_json(models_path)
    auth = load_json(auth_path)
    entry = ensure_provider(models_cfg, provider, GO_BASE)
    for preset in GO_PRESETS:
        apply_preset(entry, preset)
    # modelOverrides: giữ đồ models.dev sau `pi update` (builtin lên catalogue
    # mới) và phòng Pi đổi bảng giá/spec builtin.
    overrides = entry.setdefault("modelOverrides", {})
    for preset in GO_PRESETS:
        ov = overrides.setdefault(preset["id"], {})
        ov["name"] = preset.get("name", preset["id"])
        ov["reasoning"] = preset["reasoning"]
        ov["input"] = list(preset["input"])
        ov["contextWindow"] = preset["contextWindow"]
        ov["maxTokens"] = preset["maxTokens"]
        ov["cost"] = {k: v for k, v in preset["cost"].items()
                        if k in ("input", "output", "cacheRead",
                                 "cacheWrite", "tiers")}
        if "thinkingLevelMap" in preset:
            ov["thinkingLevelMap"] = dict(preset["thinkingLevelMap"])
        else:
            ov.pop("thinkingLevelMap", None)
        if "compat" in preset:
            ov["compat"] = {**(ov.get("compat") or {}), **preset["compat"]}
    auth[provider] = {"type": "api_key", "key": key}

    save_json(models_path, models_cfg)
    save_json(auth_path, auth)
    print(f"Đã ghi provider '{provider}' + {len(GO_PRESETS)} models Go")

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
            print(f"Đã thêm '{want}' vào enabledModels "
                  f"({len(enabled)} -> {len(enabled) + 1} patterns)")
    else:
        print("INFO: settings chưa có enabledModels (hiện toàn bộ catalogue) "
              "— không cần thêm gì")

    if make_default:
        shutil.copy(settings_path, str(settings_path) + ".bak")
        settings = load_json(settings_path)
        settings["defaultProvider"] = provider
        settings["defaultModel"] = DEFAULT_GO_MODEL
        save_json(settings_path, settings)
        print(f"Đã đặt default: {provider}/{DEFAULT_GO_MODEL}")

    print(f"Kiểm tra: pi --list-models | grep {provider}")


def post_go(path: str, key: str, body: dict, timeout=120) -> dict:
    req = urllib.request.Request(
        GO_BASE + path,
        data=json.dumps(body).encode(),
        headers=zen_headers(key),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def post_anthropic_go(key: str, body: dict, timeout=120) -> dict:
    # Nhóm /v1/messages chạy ở base rút gọn (không có /v1).
    req = urllib.request.Request(
        GO_BASE_ANTHROPIC + "/messages",
        data=json.dumps(body).encode(),
        headers={**zen_headers(key), "anthropic-version": "2023-06-01"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def probe_go(model_id: str, key: str, api: str):
    """Trả về (ok: bool, endpoint_dùng_được: str, info: str)."""
    tried = []
    for cand in GO_API_FALLBACK.get(api, [api]):
        try:
            if cand == "openai-responses":
                d = post_go("/responses", key,
                            {"model": model_id, "input": "Say OK",
                             "max_output_tokens": 16})
                ok = d.get("status") == "completed" or (
                    d.get("status") == "incomplete"
                    and d.get("error") is None)
                info = "ok" if ok else json.dumps(d.get("error"))[:120]
            elif cand == "anthropic-messages":
                d = post_anthropic_go(key, {"model": model_id,
                                            "max_tokens": 5,
                                            "messages": [{"role": "user",
                                                          "content": "Say OK"}]})
                ok = bool((d.get("content") or [{}])[0].get("text")
                            or d.get("content"))
                info = "ok" if ok else json.dumps(d)[:120]
            else:
                d = post_go("/chat/completions", key,
                            {"model": model_id,
                             "messages": [{"role": "user",
                                           "content": "Say OK"}],
                             "max_tokens": 5})
                ok = bool(d.get("choices"))
                info = "ok" if ok else json.dumps(d)[:120]
        except Exception as e:  # noqa: BLE001
            ok, info = False, f"{type(e).__name__}: {str(e)[:100]}"
        tried.append(f"{cand}: {info}")
        if ok:
            return True, cand, ("ok" if cand == api
                                else f"ok (via {cand})")
        time.sleep(2)
    return False, api, " | ".join(tried)


def cmd_sync_go(provider: str, key_arg: Optional[str], dry_run: bool,
                home: Path, only: Optional[str] = None) -> None:
    """Probe từng model Go trên endpoint thật, merge kết quả vào models.json.

    Model có spec models.dev trong GO_BY_ID thì giữ nguyên thông số, chỉ kiểm
    tra sống/chết + endpoint đúng (docs Go và /models đôi khi lệch nhau).
    Model lạ (có trên /models nhưng chưa có spec): probe completions với
    context default (không đo trần output — Go tính tiền nên không bắn
    request đo max_tokens bừa bãi).
    """
    models_path, auth_path, _ = pi_paths(home)
    try:
        auth = load_json(auth_path)
    except FileNotFoundError:
        auth = {}
    key = key_arg or (auth.get(provider) or {}).get("key")
    if not key:
        print(f"Thiếu key: truyền --key hoặc lưu key cho '{provider}' "
              "trong auth.json")
        sys.exit(1)

    req = urllib.request.Request(
        GO_BASE + "/models",
        headers={"Authorization": f"Bearer {key}",
                 "User-Agent": "opencode/1.18.30"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        live_ids = sorted(m["id"] for m in json.load(r)["data"])
    print(f"Models trên Go ({len(live_ids)}): {', '.join(live_ids)}\n")

    targets = ([m for m in live_ids if only in (m, m.split("-")[0])]
               if only else live_ids)
    if only and not targets:
        # only có thể là tiền tố họ model (vd. deepseek): match startswith.
        targets = [m for m in live_ids if m.startswith(only)]
    if not targets:
        print(f"Không có model nào khớp '{only}'")
        sys.exit(1)

    results = []
    for mid in targets:
        preset = GO_BY_ID.get(mid)
        api = (preset or {}).get("api", "openai-completions")
        ok, used_api, info = probe_go(mid, key, api)
        time.sleep(2)
        if not ok:
            print(f"- {mid}: SKIP ({info})")
            results.append((mid, api, None))
            continue
        if preset is not None:
            specs = dict(preset)  # giữ nguyên spec models.dev
            src = "models.dev" + ("" if used_api == api
                                    else f" [endpoint thật: {used_api}]")
            if used_api != api:
                specs["api"] = used_api
        else:
            ctx, _, _ = DEFAULT_SPECS
            specs = {"api": used_api, "contextWindow": ctx,
                       "maxTokens": 8192, "reasoning": True,
                       "input": ["text"]}
            src = f"mới trên Go (default ctx={ctx}, chưa đo)"
        print(f"+ {mid}: api={specs['api']} ctx={specs['contextWindow']} "
              f"max={specs['maxTokens']} rs={specs['reasoning']} [{src}]")
        results.append((mid, used_api, specs))

    if dry_run:
        print("\n(dry-run, không ghi file)")
        return

    shutil.copy(models_path, str(models_path) + ".bak")
    shutil.copy(auth_path, str(auth_path) + ".bak")

    auth = load_json(auth_path)
    if provider not in auth and key_arg:
        auth[provider] = {"type": "api_key", "key": key_arg}
        save_json(auth_path, auth)

    models_cfg = load_json(models_path)
    entry = ensure_provider(models_cfg, provider, GO_BASE)
    mlist = entry.setdefault("models", [])
    by_id = {m.get("id"): m for m in mlist}
    for mid, api, specs in results:
        if specs is None:
            continue
        preset = GO_BY_ID.get(mid, {})
        m = by_id.get(mid)
        if m is None:
            m = {"id": mid}
            mlist.append(m)
            by_id[mid] = m
        m["input"] = list(specs.get("input", preset.get("input", ["text"])))
        m["contextWindow"] = specs.get("contextWindow",
                                         preset.get("contextWindow", 128000))
        m["maxTokens"] = specs.get("maxTokens",
                                     preset.get("maxTokens", 8192))
        m["reasoning"] = specs.get("reasoning",
                                     preset.get("reasoning", True))
        m["name"] = preset.get("name", mid)
        m["cost"] = dict(specs.get("cost", preset.get("cost", COST_ZERO)))
        if "thinkingLevelMap" in (specs or preset):
            m["thinkingLevelMap"] = dict((specs or preset)["thinkingLevelMap"])
        else:
            m.pop("thinkingLevelMap", None)
        if "compat" in (specs or preset):
            m["compat"] = {**(m.get("compat") or {}),
                             **(specs or preset)["compat"]}
        if specs.get("api") == "openai-responses":
            m["api"] = "openai-responses"
        elif specs.get("api") == "anthropic-messages":
            m["api"] = "anthropic-messages"
        else:
            m.pop("api", None)
        if preset.get("base"):
            m["baseUrl"] = preset["base"]
        else:
            m.pop("baseUrl", None)

    save_json(models_path, models_cfg)
    print(f"\nĐã ghi {models_path} (backup .bak)")


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
    pigo_src = Path(__file__).resolve()

    if with_ext and not ext_src.is_file():
        print(f"Thiếu file: {ext_src}", file=sys.stderr)
        sys.exit(1)

    if uninstall:
        if ext_dst.is_symlink() and Path(ext_dst.readlink()) == ext_src:
            ext_dst.unlink()
            print(f"Đã gỡ extension: {ext_dst}")
        if bin_dir is not None:
            bin_dst = bin_dir / "pigo"
            if bin_dst.is_symlink() and Path(bin_dst.readlink()) == pigo_src:
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
        bin_dst = bin_dir / "pigo"
        if bin_dst.is_symlink() or bin_dst.exists():
            bin_dst.unlink()
        bin_dst.symlink_to(pigo_src)
        print(f"Đã cài lệnh: {bin_dst} -> {zen_src}")
        import os as _os
        if str(bin_dir) not in _os.environ.get("PATH", "").split(":"):
            print(f'WARN: {bin_dir} chưa có trong PATH — thêm: export PATH="{bin_dir}:$PATH"')

    # Dọn symlink legacy thời chưa có lệnh chung.
    for legacy in (pi_dir / "zen-add.sh", pi_dir / "zen-sync-free.py"):
        if legacy.is_symlink():
            legacy.unlink()
            print(f"Đã dọn symlink cũ: {legacy} (dùng 'zen add' / 'zen sync' thay thế)")

    print("\nKiểm tra: pigo doctor")


def cmd_doctor(home: Path) -> int:
    from shutil import which
    fail = 0
    print("== pigo doctor ==")
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
            print("[WARN] extension đang trỏ sang repo khác, chạy: pigo install --with-ext")
    elif ext_dst.is_file():
        print("[WARN] extension là file copy (không phải symlink)")
    else:
        print("[INFO] chưa cài extension (optional — headers tĩnh đã đủ chạy;")
        print("       cần id động theo conversation thì chạy: pigo install --with-ext)")

    if which("pigo"):
        print(f"[OK] pigo: {which('pigo')}")
    else:
        print("[FAIL] lệnh pigo chưa vào PATH, chạy: pigo install")
        fail = 1

    try:
        models_path, _, _ = pi_paths(home)
        providers = load_json(models_path).get("providers", {})
        zen_providers = [k for k, v in providers.items()
                         if "opencode.ai/zen" in str(v.get("baseUrl", ""))
                         and "/go" not in str(v.get("baseUrl", ""))]
        if zen_providers:
            print(f"[OK] provider Zen trong models.json: {', '.join(zen_providers)}")
            for pid in zen_providers:
                headers = (providers[pid] or {}).get("headers", {}) or {}
                if "x-opencode-session" in headers:
                    print(f"[OK] headers tĩnh cho '{pid}' (đủ chạy không cần extension)")
                else:
                    print(f"[WARN] '{pid}' thiếu headers tĩnh, chạy lại: pigo add {pid} <key> (không quản trị Zen — dùng pi-zen)")
        else:
            print("[INFO] chưa có provider Zen nào (pi-go không quản trị Zen — dùng pi-zen)")
        go_providers = [k for k, v in providers.items()
                        if "opencode.ai/zen/go" in str(v.get("baseUrl", ""))]
        if go_providers:
            print(f"[OK] provider Go trong models.json: {', '.join(go_providers)}")
            for pid in go_providers:
                n = len((providers[pid] or {}).get("models", []))
                headers = (providers[pid] or {}).get("headers", {}) or {}
                ok_h = "x-opencode-session" in headers
                print(f"[{'OK' if ok_h else 'WARN'}] '{pid}': {n} models, "
                      f"headers tĩnh={'có' if ok_h else 'thiếu (chạy: pigo add-go --refresh-headers '+pid+')'}")
        else:
            print("[INFO] chưa có provider Go nào, chạy: pigo add-go <id> <key>")
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] không đọc được models.json: {e}")
        fail = 1

    print("Mọi thứ ổn." if fail == 0 else "Có lỗi — xem dòng [FAIL] ở trên.")
    return fail


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pigo", description="Lệnh chung cho OpenCode Go + Pi")
    sub = p.add_subparsers(dest="cmd")

    a = sub.add_parser("add", help="Thêm provider Go (37 models models.dev, key + endpoint riêng)")
    a.add_argument("provider_id")
    a.add_argument("api_key")
    a.add_argument("--default", action="store_true")

    s = sub.add_parser("sync", help="Probe models Go trên endpoint thật, merge vào models.json")
    s.add_argument("--provider", default="op-go-nam")
    s.add_argument("--key", default=None)
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--only", default=None,
                   help="chỉ probe 1 model hoặc họ model (vd. deepseek)")

    i = sub.add_parser("install", help="Cài lệnh pigo vào PATH (+extension nếu --with-ext)")
    i.add_argument("--bin-dir", default=str(Path.home() / ".local" / "bin"))
    i.add_argument("--no-bin", action="store_true")
    i.add_argument("--uninstall", action="store_true")
    i.add_argument("--with-ext", action="store_true",
                   help="link extension gắn headers động (optional, mặc định không)")

    sub.add_parser("doctor", help="Kiểm tra cài đặt (pi, bin, provider, headers)")
    g = sub.add_parser("add-go", help="Thêm provider OpenCode Go (key + endpoint riêng)")
    g.add_argument("provider_id", nargs="?", default="op-go-nam")
    g.add_argument("api_key", nargs="?", default=None)
    g.add_argument("--default", action="store_true")
    g.add_argument("--refresh-headers", action="store_true",
                   help="chỉ refresh headers tĩnh, giữ nguyên models")

    gs = sub.add_parser("sync-go", help="Probe models Go trên endpoint thật")
    gs.add_argument("--provider", default="op-go-nam")
    gs.add_argument("--key", default=None)
    gs.add_argument("--dry-run", action="store_true")
    gs.add_argument("--only", default=None,
                    help="chỉ probe 1 model hoặc họ model (vd. deepseek)")
    return p


def main() -> None:
    parser = build_parser()
    if len(sys.argv) == 1:
        parser.print_help()
        return
    args = parser.parse_args()
    home = Path.home()

    if args.cmd == "add":
        cmd_add_go(args.provider_id, args.api_key, args.default, home)
    elif args.cmd == "sync":
        cmd_sync_go(args.provider, args.key, args.dry_run, home, args.only)
    elif args.cmd == "add-go":
        if args.refresh_headers:
            models_path, _, _ = pi_paths(home)
            shutil.copy(models_path, str(models_path) + ".bak")
            cfg = load_json(models_path)
            entry = ensure_provider(cfg, args.provider_id, GO_BASE)
            save_json(models_path, cfg)
            print(f"Đã refresh headers tĩnh cho '{args.provider_id}'")
        elif not args.api_key:
            print("Thiếu api-key: pigo add-go <provider-id> <api-key> [--default]",
                  file=sys.stderr)
            sys.exit(2)
        else:
            cmd_add_go(args.provider_id, args.api_key, args.default, home)
    elif args.cmd == "sync-go":
        cmd_sync_go(args.provider, args.key, args.dry_run, home, args.only)
    elif args.cmd == "install":
        cmd_install(None if args.no_bin else Path(args.bin_dir), args.uninstall,
                    home, args.with_ext)
    elif args.cmd == "doctor":
        sys.exit(cmd_doctor(home))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
