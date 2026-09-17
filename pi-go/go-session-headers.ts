import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

// Nhận diện provider OpenCode Go qua baseUrl (không hardcode tên provider).
// Khớp "opencode.ai/zen/go" (KHÔNG khớp Zen free "opencode.ai/zen/v1")
// nên cài cùng extension Zen cũng không giành header của nhau.
function isGoProvider(ctx: ExtensionContext): boolean {
  const providerId = ctx.model?.provider;
  if (!providerId) return false;
  try {
    const p = ctx.modelRegistry.getProvider(providerId) as
      | { baseUrl?: unknown }
      | undefined;
    if (typeof p?.baseUrl === "string" && p.baseUrl.includes("opencode.ai/zen/go"))
      return true;
  } catch {
    // bỏ qua, dùng fallback bên dưới
  }
  return (
    providerId === "op-go-nam" ||
    providerId.startsWith("op-go-") ||
    providerId.startsWith("go-")
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

const ENTRY_TYPE = "go-session";

export default function (pi: ExtensionAPI) {
  // Session id ổn định trong 1 Pi conversation.
  // - Session mới: sinh id mới, lưu vào session file.
  // - Resume session cũ: đọc lại id đã lưu, dùng tiếp.
  let goSession = newSessionId();

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === ENTRY_TYPE) {
        const id = (e.data as { id?: unknown } | undefined)?.id;
        if (typeof id === "string" && id.startsWith("ses_")) {
          goSession = id;
          return;
        }
      }
    }
    // Không có id cũ (session mới, hoặc session tạo trước khi có extension):
    // sinh id mới và lưu lại. Session ephemeral (vd. --no-session) thì
    // appendEntry có thể lỗi — bỏ qua, dùng id trong bộ nhớ.
    goSession = newSessionId();
    try {
      pi.appendEntry(ENTRY_TYPE, { id: goSession });
    } catch {
      // ephemeral session: giữ id trong bộ nhớ cho process hiện tại
    }
  });

  pi.on("before_provider_headers", (event, ctx) => {
    // Chỉ gắn header cho request của provider Go, không đụng provider khác.
    if (!isGoProvider(ctx)) return;

    event.headers["User-Agent"] = "opencode/1.18.30";
    event.headers["x-opencode-client"] = "cli";
    event.headers["x-opencode-project"] = "global";
    event.headers["x-opencode-session"] = goSession;
    event.headers["x-opencode-request"] = newRequestId();
  });

  // Go (giống Zen, qua MiniMax Console) thi thoảng từ chối replay reasoning cũ:
  // "reasoning `encrypted_content` was not issued to this caller".
  // Pi replay nguyên xi reasoning các turn trước (kèm encrypted_content),
  // mà blob này gắn với backend đã cấp nó — Go route sang backend khác
  // là request 400, dù cùng history retry lại có khi pass (nondeterministic).
  // Thực nghiệm: strip reasoning history thì êm được ~30 turn rồi vẫn gãy,
  // vì request giữa turn còn replay reasoning VỪA MỚI SINH của chính turn đó
  // mà Go vẫn route lệch backend. Nên bỏ TOÀN BỘ reasoning items khỏi
  // payload (history + trong turn). Giữ nguyên function_call/output/text
  // nên tool chain không gãy — chỉ mất chain-of-thought cũ, model reason
  // lại mỗi bước. Reasoning vốn optional với Responses API.
  // Đảm bảo: không còn encrypted_content nào rời máy mình => lỗi này
  // không thể xảy ra nữa (đổi lại chất lượng suy luận đa-turn giảm nhẹ).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on("before_provider_request", (event: any, ctx: any) => {
    if (!isGoProvider(ctx)) return undefined;
    const body = event?.payload;
    if (!body || typeof body !== "object" || !Array.isArray(body.input)) {
      return undefined;
    }
    const input = body.input as unknown[];
    let dropped = 0;
    const kept = input.filter((it) => {
      if (
        typeof it === "object" &&
        it !== null &&
        (it as Record<string, unknown>).type === "reasoning"
      ) {
        dropped++;
        return false;
      }
      return true;
    });
    if (!dropped) return undefined;
    return { ...body, input: kept };
  });

  pi.registerCommand("go-session", {
    description: "Xem OpenCode session id đang dùng cho provider Go",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`go session: ${goSession}`, "info");
    },
  });
}
