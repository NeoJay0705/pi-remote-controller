import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/shared/contracts.js";

const defaultProject = "default-project";
const projectId = "non-default-project";
const sessionId = "33333333-3333-4333-8333-333333333333";
const secondSessionId = "44444444-4444-4444-8444-444444444444";
type EventWindow = Window & {
  __emit: (type: string, data: unknown) => void;
  __scrollRafCapture?: {
    callbacks: FrameRequestCallback[];
    restore: () => void;
  };
};

function makeSnapshot(id: string): Snapshot {
  return {
    id,
    nativeId: `native-${id}`,
    projectId,
    profileId: "profile-fixture",
    profileRevision: 0,
    desiredOwner: "web",
    runtimeState: "idle",
    actualProvider: "fixture-provider",
    actualModel: "fixture-model",
    actualThinking: "high",
    queue: [],
    cleared: [],
    pendingDialogs: [],
  };
}

function history(id: string) {
  return Array.from({ length: 60 }, (_, index) => ({
    id: `${id}-entry-${index}`,
    parentId: index ? `${id}-entry-${index - 1}` : null,
    type: "message",
    message: {
      role: index % 2 ? "assistant" : "user",
      content: [
        {
          type: "text",
          text: `${id}-history-${index} ${"content ".repeat(14)}`,
        },
      ],
    },
  }));
}

