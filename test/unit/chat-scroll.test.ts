import { describe, expect, it, vi } from "vitest";
import { createChatScrollController } from "../../src/web/chat-scroll.js";

function harness(requestFails = false, cancelFails = false) {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const first = element();
  let current: HTMLElement | null = first;
  let generation = 1;
  let pinned = false;
  let failRequest = requestFails;
  const setPinned = vi.fn((value: boolean) => {
    pinned = value;
  });
  const controller = createChatScrollController({
    getContainer: () => current,
    getGeneration: () => generation,
    getPinned: () => pinned,
    setPinned,
    requestFrame: (callback) => {
      if (failRequest) throw new Error("raf failed");
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      if (cancelFails) throw new Error("cancel failed");
      callbacks.delete(id);
    },
  });
  const flush = () => {
    const item = callbacks.entries().next().value as
      [number, FrameRequestCallback] | undefined;
    if (!item) throw new Error("No scheduled frame");
    callbacks.delete(item[0]);
    item[1](0);
  };
  return {
    controller,
    callbacks,
    first,
    setCurrent: (value: HTMLElement | null) => {
      current = value;
    },
    setGeneration: (value: number) => {
      generation = value;
    },
    setPinned: (value: boolean) => {
      pinned = value;
    },
    setRequestFailure: (value: boolean) => {
      failRequest = value;
    },
    flush,
    setPinnedMock: setPinned,
  };
}
function element() {
  const values = new Map<string, { value: string; priority: string }>();
  const style = {
    getPropertyValue: (name: string) => values.get(name)?.value ?? "",
    getPropertyPriority: (name: string) => values.get(name)?.priority ?? "",
    setProperty: (name: string, value: string, priority = "") => {
      values.set(name, { value, priority });
    },
    removeProperty: (name: string) => {
      values.delete(name);
    },
  };
  let top = 0;
  let height = 1000;
  let viewport = 200;
  let writes = 0;
  const node = {
    style,
    get scrollHeight() {
      return height;
    },
    set scrollHeight(value: number) {
      height = value;
    },
    get clientHeight() {
      return viewport;
    },
    set clientHeight(value: number) {
      viewport = value;
    },
    get maxTop() {
      return Math.max(0, height - viewport);
    },
    get writes() {
      return writes;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      writes++;
      top = Math.min(Math.max(0, value), Math.max(0, height - viewport));
    },
  };
  return node as unknown as HTMLElement & { writes: number; maxTop: number };
}

