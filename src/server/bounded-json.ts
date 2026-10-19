export const MAX_RETAINED_BYTES = 256 * 1024;
export const MAX_STRUCTURAL_ID = 256;
const MAX_DEPTH = 32;
const MAX_ITEMS = 128;
const MAX_STRING_BYTES = 64 * 1024;
const STRUCTURAL_RESERVE = 1024;
const METADATA_RESERVE = 512;

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

export interface BoundedJsonResult<T = unknown> {
  value: T;
  truncated: boolean;
  retainedBytes: number;
  stats?: { inputBytes: number; maxDepth: number };
}

export interface BoundedJsonOptions {
  previewBytes?: number;
}

/** Incrementally parses JSON while retaining only a bounded projection. */
export async function parseBoundedJson<T = unknown>(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxRetainedBytes = MAX_RETAINED_BYTES,
  options: BoundedJsonOptions = {},
): Promise<BoundedJsonResult<T>> {
  const budget = Math.max(0, Math.floor(maxRetainedBytes));
  const previewLimit = Math.min(
    MAX_STRING_BYTES,
    Math.max(0, options.previewBytes ?? MAX_STRING_BYTES),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let inputBytes = 0;
  const queue: string[] = [];
  let qpos = 0;
  let eof = false;
  let retainedBytes = 0;
  let payloadBytes = 0;
  let structuralBytes = 0;
  let metadataBytes = 0;
  const structuralReserve = Math.min(
    STRUCTURAL_RESERVE,
    Math.floor(budget / 2),
  );
  const metadataReserve = Math.min(METADATA_RESERVE, Math.floor(budget / 4));
  const payloadCeiling = Math.max(
    0,
    budget - structuralReserve - metadataReserve,
  );
  let truncated = false;
  let maxDepth = 0;
  const frames: Array<{
    kind: "object" | "array";
    count: number;
    privateRole: boolean;
    privateType: boolean;
    omitted: boolean;
    truncatedAtStart: boolean;
  }> = [];
  const iterator = (async function* () {
    for await (const chunk of chunks) {
      inputBytes += chunk.byteLength;
      yield decoder.decode(chunk, { stream: true });
    }
    yield decoder.decode() ?? "";
  })();
  const textIt = iterator[Symbol.asyncIterator]();
  let current = "";
  let pos = 0;
  async function peek(): Promise<string | undefined> {
    while (pos >= current.length) {
      if (qpos < queue.length) {
        current = queue[qpos++]!;
        pos = 0;
        continue;
      }
      if (eof) return undefined;
      const n = await textIt.next();
      if (n.done) {
        eof = true;
        return undefined;
      }
      current = n.value!;
      pos = 0;
      if (current.length) return current[pos]!;
    }
    return current[pos]!;
  }
  async function take(): Promise<string> {
    const c = await peek();
    if (c === undefined) throw new Error("invalid_record");
    pos++;
    return c;
  }
  async function ws(): Promise<void> {
    while ([" ", "\n", "\r", "\t"].includes((await peek()) ?? "\0"))
      await take();
  }
  const fail = (): never => {
    throw new Error("invalid_record");
  };
  function charge(n: number, structural = false): number {
    const available = structural
      ? Math.min(
          Math.max(0, structuralReserve - structuralBytes),
          Math.max(0, budget - retainedBytes),
        )
      : Math.min(
          Math.max(0, payloadCeiling - payloadBytes),
          Math.max(0, budget - retainedBytes),
        );
    const add = Math.min(n, available);
    retainedBytes += add;
    if (structural) structuralBytes += add;
    else payloadBytes += add;
    if (add < n) truncated = true;
    return add;
  }
  function chargeMetadata(n: number): number {
    const add = Math.min(
      n,
      Math.max(0, metadataReserve - metadataBytes),
      Math.max(0, budget - retainedBytes),
    );
    retainedBytes += add;
    metadataBytes += add;
    if (add < n) {
      truncated = true;
      const frame = frames.at(-1);
      if (frame) frame.omitted = true;
    }
    return add;
  }

  async function string(
    keep: boolean,
    structural = false,
    keyMode = false,
    metadata = false,
  ): Promise<string> {
    if ((await take()) !== '"') fail();
    let out = "";
    let actualLength = 0;
    let outBytes = 0;
    let tooLong = false;
    while (true) {
      let c = await take();
      if (c === '"') break;
      if (c.charCodeAt(0) < 0x20) fail();
      if (c === "\\") {
        c = await take();
        if ('"\\/'.includes(c)) {
          /* keep */
        } else if (c === "b") c = "\b";
        else if (c === "f") c = "\f";
        else if (c === "n") c = "\n";
        else if (c === "r") c = "\r";
        else if (c === "t") c = "\t";
        else if (c === "u") {
          let hex = "";
          for (let i = 0; i < 4; i++) {
            const h = await take();
            if (!/[0-9a-f]/i.test(h)) fail();
            hex += h;
          }
          c = String.fromCharCode(parseInt(hex, 16));
        } else fail();
      }
      actualLength += Buffer.byteLength(c, "utf8");
      const charBytes = Buffer.byteLength(c, "utf8");
      const stringRoom = structural
        ? budget - retainedBytes
        : metadata
          ? Math.min(METADATA_RESERVE, metadataReserve - metadataBytes)
          : Math.min(payloadCeiling - payloadBytes, budget - retainedBytes);
      const maxOut = keyMode
        ? metadata
          ? 256
          : 1024
        : metadata
          ? Math.min(256, stringRoom)
          : Math.min(previewLimit, MAX_STRING_BYTES, stringRoom);
      if (keep && outBytes + charBytes <= maxOut) {
        out += c;
        outBytes += charBytes;
      } else if (keep && !keyMode) truncated = true;
      if (keyMode && actualLength > 1024) tooLong = true;
      if (structural && actualLength > MAX_STRUCTURAL_ID) fail();
    }
    if (metadata && keep && actualLength > 256) {
      truncated = true;
      const frame = frames.at(-1);
      if (frame) frame.omitted = true;
      keep = false;
    }
    if (keep && metadata && outBytes < actualLength) {
      truncated = true;
      const frame = frames.at(-1);
      if (frame) frame.omitted = true;
      keep = false;
    }
    if (keep && structural && outBytes < actualLength) fail();
    if (keep && !keyMode) {
      const bytes = Buffer.byteLength(out, "utf8");
      if (metadata) chargeMetadata(bytes);
      else charge(bytes, structural);
    }
    if (tooLong) {
      truncated = true;
      return "";
    }
    return out;
  }

  function sensitive(key: string): boolean {
    return [
      "thinking",
      "signature",
      "thinkingSignature",
      "textSignature",
      "stderr",
      "rawStderr",
    ].includes(key);
  }
  async function value(
    keep: boolean,
    key?: string,
    depth = 0,
  ): Promise<JsonValue | undefined> {
    if (depth > MAX_DEPTH) fail();
    maxDepth = Math.max(maxDepth, depth);
    await ws();
    const c = await peek();
    if (c === '"') {
      const structural =
        depth === 1 && ["id", "parentId", "type"].includes(key ?? "");
      const metadata = !structural && (key === "role" || key === "type");
      return string(keep && !sensitive(key ?? ""), structural, false, metadata);
    }
    if (c === "{" || c === "[") {
      const object = c === "{";
      await take();
      if (depth >= MAX_DEPTH) fail();
      const frame: (typeof frames)[number] = {
        kind: object ? ("object" as const) : ("array" as const),
        count: 0,
        privateRole: false,
        privateType: false,
        omitted: false,
        truncatedAtStart: truncated,
      };
      frames.push(frame);
      if (keep && charge(16) < 16) keep = false;
      const result: JsonObject | JsonValue[] | undefined = keep
        ? object
          ? (Object.create(null) as JsonObject)
          : []
        : undefined;
      await ws();
      const close = object ? "}" : "]";
      if ((await peek()) === close) {
        await take();
        frames.pop();
        return result;
      }
      while (true) {
        let childKey: string | undefined;
        if (object) {
          await ws();
          if ((await peek()) !== '"') fail();
          childKey = await string(keep || depth === 0, false, true);
          if (childKey) {
            const keyBytes = Buffer.byteLength(childKey, "utf8");
            const structuralKey =
              depth === 0 && ["id", "parentId", "type"].includes(childKey);
            const metadataKey =
              !structuralKey && (childKey === "role" || childKey === "type");
            if (structuralKey && keep) {
              if (charge(keyBytes, true) < keyBytes) fail();
            } else if (metadataKey && keep) {
              chargeMetadata(keyBytes);
            } else if (keep && charge(keyBytes) < keyBytes) {
              if (structuralKey) fail();
              childKey = "";
            }
          }
          await ws();
          if ((await take()) !== ":") fail();
        }
        const structuralField =
          object &&
          depth === 0 &&
          ["id", "parentId", "type"].includes(childKey ?? "");
        const privacyField =
          object && (childKey === "role" || childKey === "type");
        const metadataField =
          object &&
          !structuralField &&
          (childKey === "role" || childKey === "type");
        const childKeep =
          keep &&
          (!frame.omitted || structuralField) &&
          (metadataField ||
            structuralField ||
            privacyField ||
            (frame.count < MAX_ITEMS &&
              retainedBytes + 8 <= budget &&
              payloadBytes + 8 <= payloadCeiling));
        const retainChild =
          childKeep && !sensitive(childKey ?? "") && (!structuralField || keep);
        if (frame.count >= MAX_ITEMS) truncated = true;
        const slotBytes = childKeep
          ? metadataField
            ? 0
            : charge(8, structuralField)
          : 0;
        const canRetain = childKeep && (metadataField || slotBytes === 8);
        const truncationBeforeSensitiveValue = sensitive(childKey ?? "")
          ? truncated
          : undefined;
        const child = await value(
          retainChild && canRetain,
          childKey,
          depth + 1,
        );
        if (truncationBeforeSensitiveValue !== undefined)
          truncated = truncationBeforeSensitiveValue;
        if (metadataField && canRetain && typeof child !== "string") {
          frame.omitted = true;
          truncated = true;
        }
        if (canRetain && object && result && !Array.isArray(result)) {
          if (childKey === "role" && child === "system") {
            frame.privateRole = true;
            result.role = "system";
            truncated = true;
          } else if (childKey === "type" && child === "thinking") {
            frame.privateType = true;
            result.type = "thinking";
            truncated = true;
          } else if (
            child !== undefined &&
            retainChild &&
            !(childKey === "role" && frame.privateRole) &&
            !(childKey === "type" && frame.privateType)
          )
            Object.defineProperty(result, childKey!, {
              value: child,
              enumerable: true,
              writable: true,
              configurable: true,
            });
        } else if (
          canRetain &&
          !object &&
          result &&
          Array.isArray(result) &&
          child !== undefined
        )
          result.push(child);
        frame.count++;
        await ws();
        const delim = await take();
        if (delim === close) break;
        if (delim !== ",") fail();
        await ws();
        if ((await peek()) === close) fail();
      }
      frames.pop();
      if (frame.omitted) {
        truncated = true;
        if (depth === 0 && object && result && !Array.isArray(result)) {
          for (const key of Object.keys(result))
            if (!["id", "parentId", "type"].includes(key)) delete result[key];
        } else if (depth > 0) return undefined;
      }
      if (object && keep && result && !Array.isArray(result)) {
        if (frame.privateRole || frame.privateType) {
          for (const k of Object.keys(result))
            if (
              !(frame.privateRole && k === "role") &&
              !(frame.privateType && k === "type")
            )
              delete result[k];
        }
        if (depth === 0)
          for (const idKey of ["id", "parentId"]) {
            const id = result[idKey];
            if (id !== undefined && id !== null && typeof id !== "string")
              fail();
          }
        if (frame.privateRole || frame.privateType)
          truncated = frame.omitted ? true : frame.truncatedAtStart;
      }
      if (!object && keep) charge(8);
      return result;
    }
    if (c === "t" || c === "f" || c === "n") {
      const literal = c === "t" ? "true" : c === "f" ? "false" : "null";
      for (const expected of literal) if ((await take()) !== expected) fail();
      if (keep) charge(8);
      return literal === "true" ? true : literal === "false" ? false : null;
    }
    if (c === "-" || (c !== undefined && /[0-9]/.test(c))) {
      let token = "";
      while (true) {
        const n = await peek();
        if (!n || !/[0-9eE+\-.]/.test(n)) break;
        if (token.length >= 128) fail();
        token += await take();
      }
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token))
        fail();
      const number = Number(token);
      if (!Number.isFinite(number)) fail();
      if (keep) charge(8);
      return number;
    }
    fail();
  }
  try {
    await ws();
    const parsed = await value(true);
    await ws();
    if ((await peek()) !== undefined) fail();
    return {
      value: parsed as T,
      truncated,
      retainedBytes: Math.min(retainedBytes, budget),
      stats: { inputBytes, maxDepth },
    };
  } catch (error) {
    if ((error as Error)?.message === "work-budget") throw error;
    throw new Error("invalid_record");
  }
}