async function installFixture(page: Page) {
  let authenticated = true;
  let probeMode: "ok" | "unauthorized" | "network" | "server" = "ok";
  let meGate: Promise<void> | undefined;
  let releaseMe: (() => void) | undefined;
  let sessions = [sessionId, secondSessionId].map((id) => ({
    id,
    nativeId: `native-${id}`,
    projectId,
    profileId: "profile-fixture",
    nameInfo: {
      status: "named",
      name: id === sessionId ? "Continuity Primary" : "Continuity Secondary",
    },
  }));
  const operations: unknown[] = [];
  let operationsPosts = 0;
  await page.route("**/api/v1/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/me")) {
      if (meGate) await meGate;
      if (probeMode === "network") return route.abort();
      if (probeMode === "server")
        return route.fulfill({ status: 500, body: "server error" });
      if (!authenticated || probeMode === "unauthorized")
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "unauthorized" } }),
        });
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true }),
      });
    }
    if (path.endsWith("/login")) {
      authenticated = true;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true }),
      });
    }
    if (path.endsWith("/logout")) {
      authenticated = false;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ authenticated: false }),
      });
    }
    return route.continue();
  });
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { id: defaultProject, name: "Default Project" },
        { id: projectId, name: "Continuity Project" },
      ]),
    }),
  );
  await page.route("**/api/v1/profiles", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{ id: "profile-fixture", name: "Fixture" }]),
    }),
  );
  await page.route("**/api/v1/sessions", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(sessions),
        })
      : route.continue(),
  );
  await page.route("**/api/v1/projects/*/native-sessions", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/v1/sessions/*/snapshot", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(makeSnapshot(id)),
    });
  });
  await page.route("**/api/v1/sessions/*/history**", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        entries: history(id),
        incomplete: false,
        truncated: false,
      }),
    });
  });
  await page.route("**/api/v1/sessions/*/operations", async (route) => {
    operationsPosts++;
    const body = route.request().postDataJSON();
    operations.push(body);
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        operationId: `fixture-operation-${operationsPosts}`,
        status: "ACCEPTED",
      }),
    });
  });
  await page.addInitScript(() => {
    class FixtureEventSource {
      static last: FixtureEventSource | undefined;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor() {
        FixtureEventSource.last = this;
        setTimeout(() => {
          if (!this.closed) this.onopen?.(new Event("open"));
        }, 0);
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FixtureEventSource,
    });
    (window as EventWindow).__emit = (type, data) =>
      FixtureEventSource.last?.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ type, data }) }),
      );
  });
  return {
    operations,
    get operationsPosts() {
      return operationsPosts;
    },
    setProbeMode(mode: typeof probeMode) {
      probeMode = mode;
    },
    expire() {
      authenticated = false;
    },
    removeSession() {
      sessions = sessions.filter((item) => item.id !== sessionId);
    },
    gateMe() {
      meGate = new Promise<void>((resolve) => {
        releaseMe = resolve;
      });
      return () => {
        releaseMe?.();
        meGate = undefined;
      };
    },
  };
}

const sessionHeader = (page: Page) => page.locator("header[data-session-id]");

async function openSidebarIfMobile(page: Page) {
  if ((page.viewportSize()?.width ?? 1024) <= 700)
    await page.getByRole("button", { name: "☰", exact: true }).click();
}

async function captureLatestJumpFrames(page: Page) {
  await page.evaluate(() => {
    const state = window as EventWindow;
    const nativeRaf = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const callbacks: FrameRequestCallback[] = [];
    const active = new Map<number, FrameRequestCallback>();
    let nextId = 2_000_000;
    let capturing = false;
    const onClick = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest("button");
      if (button?.textContent?.trim() === "回到最新") capturing = true;
    };
    document.addEventListener("click", onClick, true);
    window.requestAnimationFrame = (callback) => {
      if (!capturing) return nativeRaf(callback);
      const id = nextId++;
      callbacks.push(callback);
      active.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!active.delete(id)) nativeCancel(id);
    };
    state.__scrollRafCapture = {
      callbacks,
      restore() {
        capturing = false;
        document.removeEventListener("click", onClick, true);
        window.requestAnimationFrame = nativeRaf;
        window.cancelAnimationFrame = nativeCancel;
      },
    };
  });
  await page.getByRole("button", { name: "回到最新" }).click();
  const count = await page.evaluate(() => {
    const capture = (window as EventWindow).__scrollRafCapture!;
    capture.restore();
    return capture.callbacks.length;
  });
  expect(count).toBeGreaterThan(0);
  return count;
}

async function replayCapturedFrames(page: Page) {
  await page.evaluate(() => {
    for (const callback of (window as EventWindow).__scrollRafCapture!
      .callbacks)
      callback(performance.now());
  });
}

async function signIn(page: Page) {
  await page.getByLabel("Owner token").fill("isolated-fixture-token");
  await page.getByRole("button", { name: "登入" }).click();
  await expect(sessionHeader(page)).toBeVisible();
}

async function seedView(page: Page, project = projectId, session = sessionId) {
  await page.evaluate(
    ({ project, session }) =>
      sessionStorage.setItem(
        "prw-session-view-v1",
        JSON.stringify({ version: 1, projectId: project, sessionId: session }),
      ),
    { project, session },
  );
}

test("reload restores UI-selected non-default project and primary session without operations", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await page.goto("/");
  await expect(sessionHeader(page)).toBeVisible();
  await openSidebarIfMobile(page);
  const project = page.getByLabel(/Project（目前：/);
  await project.selectOption(projectId);
  await page.getByRole("button", { name: /Continuity Primary/ }).click();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  if ((page.viewportSize()?.width ?? 1024) <= 700)
    await expect(page.getByRole("complementary")).toBeHidden();
  await expect(page.getByText(`${sessionId}-history-59`)).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("prw-session-view-v1")!),
    ),
  ).toEqual({ version: 1, projectId, sessionId });
  const posts = fixture.operationsPosts;
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  await expect(page.getByLabel(/Project（目前：/)).toHaveValue(projectId);
  await expect(page.getByText(`${sessionId}-history-59`)).toBeVisible();
  expect(fixture.operationsPosts).toBe(posts);
});

test("anonymous and expired authentication show login; successful login does not restore after logout", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  fixture.expire();
  await page.goto("/");
  await seedView(page);
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await signIn(page);
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  fixture.expire();
  await page.reload();
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(sessionHeader(page)).toHaveCount(0);
  await signIn(page);
  await openSidebarIfMobile(page);
  const logoutResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/v1/auth/logout"),
  );
  await page.getByRole("button", { name: "登出" }).click();
  await logoutResponse;
  await expect(page.getByLabel("Owner token")).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("prw-session-view-v1")),
  ).toBeNull();
  await signIn(page);
  await expect(sessionHeader(page)).toHaveAttribute("data-session-id", "");
  await expect(page.getByText(/Continuity Primary/)).toHaveCount(0);
});

test("logout failure keeps the local view cleared and shows a server-revocation warning", async ({
  page,
}) => {
  await installFixture(page);
  await page.route("**/api/v1/auth/logout", (route) => route.abort());
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(page.getByLabel("Owner token")).toHaveCount(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem("prw-session-view-v1")),
  ).toBeNull();
  await expect(sessionHeader(page)).toHaveCount(0);
  await expect(page.getByText(`${sessionId}-history-59`)).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "本頁已登出，但無法確認伺服器登入已撤銷；重新整理可能再次登入。",
  );
});