describe("chat scroll controller", () => {
  it("stops an ordinary late frame after pinned becomes false", () => {
    const h = harness();
    h.setPinned(true);
    h.controller.alignLatest();
    const writesBeforeFrame = (h.first as ReturnType<typeof element>).writes;
    h.setPinned(false);
    h.flush();
    expect((h.first as ReturnType<typeof element>).writes).toBe(
      writesBeforeFrame,
    );
    expect(h.callbacks.size).toBe(0);
  });

  it("keeps B's styles and two-frame queue when cancelled A's callback arrives late", () => {
    const h = harness(false, true);
    h.controller.jumpToLatest();
    const [staleAId, staleA] = [...h.callbacks.entries()][0]!;
    h.controller.cancel();
    h.controller.jumpToLatest();
    const writesWithB = (h.first as ReturnType<typeof element>).writes;
    staleA(0);
    h.callbacks.delete(staleAId);
    expect((h.first as ReturnType<typeof element>).writes).toBe(writesWithB);
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(h.callbacks.size).toBe(1);
    h.flush();
    expect(h.callbacks.size).toBe(1);
    h.flush();
    expect(h.callbacks.size).toBe(0);
  });

  it("holds explicit intent for late scrolls while active and after completion", () => {
    const h = harness();
    h.first.style.setProperty("overflow-y", "scroll", "important");
    h.first.style.setProperty("scroll-behavior", "smooth", "");
    h.controller.jumpToLatest();
    const node = h.first as ReturnType<typeof element>;
    node.scrollTop = node.maxTop - 240;
    h.controller.onScroll(h.first);
    expect(h.first.scrollTop).toBe(node.maxTop);
    h.controller.alignLatest();
    expect(h.callbacks.size).toBe(1);
    h.flush();
    h.controller.alignLatest();
    expect(h.callbacks.size).toBe(1);
    h.flush();
    expect(h.callbacks.size).toBe(0);
    node.scrollTop = node.maxTop - 240;
    h.controller.onScroll(h.first);
    expect(h.first.scrollTop).toBe(node.maxTop);
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(true);
    node.scrollTop = node.maxTop - 240;
    h.controller.interrupt();
    h.controller.onScroll(h.first);
    expect(h.first.scrollTop).toBe(node.maxTop - 240);
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);
  });

  it("restores both original style values and priorities", () => {
    const h = harness();
    h.first.style.setProperty("overflow-y", "auto", "important");
    h.first.style.setProperty("scroll-behavior", "smooth", "important");
    h.controller.jumpToLatest();
    expect(h.first.style.getPropertyPriority("overflow-y")).toBe("important");
    expect(h.first.style.getPropertyPriority("scroll-behavior")).toBe(
      "important",
    );
    h.controller.interrupt();
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("auto");
    expect(h.first.style.getPropertyPriority("overflow-y")).toBe("important");
    expect(h.first.style.getPropertyValue("scroll-behavior")).toBe("smooth");
    expect(h.first.style.getPropertyPriority("scroll-behavior")).toBe(
      "important",
    );
  });

  it("cleans the old element on a current callback after generation or container changes", () => {
    const h = harness();
    h.first.style.setProperty("overflow-y", "auto", "important");
    h.controller.jumpToLatest();
    const stale = [...h.callbacks.values()][0]!;
    const replacement = element();
    h.setCurrent(replacement);
    h.setGeneration(2);
    h.callbacks.clear(); // The callback has already left the browser queue.
    const replacementWrites = (replacement as ReturnType<typeof element>)
      .writes;
    stale(0);
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("auto");
    expect(h.first.style.getPropertyPriority("overflow-y")).toBe("important");
    expect(replacement.style.getPropertyValue("overflow-y")).toBe("");
    expect((replacement as ReturnType<typeof element>).writes).toBe(
      replacementWrites,
    );
    expect(h.callbacks.size).toBe(0);
  });

  it("does not let a stale callback cancel a replacement element's work", () => {
    const h = harness();
    h.controller.jumpToLatest();
    const oldCallback = [...h.callbacks.values()][0]!;
    const newer = element();
    h.setCurrent(newer);
    h.setGeneration(2);
    h.controller.jumpToLatest();
    const newCallback = [...h.callbacks.values()][0]!;
    oldCallback(0);
    expect(newer.style.getPropertyValue("overflow-y")).toBe("hidden");
    expect(h.callbacks.size).toBe(1);
    h.callbacks.delete([...h.callbacks.keys()][0]!);
    newCallback(0);
    expect(newer.style.getPropertyValue("overflow-y")).toBe("");
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("");
  });

  it("restores and reports actual position when writes, DOM, or rAF fail", () => {
    const h = harness();
    Object.defineProperty(h.first, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => {},
    });
    h.controller.jumpToLatest();
    h.flush();
    h.flush();
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("");
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);

    const broken = element();
    Object.defineProperty(broken.style, "setProperty", {
      value: () => {
        throw new Error("style failed");
      },
    });
    h.setCurrent(broken);
    h.controller.jumpToLatest();
    expect(h.callbacks.size).toBe(0);
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);

    h.setCurrent(h.first);
    h.setRequestFailure(true);
    h.controller.jumpToLatest();
    expect(h.callbacks.size).toBe(0);
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("");
  });

  it("restores both properties when the second temporary style write throws once", () => {
    const h = harness();
    h.first.style.setProperty("overflow-y", "scroll", "important");
    h.first.style.setProperty("scroll-behavior", "smooth", "");
    const setProperty = h.first.style.setProperty.bind(h.first.style);
    let throwOnce = true;
    Object.defineProperty(h.first.style, "setProperty", {
      configurable: true,
      value: (name: string, value: string, priority?: string) => {
        if (name === "scroll-behavior" && throwOnce) {
          throwOnce = false;
          throw new Error("one-time style failure");
        }
        setProperty(name, value, priority);
      },
    });
    h.controller.jumpToLatest();
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("scroll");
    expect(h.first.style.getPropertyPriority("overflow-y")).toBe("important");
    expect(h.first.style.getPropertyValue("scroll-behavior")).toBe("smooth");
    expect(h.first.style.getPropertyPriority("scroll-behavior")).toBe("");
    expect(h.callbacks.size).toBe(0);
  });

  it("releases intent and reports the actual position when completed alignment is rejected", () => {
    const h = harness();
    const node = h.first as ReturnType<typeof element>;
    node.scrollTop = node.maxTop - 240;
    Object.defineProperty(h.first, "scrollTop", {
      configurable: true,
      get: () => node.maxTop - 240,
      set: () => {},
    });
    h.controller.jumpToLatest();
    h.flush();
    h.flush();
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("");
    expect(h.first.style.getPropertyValue("scroll-behavior")).toBe("");
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);
    h.first.style.setProperty("overflow-y", "auto");
    h.controller.onScroll(h.first);
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("auto");
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);
    expect(h.callbacks.size).toBe(0);
  });

  it("releases completed intent when a later old scroll cannot be realigned", () => {
    const h = harness();
    const node = h.first as ReturnType<typeof element>;
    const descriptor = Object.getOwnPropertyDescriptor(h.first, "scrollTop")!;
    let rejectWrites = false;
    Object.defineProperty(h.first, "scrollTop", {
      configurable: true,
      get: () => descriptor.get!.call(h.first),
      set: (value: number) => {
        if (!rejectWrites) descriptor.set!.call(h.first, value);
      },
    });
    h.controller.jumpToLatest();
    h.flush();
    h.flush();
    expect(node.maxTop - h.first.scrollTop).toBe(0);
    rejectWrites = false;
    h.first.scrollTop = node.maxTop - 240;
    rejectWrites = true;
    h.controller.onScroll(h.first);
    expect(node.maxTop - h.first.scrollTop).toBe(240);
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);
    rejectWrites = false;
    h.controller.onScroll(h.first);
    expect(node.maxTop - h.first.scrollTop).toBe(240);
    expect(h.setPinnedMock).toHaveBeenLastCalledWith(false);
    expect(h.callbacks.size).toBe(0);
  });

  it("cancels safely, including repeated cancellation and an already dequeued callback", () => {
    const h = harness();
    h.controller.jumpToLatest();
    const queued = [...h.callbacks.values()][0]!;
    h.callbacks.clear();
    h.controller.cancel();
    h.controller.cancel();
    const before = (h.first as ReturnType<typeof element>).writes;
    queued(0);
    expect((h.first as ReturnType<typeof element>).writes).toBe(before);
    expect(h.callbacks.size).toBe(0);
    expect(h.first.style.getPropertyValue("overflow-y")).toBe("");
  });
});
