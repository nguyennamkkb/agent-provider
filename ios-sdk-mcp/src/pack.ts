import type { ConvertedHit, SdkFile } from './convert.js';
import { convertLine } from './convert.js';

/**
 * `availability` (chuỗi thô) chỉ giữ khi nó NÓI THÊM điều gì so với các field
 * số: unavailable/renamedTo, hoặc không parse được ra introducedIn. Ở output
 * thật, 66/91 hit lặp lại cùng một thông tin dưới 2 dạng -> ~6% token vứt đi.
 */
export function trimAvailability<T extends ConvertedHit>(h: T): T {
  if (!h.availability) return h;
  if (h.unavailable || h.renamedTo || h.introducedIn === undefined) return h;
  const { availability: _drop, ...rest } = h;
  return rest as T;
}

/** Field lặp ở MỌI phần tử và chỉ có 1 giá trị -> đưa lên header response. */
export const HOISTABLE = ['framework', 'platform', 'lang', 'filePath', 'parentType'] as const;

/**
 * Đóng gói 1 danh sách hit: tách field chung lên `common`, phần còn lại giữ
 * trong từng item. `filePath` khác nhau thì gom vào bảng `files` (id -> path)
 * và item chỉ mang `file: <id>` — path SDK dài ~80-100 ký tự, lặp 20-55 lần.
 */
export function packList(
  hits: ConvertedHit[],
  verbose: boolean,
): Record<string, unknown> {
  if (verbose) return { count: hits.length, apis: hits };
  const slim = hits.map(trimAvailability).map((h) => ({ ...h }) as Record<string, unknown>);
  const common: Record<string, unknown> = {};
  for (const f of HOISTABLE) {
    const vals = new Set(slim.map((h) => h[f]).filter((v) => v !== undefined));
    if (vals.size === 1 && slim.every((h) => h[f] !== undefined)) {
      common[f] = [...vals][0];
      for (const h of slim) delete h[f];
    }
  }
  let files: Record<number, string> | undefined;
  if (!('filePath' in common)) {
    const paths = [...new Set(slim.map((h) => h.filePath as string).filter(Boolean))];
    if (paths.length > 0 && paths.length < slim.length) {
      files = Object.fromEntries(paths.map((p, i) => [i + 1, p]));
      const idOf = new Map(paths.map((p, i) => [p, i + 1]));
      for (const h of slim) {
        if (h.filePath) {
          h.file = idOf.get(h.filePath as string);
          delete h.filePath;
        }
      }
    }
  }
  // lineNumber -> line (ngắn hơn, cùng nghĩa)
  for (const h of slim) {
    if (h.lineNumber !== undefined) {
      h.line = h.lineNumber;
      delete h.lineNumber;
    }
  }
  return {
    ...common,
    ...(files ? { files } : {}),
    count: slim.length,
    apis: slim,
  };
}

/** Mức chi tiết của 1 member trong output list: names (nhẹ nhất) ->
 * abstract (1 dòng doc + version) -> full (mọi field). Mặc định callers
 * truyền 'abstract'; 'names' cho câu "cha có con gì"; 'full' chỉ khi debug. */
export type MemberDetail = 'names' | 'abstract' | 'full';

/** Như packList nhưng cho members của 1 type (đã biết cha -> bỏ field kế thừa).
 * List KHÔNG bao giờ trả full doc: ép abstract để 1 member doc dài 5KB
 * không ngập context Agent (lỗi đã đo: docLens [26,80,170,515,44,187]). */
export function packMembers(
  parent: ConvertedHit,
  members: ConvertedHit[],
  verbose: boolean,
  detail: MemberDetail = 'abstract',
): Record<string, unknown>[] {
  if (verbose) return members as unknown as Record<string, unknown>[];
  return members.map((m) => {
    const h = { ...trimAvailability(m) } as Record<string, unknown>;
    // Suy được từ header/cha -> bỏ.
    delete h.framework;
    delete h.platform;
    delete h.lang;
    delete h.parentType;
    if (h.filePath === parent.filePath) delete h.filePath;
    if (h.introducedIn === parent.introducedIn) delete h.introducedIn;
    if (h.availability === parent.availability) delete h.availability;
    delete h.platforms;
    delete h.match;
    if (detail === 'names') {
      delete h.docComment;
      delete h.signature;
      delete h.availability;
      delete h.introducedIn;
      delete h.deprecatedIn;
      delete h.renamedTo;
      delete h.unavailable;
    } else if (typeof h.docComment === 'string') {
      // abstract: đoạn đầu tới dòng trống, ≤240 ký tự (đồng nhất search_apis).
      const first = (h.docComment as string).split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
      h.docComment = first.length > 240 ? `${first.slice(0, 239)}…` : first;
      if (!h.docComment) delete h.docComment;
    }
    h.line = h.lineNumber;
    delete h.lineNumber;
    return h;
  });
}

/**
 * Từ 1 dòng marker (`@available(...)`, `API_DEPRECATED(...)`) đi XUỐNG tìm dòng
 * khai báo mà nó gắn vào, rồi convert thành API object.
 *
 * Vì sao cần: get_new_apis/get_deprecated trước đây trả thẳng dòng marker —
 * `{"lineText":"@available(iOS 26.0, macOS 26.0, ...)"}` × 130 dòng, KHÔNG có
 * tên API nào. Agent tốn ~6k token để biết "có 130 chỗ đánh dấu iOS 26" mà vẫn
 * phải gọi read_source cho từng dòng mới biết đó là API gì.
 */
export function declFromMarker(
  file: SdkFile,
  markerLine: number,
  lines: string[],
  objcByLine?: Map<number, { name: string; kind: string; signature: string; parentType?: string; docComment?: string }>,
): ConvertedHit | null {
  for (let i = markerLine; i < Math.min(lines.length, markerLine + 12); i++) {
    const t = (lines[i] ?? '').trim();
    if (!t) continue;
    // Còn attribute/marker/comment đứng riêng dòng -> đi tiếp xuống.
    // Phải bắt MỌI attribute (`@frozen`, `@MainActor`, `@backDeployed(...)`),
    // không chỉ @available: dừng ở `@frozen` thì mất luôn decl ngay dưới nó.
    const isLoneAttr = /^@[A-Za-z_]\w*(\s*\([^)]*\))?\s*$/.test(t);
    if (isLoneAttr || /^(#|\/\/|\/\*|\*|API_|NS_)/.test(t)) continue;
    const hit = convertLine(file, i + 1, lines[i] ?? '', objcByLine);
    if (hit) return hit;
    return null;
  }
  return null;
}

/** Marker deprecated có phải deprecation THẬT không.
 * `deprecated: 100000.0` là sentinel "chưa deprecated" của Apple — trả nó ra là
 * nói dối agent rằng API đã lỗi thời. */
export function isRealDeprecation(lineText: string): boolean {
  if (/deprecated:\s*100000(\.0)?/.test(lineText)) return false;
  return true;
}