test("me network and server failures are retryable without rendering login while checking", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  fixture.setProbeMode("network");
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("無法確認登入狀態");
  await expect(page.getByLabel("Owner token")).toHaveCount(0);
  fixture.setProbeMode("server");
  const serverResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/auth/me") && response.status() === 500,
  );
  await page.getByRole("button", { name: "重試登入檢查" }).click();
  await serverResponse;
  await expect(page.getByRole("alert")).toContainText("無法確認登入狀態");
  await expect(
    page.getByRole("button", { name: "重試登入檢查" }),
  ).toBeVisible();
  fixture.setProbeMode("ok");
  await page.getByRole("button", { name: "重試登入檢查" }).click();
  await expect(sessionHeader(page)).toBeVisible();
});

test("damaged and inaccessible storage, missing session, and removed project fall back safely", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await page.goto("/");
  await page.evaluate(() =>
    sessionStorage.setItem("prw-session-view-v1", "{broken"),
  );
  await page.reload();
  await expect(sessionHeader(page)).toBeVisible();
  await expect(sessionHeader(page)).not.toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  await page.addInitScript(() => {
    if (location.hash === "#inaccessible-storage")
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
  });
  await page.goto("/#inaccessible-storage");
  await expect(sessionHeader(page)).toBeVisible();
  fixture.removeSession();
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute("data-session-id", "");
  await expect(page.getByLabel(/Project（目前：/)).toHaveValue(projectId);
  await page.evaluate(
    (sessionId) =>
      sessionStorage.setItem(
        "prw-session-view-v1",
        JSON.stringify({ version: 1, projectId: "removed-project", sessionId }),
      ),
    sessionId,
  );
  await page.reload();
  await expect(page.getByLabel(/Project（目前：/)).toHaveValue(defaultProject);
  await expect(sessionHeader(page)).toHaveAttribute("data-session-id", "");
});

test("auth-expired during gated bootstrap cannot restore late successful response", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await page.goto("/");
  await expect(sessionHeader(page)).toBeVisible();
  await seedView(page);
  const release = fixture.gateMe();
  await page.reload();
  await expect(page.getByRole("status")).toContainText("正在確認登入狀態");
  await expect(page.getByLabel("Owner token")).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("prw-auth-expired")),
  );
  const meResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/auth/me") && response.status() === 200,
  );
  release();
  const response = await meResponse;
  await response.finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(sessionHeader(page)).toHaveCount(0);
  await expect(page.getByText(`${sessionId}-history-59`)).toHaveCount(0);
});

