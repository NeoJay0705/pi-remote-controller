export const MAX_STREAM_TEXT = 64 * 1024;
const TRUNCATION_MARKER = "\n\n[內容已截斷]";

type TextBlock = { text: string; ended: boolean };
export type StreamState = Map<number, TextBlock> & { capped?: boolean };

export function resetStream(): StreamState {
  return new Map() as StreamState;
}

function validIndex(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 127
  );
}

export function reconstructStreamEvent(
  state: StreamState,
  event: unknown,
): { state: StreamState; text: string } {
  if (!event || typeof event !== "object")
    return { state, text: streamText(state) };
  const e = event as Record<string, unknown>;
  if (!validIndex(e.contentIndex)) return { state, text: streamText(state) };
  if (e.type !== "text_delta" && e.type !== "text_end")
    return { state, text: streamText(state) };
  const next = new Map(state) as StreamState;
  if (state.capped) next.capped = true;
  if (e.type === "text_delta") {
    if (typeof e.delta !== "string") return { state, text: streamText(state) };
    const block = next.get(e.contentIndex) ?? { text: "", ended: false };
    if (!block.ended)
      next.set(e.contentIndex, { ...block, text: block.text + e.delta });
  } else {
    const content = e.content;
    const authoritative =
      typeof content === "string"
        ? content
        : content &&
            typeof content === "object" &&
            (content as Record<string, unknown>).type === "text" &&
            typeof (content as Record<string, unknown>).text === "string"
          ? ((content as Record<string, unknown>).text as string)
          : undefined;
    if (authoritative === undefined) return { state, text: streamText(state) };
    next.set(e.contentIndex, { text: authoritative, ended: true });
  }
  let remaining = MAX_STREAM_TEXT;
  for (const [index, block] of [...next.entries()].sort(([a], [b]) => a - b)) {
    if (block.text.length > remaining) {
      next.set(index, { ...block, text: block.text.slice(0, remaining) });
      next.capped = true;
      remaining = 0;
    } else remaining -= block.text.length;
  }
  return { state: next, text: streamText(next) };
}

export function streamText(state: StreamState): string {
  let text = "";
  for (const [, block] of [...state.entries()].sort(([a], [b]) => a - b)) {
    if (!block.text) continue;
    const separator = text ? "\n" : "";
    const room = MAX_STREAM_TEXT - text.length;
    if (room <= 0) break;
    text += `${separator}${block.text}`.slice(0, room);
    if (text.length >= MAX_STREAM_TEXT) break;
  }
  if (state.capped && text.length >= TRUNCATION_MARKER.length)
    text = `${text.slice(0, MAX_STREAM_TEXT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  return text;
}
