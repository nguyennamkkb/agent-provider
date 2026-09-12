import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

// Nhận diện provider OpenCode Zen qua baseUrl (không hardcode tên provider,
// nên script zen-add.sh thêm bao nhiêu provider cũng tự áp dụng).
function isZenProvider(ctx: ExtensionContext): boolean {
  const providerId = ctx.model?.provider;
  if (!providerId) return false;
  try {
    const p = ctx.modelRegistry.getProvider(providerId) as
      | { baseUrl?: unknown }
      | undefined;
    if (typeof p?.baseUrl === "string" && p.baseUrl.includes("opencode.ai/zen"))
      return true;
  } catch {
    // bỏ qua, dùng fallback bên dưới
  }
  return (
    providerId === "op-zen-hoang" ||
    providerId.startsWith("zen-") ||
    providerId.startsWith("op-zen-")
  );
}

const BASE62 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += BASE62[b % BASE62.length];
  return out;
}

// Mô phỏng OpenCode id: 6 bytes thấp của (timestamp_ms * 0x1000 + counter),
// đảo bit cho session (descending), hex + 14 ký tự base62.
function createId(descending: boolean): string {
  const now = BigInt(Date.now()) * BigInt(0x1000) + BigInt(1);
  const mask = (BigInt(1) << BigInt(64)) - BigInt(1);
  const v = descending ? ~now & mask : now & mask;
  const hex = v.toString(16).padStart(16, "0").slice(-12);
  return hex + randomBase62(14);
}

function newSessionId(): string {
  return "ses_" + createId(true);
}

function newRequestId(): string {
  return "msg_" + createId(false);
}

const ENTRY_TYPE = "zen-session";

export default function (pi: ExtensionAPI) {
  // Session id ổn định trong 1 Pi conversation.
  // - Session mới: sinh id mới, lưu vào session file.
  // - Resume session cũ: đọc lại id đã lưu, dùng tiếp.
  let zenSession = newSessionId();

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === ENTRY_TYPE) {
        const id = (e.data as { id?: unknown } | undefined)?.id;
        if (typeof id === "string" && id.startsWith("ses_")) {
          zenSession = id;
          return;
        }
      }
    }
    // Không có id cũ (session mới, hoặc session tạo trước khi có extension):
    // sinh id mới và lưu lại. Session ephemeral (vd. --no-session) thì
    // appendEntry có thể lỗi — bỏ qua, dùng id trong bộ nhớ.
    zenSession = newSessionId();
    try {
      pi.appendEntry(ENTRY_TYPE, { id: zenSession });
    } catch {
      // ephemeral session: giữ id trong bộ nhớ cho process hiện tại
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // Chỉ gắn header cho request của provider Zen, không đụng provider khác.
    if (!isZenProvider(ctx)) return;

    event.headers["User-Agent"] = "opencode/1.18.30";
    event.headers["x-opencode-client"] = "cli";
    event.headers["x-opencode-project"] = "global";
    event.headers["x-opencode-session"] = zenSession;
    event.headers["x-opencode-request"] = newRequestId();
  });

  pi.registerCommand("zen-session", {
    description: "Xem OpenCode session id đang dùng cho provider Zen",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`zen session: ${zenSession}`, "info");
    },
  });
}