test("compact confirmation preserves draft and one back-to-latest tap aligns real viewport", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  const draft = page.getByLabel("訊息草稿");
  await draft.fill("draft-is-not-compact-input");
  const compact = page.getByRole("button", { name: "Compact" });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await compact.click();
  expect(fixture.operations).toHaveLength(0);
  await expect(draft).toHaveValue("draft-is-not-compact-input");
  page.once("dialog", (dialog) => void dialog.accept());
  await compact.click();
  await expect.poll(() => fixture.operationsPosts).toBe(1);
  await expect(draft).toHaveValue("draft-is-not-compact-input");
  const viewport = page.getByRole("region", { name: "對話訊息" });
  const scroller = viewport.locator(":scope > section");
  const latest = page.locator(`[data-entry-id="${sessionId}-entry-59"]`);
  await expect
    .poll(() =>
      scroller.evaluate((node) => node.scrollHeight - node.clientHeight),
    )
    .toBeGreaterThan(100);
  await scroller.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await page.evaluate(() => {
    const state = window as EventWindow & {
      __rafCapture?: {
        callbacks: FrameRequestCallback[];
        restore: () => void;
      };
    };
    const nativeRaf = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const callbacks: FrameRequestCallback[] = [];
    const activeCaptured = new Map<number, FrameRequestCallback>();
    let nextCapturedId = 1_000_000;
    let capturing = false;
    const captureClick = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest("button");
      if (button?.textContent?.trim() === "回到最新") capturing = true;
    };
    document.addEventListener("click", captureClick, true);
    window.requestAnimationFrame = (callback) => {
      if (capturing) {
        const id = nextCapturedId++;
        callbacks.push(callback);
        activeCaptured.set(id, callback);
        return id;
      }
      return nativeRaf(callback);
    };
    window.cancelAnimationFrame = (id) => {
      if (!activeCaptured.delete(id)) nativeCancel(id);
    };
    state.__rafCapture = {
      callbacks,
      restore() {
        capturing = false;
        document.removeEventListener("click", captureClick, true);
        window.requestAnimationFrame = nativeRaf;
        window.cancelAnimationFrame = nativeCancel;
      },
    };
  });
  await page.getByRole("button", { name: "回到最新" }).click();
  const capturedFrames = await page.evaluate(() => {
    const state = window as EventWindow & {
      __rafCapture?: { callbacks: FrameRequestCallback[]; restore: () => void };
    };
    state.__rafCapture!.restore();
    for (const callback of state.__rafCapture!.callbacks)
      callback(performance.now());
    return state.__rafCapture!.callbacks.length;
  });
  expect(capturedFrames).toBeGreaterThan(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect
    .poll(() =>
      scroller.evaluate((node) => ({
        overflow: node.style.getPropertyValue("overflow-y"),
        behavior: node.style.getPropertyValue("scroll-behavior"),
      })),
    )
    .toEqual({ overflow: "", behavior: "" });
  await expect
    .poll(async () =>
      scroller.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect(latest).toContainText(`${sessionId}-history-59`);
  const latestVisibility = await scroller.evaluate((node, entryId) => {
    const entry = node.querySelector<HTMLElement>(
      `[data-entry-id="${entryId}"]`,
    );
    if (!entry) return null;
    const entryRect = entry.getBoundingClientRect();
    const scrollerRect = node.getBoundingClientRect();
    return {
      text: entry.textContent?.trim() ?? "",
      bottomDistance: node.scrollHeight - node.scrollTop - node.clientHeight,
      verticallyIntersects:
        entryRect.bottom > scrollerRect.top &&
        entryRect.top < scrollerRect.bottom,
      horizontallyIntersects:
        entryRect.right > scrollerRect.left &&
        entryRect.left < scrollerRect.right,
    };
  }, `${sessionId}-entry-59`);
  expect(latestVisibility?.text).toContain(`${sessionId}-history-59`);
  expect(latestVisibility?.bottomDistance).toBeLessThanOrEqual(2);
  expect(latestVisibility?.verticallyIntersects).toBe(true);
  expect(latestVisibility?.horizontallyIntersects).toBe(true);
  const beforeHeight = await scroller.evaluate((node) => node.scrollHeight);
  await page.evaluate(() =>
    (window as EventWindow).__emit("rpc", {
      type: "message_start",
      message: { role: "assistant" },
    }),
  );
  await page.evaluate(() =>
    (window as EventWindow).__emit("rpc", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "\nlate-frame-growth ".repeat(600),
      },
    }),
  );
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight))
    .toBeGreaterThan(beforeHeight);
  await expect
    .poll(() =>
      scroller.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  await scroller.evaluate((node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  const anchorTop = await latest.evaluate(
    (node) => node.getBoundingClientRect().top,
  );
  const unpinnedTop = await scroller.evaluate((node) => node.scrollTop);
  const unpinnedHeight = await scroller.evaluate((node) => node.scrollHeight);
  await page.evaluate(() =>
    (window as EventWindow).__emit("rpc", {
      type: "message_start",
      message: { role: "assistant" },
    }),
  );
  await page.evaluate(() =>
    (window as EventWindow).__emit("rpc", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "\nscrolled-growth ".repeat(1400),
      },
    }),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
  expect(await scroller.evaluate((node) => node.scrollHeight)).toBeGreaterThan(
    unpinnedHeight,
  );
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(unpinnedTop);
  expect(
    await latest.evaluate((node) => node.getBoundingClientRect().top),
  ).toBe(anchorTop);

  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: /Continuity Secondary/ }).click();
  await expect(page.getByText(`${secondSessionId}-history-59`)).toBeVisible();
  await expect
    .poll(() =>
      scroller.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  const staleFrameResult = await scroller.evaluate((node) => {
    const state = window as EventWindow & {
      __rafCapture?: { callbacks: FrameRequestCallback[] };
    };
    const callbacks = state.__rafCapture!.callbacks;
    let descriptor: PropertyDescriptor | undefined;
    let prototype: object | null = Object.getPrototypeOf(node);
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!descriptor?.get || !descriptor.set)
      throw new Error("scrollTop native accessor not found");
    let setterCalls = 0;
    Object.defineProperty(node, "scrollTop", {
      configurable: true,
      get() {
        return descriptor!.get!.call(this);
      },
      set(value: number) {
        setterCalls++;
        descriptor!.set!.call(this, value);
      },
    });
    try {
      for (const callback of callbacks) callback(performance.now());
      return { captured: callbacks.length, setterCalls };
    } finally {
      delete (node as HTMLElement & { scrollTop?: number }).scrollTop;
    }
  });
  expect(staleFrameResult.captured).toBeGreaterThan(0);
  expect(staleFrameResult.setterCalls).toBe(0);
  await scroller.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(0);
  await page.evaluate(() => {
    const state = window as EventWindow & {
      __rafCapture?: { callbacks: FrameRequestCallback[] };
    };
    for (const callback of state.__rafCapture!.callbacks)
      callback(performance.now());
  });
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    secondSessionId,
  );
  await expect(page.getByText(`${secondSessionId}-history-59`)).toBeVisible();
});

test("late momentum scroll after latest click keeps the latest position", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  const scroller = page
    .getByRole("region", { name: "對話訊息" })
    .locator(":scope > section");
  const latest = page.locator(`[data-entry-id="${sessionId}-entry-59"]`);
  await expect(latest).toContainText(`${sessionId}-history-59`);
  await expect
    .poll(() =>
      scroller.evaluate((node) => node.scrollHeight - node.clientHeight),
    )
    .toBeGreaterThan(100);
  await scroller.evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  const backToLatest = page.getByRole("button", { name: "回到最新" });
  await expect(backToLatest).toBeVisible();
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  let apiRequestsDuringJump = 0;
  const countApiRequest = (request: { url: () => string }) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      apiRequestsDuringJump++;
  };
  page.on("request", countApiRequest);
  const apiRequestsBeforeJump = apiRequestsDuringJump;

  await page.evaluate(() => {
    const state = window as EventWindow & {
      __lateRafCapture?: {
        callbacks: FrameRequestCallback[];
        restore: () => void;
      };
    };
    const nativeRaf = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const callbacks: FrameRequestCallback[] = [];
    const activeCaptured = new Map<number, FrameRequestCallback>();
    let nextCapturedId = 1_000_000;
    let capturing = false;
    const captureClick = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest("button");
      if (button?.textContent?.trim() === "回到最新") capturing = true;
    };
    document.addEventListener("click", captureClick, true);
    window.requestAnimationFrame = (callback) => {
      if (capturing) {
        const id = nextCapturedId++;
        callbacks.push(callback);
        activeCaptured.set(id, callback);
        return id;
      }
      return nativeRaf(callback);
    };
    window.cancelAnimationFrame = (id) => {
      if (!activeCaptured.delete(id)) nativeCancel(id);
    };
    state.__lateRafCapture = {
      callbacks,
      restore() {
        capturing = false;
        document.removeEventListener("click", captureClick, true);
        window.requestAnimationFrame = nativeRaf;
        window.cancelAnimationFrame = nativeCancel;
      },
    };
  });
  await backToLatest.click();
  const capturedFrames = await page.evaluate(() => {
    const state = window as EventWindow & {
      __lateRafCapture?: {
        callbacks: FrameRequestCallback[];
        restore: () => void;
      };
    };
    state.__lateRafCapture!.restore();
    return state.__lateRafCapture!.callbacks.length;
  });
  expect(capturedFrames).toBeGreaterThan(0);
  const temporaryStyle = await scroller.evaluate((node) => ({
    overflow: node.style.getPropertyValue("overflow-y"),
    overflowPriority: node.style.getPropertyPriority("overflow-y"),
    behavior: node.style.getPropertyValue("scroll-behavior"),
    behaviorPriority: node.style.getPropertyPriority("scroll-behavior"),
  }));
  expect(temporaryStyle).toEqual({
    overflow: "hidden",
    overflowPriority: "important",
    behavior: "auto",
    behaviorPriority: "important",
  });

  const injectedBottomDistance = await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 240;
    const bottomDistance =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    node.dispatchEvent(new Event("scroll"));
    return bottomDistance;
  });
  for (let frame = 0; frame < capturedFrames; frame++) {
    await page.evaluate((index) => {
      const state = window as EventWindow & {
        __lateRafCapture?: { callbacks: FrameRequestCallback[] };
      };
      state.__lateRafCapture!.callbacks[index]!(performance.now());
    }, frame);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      ),
  );
  const result = await scroller.evaluate((node, entryId) => {
    const entry = node.querySelector<HTMLElement>(
      `[data-entry-id="${entryId}"]`,
    );
    const entryRect = entry?.getBoundingClientRect();
    const scrollerRect = node.getBoundingClientRect();
    return {
      bottomDistance: node.scrollHeight - node.scrollTop - node.clientHeight,
      latestText: entry?.textContent?.trim() ?? "",
      latestIntersects:
        !!entryRect &&
        !!scrollerRect &&
        entryRect.bottom > scrollerRect.top &&
        entryRect.top < scrollerRect.bottom &&
        entryRect.right > scrollerRect.left &&
        entryRect.left < scrollerRect.right,
    };
  }, `${sessionId}-entry-59`);
  const backButtonVisible = await backToLatest.isVisible();
  const postsAfter = fixture.operationsPosts;
  page.off("request", countApiRequest);
  console.log("late momentum scroll after latest click result", {
    injectedBottomDistance,
    apiRequestsBeforeJump,
    apiRequestsAfterJump: apiRequestsDuringJump,
    ...result,
    backButtonVisible,
    operationsBefore: 0,
    operationsAfter: postsAfter,
  });

  expect(injectedBottomDistance).toBeGreaterThan(48);
  expect(result.bottomDistance).toBeLessThanOrEqual(2);
  expect(result.latestText).toContain(`${sessionId}-history-59`);
  expect(result.latestIntersects).toBe(true);
  expect(backButtonVisible).toBe(false);
  const restoredStyle = await scroller.evaluate((node) => ({
    overflow: node.style.getPropertyValue("overflow-y"),
    overflowPriority: node.style.getPropertyPriority("overflow-y"),
    behavior: node.style.getPropertyValue("scroll-behavior"),
    behaviorPriority: node.style.getPropertyPriority("scroll-behavior"),
  }));
  expect(restoredStyle).toEqual({
    overflow: "",
    overflowPriority: "",
    behavior: "",
    behaviorPriority: "",
  });
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 240;
    node.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() =>
      scroller.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  expect(postsAfter).toBe(0);
  expect(apiRequestsDuringJump).toBe(apiRequestsBeforeJump);
});

test("new reading inputs interrupt an active latest jump", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  const scroller = page
    .getByRole("region", { name: "對話訊息" })
    .locator(":scope > section");
  const back = page.getByRole("button", { name: "回到最新" });
  const inputs = ["pointerdown", "touchstart", "wheel", "PageUp"] as const;
  for (const input of inputs) {
    await scroller.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect(back).toBeVisible();
    const captured = await captureLatestJumpFrames(page);
    expect(captured).toBeGreaterThan(0);
    await expect
      .poll(() =>
        scroller.evaluate((node) => node.style.getPropertyValue("overflow-y")),
      )
      .toBe("hidden");
    await scroller.evaluate((node, kind) => {
      if (kind === "pointerdown")
        node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      else if (kind === "touchstart")
        node.dispatchEvent(new Event("touchstart", { bubbles: true }));
      else if (kind === "wheel")
        node.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: -1 }),
        );
      else
        node.dispatchEvent(
          new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
        );
      node.scrollTop = node.scrollHeight - node.clientHeight - 240;
      node.dispatchEvent(new Event("scroll"));
    }, input);
    await replayCapturedFrames(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
    );
    await expect
      .poll(() =>
        scroller.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeGreaterThan(48);
    await expect(back).toBeVisible();
    await expect
      .poll(() =>
        scroller.evaluate((node) => ({
          overflow: node.style.getPropertyValue("overflow-y"),
          overflowPriority: node.style.getPropertyPriority("overflow-y"),
          behavior: node.style.getPropertyValue("scroll-behavior"),
          behaviorPriority: node.style.getPropertyPriority("scroll-behavior"),
        })),
      )
      .toEqual({
        overflow: "",
        overflowPriority: "",
        behavior: "",
        behaviorPriority: "",
      });
  }
});

test("session switch cleans an active latest jump before stale frames replay", async ({
  page,
}) => {
  await installFixture(page);
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  const oldScroller = page
    .getByRole("region", { name: "對話訊息" })
    .locator(":scope > section");
  await oldScroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  const oldElement = await oldScroller.elementHandle();
  expect(oldElement).not.toBeNull();
  await captureLatestJumpFrames(page);
  await expect(oldScroller).toHaveCSS("overflow-y", "hidden");
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: /Continuity Secondary/ }).click();
  await expect(page.getByText(`${secondSessionId}-history-59`)).toBeVisible();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    secondSessionId,
  );
  const oldStyle = await oldElement!.evaluate((node: HTMLElement) => ({
    overflow: node.style.getPropertyValue("overflow-y"),
    overflowPriority: node.style.getPropertyPriority("overflow-y"),
    behavior: node.style.getPropertyValue("scroll-behavior"),
    behaviorPriority: node.style.getPropertyPriority("scroll-behavior"),
  }));
  expect(oldStyle).toEqual({
    overflow: "",
    overflowPriority: "",
    behavior: "",
    behaviorPriority: "",
  });
  await replayCapturedFrames(page);
  await expect(page.getByText(`${secondSessionId}-history-59`)).toBeVisible();
  expect(
    await oldElement!.evaluate((node: HTMLElement) =>
      node.style.getPropertyValue("overflow-y"),
    ),
  ).toBe("");
});

test("auth expiration cleans an active latest jump before stale frames replay", async ({
  page,
}) => {
  await installFixture(page);
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  const scroller = page
    .getByRole("region", { name: "對話訊息" })
    .locator(":scope > section");
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  const oldElement = await scroller.elementHandle();
  expect(oldElement).not.toBeNull();
  await captureLatestJumpFrames(page);
  await expect(scroller).toHaveCSS("overflow-y", "hidden");
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("prw-auth-expired")),
  );
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(page.getByText(`${sessionId}-history-59`)).toHaveCount(0);
  expect(
    await oldElement!.evaluate((node: HTMLElement) => ({
      overflow: node.style.getPropertyValue("overflow-y"),
      overflowPriority: node.style.getPropertyPriority("overflow-y"),
      behavior: node.style.getPropertyValue("scroll-behavior"),
      behaviorPriority: node.style.getPropertyPriority("scroll-behavior"),
    })),
  ).toEqual({
    overflow: "",
    overflowPriority: "",
    behavior: "",
    behaviorPriority: "",
  });
  await replayCapturedFrames(page);
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(page.getByText(`${sessionId}-history-59`)).toHaveCount(0);
});

test("logout cleans an active latest jump before stale frames replay", async ({
  page,
}) => {
  await installFixture(page);
  await page.goto("/");
  await seedView(page);
  await page.reload();
  await expect(sessionHeader(page)).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
  const scroller = page
    .getByRole("region", { name: "對話訊息" })
    .locator(":scope > section");
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll"));
  });
  const oldElement = await scroller.elementHandle();
  expect(oldElement).not.toBeNull();
  await captureLatestJumpFrames(page);
  await expect(scroller).toHaveCSS("overflow-y", "hidden");
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(page.getByText(`${sessionId}-history-59`)).toHaveCount(0);
  expect(
    await oldElement!.evaluate((node: HTMLElement) => ({
      overflow: node.style.getPropertyValue("overflow-y"),
      overflowPriority: node.style.getPropertyPriority("overflow-y"),
      behavior: node.style.getPropertyValue("scroll-behavior"),
      behaviorPriority: node.style.getPropertyPriority("scroll-behavior"),
    })),
  ).toEqual({
    overflow: "",
    overflowPriority: "",
    behavior: "",
    behaviorPriority: "",
  });
  await replayCapturedFrames(page);
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(page.getByText(`${sessionId}-history-59`)).toHaveCount(0);
});
