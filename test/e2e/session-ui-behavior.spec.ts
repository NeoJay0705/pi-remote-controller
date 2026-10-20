import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/shared/contracts.js";
import { expectCurrentAppId } from "./ui-helpers.js";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;
type State = Snapshot["runtimeState"];
type EventWindow = Window & { __emit: (type: string, data: unknown) => void };

function fixtureSnapshot(id: string, runtimeState: State): Snapshot {
  return {
    id,
    nativeId: `fake-${id.slice(0, 4)}`,
    projectId: "demo",
    profileId: "fake",
    profileRevision: 0,
    desiredOwner: "web",
    runtimeState,
    actualProvider: "fixture",
    actualModel: "fixture-model",
    actualThinking: "high",
    queue: [],
    cleared: [],
    pendingDialogs: [],
  };
}

const allEntries = Array.from({ length: 80 }, (_, index) => ({
  id: `entry-${index}`,
  parentId: index ? `entry-${index - 1}` : null,
  type: "message",
  message: {
    role: index % 2 ? "assistant" : "user",
    content: [
      {
        type: "text",
        text: `Entry ${index}\nline two ${"content ".repeat(12)}`,
      },
    ],
  },
}));

async function installTransport(page: Page) {
  let state: State = "released";
  let historyPage = allEntries.slice(20);
  const operationBodies: Array<{ kind: string; text?: string }> = [];
  let operationGate: Promise<void> | undefined;
  let releaseOperation: (() => void) | undefined;
  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        ids.map((id) => ({
          id,
          nativeId: `fake-${id.slice(0, 4)}`,
          projectId: "demo",
          profileId: "fake",
        })),
      ),
    });
  });
  for (const id of ids) {
    await page.route(`**/api/v1/sessions/${id}/snapshot`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(fixtureSnapshot(id, state)),
      }),
    );
    await page.route(`**/api/v1/sessions/${id}/history**`, (route) => {
      const before = new URL(route.request().url()).searchParams.get("before");
      const entries =
        before === "entry-20" ? allEntries.slice(0, 20) : historyPage;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          entries,
          continuation: entries[0]?.id === "entry-20" ? "entry-20" : undefined,
          incomplete: false,
          truncated: false,
        }),
      });
    });
    await page.route(`**/api/v1/sessions/${id}/operations`, async (route) => {
      const body = route.request().postDataJSON() as {
        kind: string;
        text?: string;
      };
      operationBodies.push(body);
      if (operationGate) await operationGate;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          operationId: "fixture-op",
          sessionId: id,
          kind: body.kind,
          status: "ACCEPTED",
        }),
      });
    });
  }
  await page.addInitScript(() => {
    class ControlledEventSource {
      static latest: ControlledEventSource | undefined;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor() {
        ControlledEventSource.latest = this;
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
      value: ControlledEventSource,
    });
    (window as EventWindow).__emit = (type, data) => {
      const instance = ControlledEventSource.latest;
      if (!instance || instance.closed)
        throw new Error("No active EventSource");
      instance.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify({ type, data }) }),
      );
    };
  });
  return {
    operationBodies,
    setState(value: State) {
      state = value;
    },
    setHistory(value: typeof allEntries) {
      historyPage = value;
    },
    gateOperation() {
      operationGate = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      return () => {
        releaseOperation?.();
        operationGate = undefined;
      };
    },
  };
}

async function loginAndSelect(page: Page, id: string = ids[0]) {
  await page.goto("/");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  const sidebar = page.getByRole("complementary");
  if ((page.viewportSize()?.width ?? 1024) <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await expect(page.getByText("受管 Sessions")).toBeVisible();
  const nativeId = fixtureSnapshot(id, "released").nativeId;
  await page
    .locator("nav button")
    .filter({ hasText: `Pi session ID：${nativeId}` })
    .click();
  await expectCurrentAppId(page, id);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1024) <= 700)
    await expect(sidebar).toBeHidden();
}

test("message operation browser matrix, connectivity and chat scroll behavior", async ({
  page,
}) => {
  const fixture = await installTransport(page);
  await loginAndSelect(page);
  const chat = page.getByRole("region", { name: "對話訊息" });
  const scroller = chat.locator("section").first();
  await expect
    .poll(
      async () =>
        await scroller.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
    )
    .toBeLessThanOrEqual(2);
  const draft = page.getByLabel("訊息草稿");
  const buttons = {
    prompt: page.getByRole("button", { name: "Prompt", exact: true }),
    steer: page.getByRole("button", { name: "Steering", exact: true }),
    follow_up: page.getByRole("button", { name: "Follow-up", exact: true }),
  };
  const expected: Record<State, string[]> = {
    released: ["prompt"],
    idle: ["prompt"],
    running: ["steer", "follow_up"],
    starting: [],
    blocked: [],
    stopping: [],
    releasing: [],
    reconfiguring: [],
  };
  for (const state of [
    "released",
    "idle",
    "running",
    "starting",
    "blocked",
    "stopping",
    "releasing",
    "reconfiguring",
  ] as const) {
    const blockedTextarea = state === "blocked" || state === "stopping";
    if (state === "blocked") await draft.fill("prepared blocked draft");
    fixture.setState(state);
    await page.evaluate(
      ({ snapshot }) => (window as EventWindow).__emit("snapshot", snapshot),
      { snapshot: fixtureSnapshot(ids[0], state) },
    );
    if (!blockedTextarea) await draft.fill(`matrix draft ${state}`);
    const before = fixture.operationBodies.length;
    for (const kind of ["prompt", "steer", "follow_up"] as const) {
      const enabled = expected[state].includes(kind);
      if (enabled) await expect(buttons[kind]).toBeEnabled();
      else {
        await expect(buttons[kind]).toBeDisabled();
        await buttons[kind].evaluate((el: HTMLButtonElement) => el.click());
      }
    }
    await draft.focus();
    await page.keyboard.press("Control+Enter");
    if (expected[state].includes("prompt")) {
      await expect.poll(() => fixture.operationBodies.length).toBe(before + 1);
      await expect.poll(() => buttons.prompt.isDisabled()).toBe(true);
      await draft.fill(`matrix next ${state}`);
      await expect(buttons.prompt).toBeEnabled();
      await expect.poll(() => buttons.prompt.isDisabled()).toBe(false);
    } else {
      expect(fixture.operationBodies.length).toBe(before);
    }
    expect(fixture.operationBodies.slice(before).map((op) => op.kind)).toEqual(
      expected[state].includes("prompt") ? ["prompt"] : [],
    );
  }
  await draft.fill("  \n ");
  for (const button of Object.values(buttons))
    await expect(button).toBeDisabled();
  await draft.fill("offline draft");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  for (const button of Object.values(buttons))
    await expect(button).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  fixture.setState("running");
  await page.evaluate(
    (snapshot) => (window as EventWindow).__emit("snapshot", snapshot),
    fixtureSnapshot(ids[0], "running"),
  );
  await draft.fill("busy draft");
  const beforeBusy = fixture.operationBodies.length;
  const release = fixture.gateOperation();
  await buttons.steer.click();
  await expect(buttons.prompt).toBeDisabled();
  await expect(buttons.steer).toBeDisabled();
  await expect(buttons.follow_up).toBeDisabled();
  release();
  await expect.poll(() => fixture.operationBodies.length).toBe(beforeBusy + 1);
  await draft.fill("steer after accepted");
  await expect(buttons.steer).toBeEnabled();
  const beforeIme = fixture.operationBodies.length;
  await draft.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await expect.poll(() => fixture.operationBodies.length).toBe(beforeIme);
  expect(fixture.operationBodies.at(-1)?.kind).toBe("steer");
  await draft.fill("follow-up after accepted");
  await expect(buttons.follow_up).toBeEnabled();
  await buttons.follow_up.click();
  await expect
    .poll(() => fixture.operationBodies.at(-1)?.kind)
    .toBe("follow_up");
  fixture.setState("idle");
  await page.evaluate(
    (snapshot) => (window as EventWindow).__emit("snapshot", snapshot),
    fixtureSnapshot(ids[0], "idle"),
  );
  await draft.fill("idle prompt");
  await buttons.prompt.click();
  await expect.poll(() => fixture.operationBodies.at(-1)?.kind).toBe("prompt");

  await scroller.evaluate((el) => {
    el.scrollTop = Math.floor(el.scrollHeight / 2);
    el.dispatchEvent(new Event("scroll"));
  });
  const anchorId = await scroller.evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    return [...container.querySelectorAll<HTMLElement>("[data-entry-id]")]
      .find((entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      })
      ?.getAttribute("data-entry-id");
  });
  expect(anchorId).toBeTruthy();
  const anchor = scroller.locator(`[data-entry-id="${anchorId}"]`);
  const beforeTop = await anchor.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
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
        delta: "partial\nline\n".repeat(30),
      },
    }),
  );
  fixture.setHistory([
    ...allEntries.slice(20),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `entry-${80 + index}`,
      parentId: `entry-${79 + index}`,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Entry ${80 + index}` }],
      },
    })),
  ]);
  await page.evaluate(() =>
    (window as EventWindow).__emit("rpc", { type: "message_end" }),
  );
  await expect(scroller.locator('[data-entry-id="entry-84"]')).toBeVisible();
  await expect
    .poll(() =>
      anchor
        .evaluate((el) => el.getBoundingClientRect().top)
        .then((top) => Math.abs(top - beforeTop)),
    )
    .toBeLessThanOrEqual(2);
  const back = page.getByRole("button", { name: "回到最新" });
  await expect(back).toBeVisible();
  await back.evaluate((el: HTMLButtonElement) => el.click());
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  const heightBeforeGrowth = await scroller.evaluate((el) => el.scrollHeight);
  await page.evaluate(() => {
    (window as EventWindow).__emit("rpc", {
      type: "message_start",
      message: { role: "assistant" },
    });
    (window as EventWindow).__emit("rpc", {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "pinned growth ".repeat(600),
      },
    });
  });
  await expect(scroller.getByText(/pinned growth/)).toBeVisible();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight))
    .toBeGreaterThan(heightBeforeGrowth);
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  const originalViewport = page.viewportSize()!;
  const pinnedClientHeight = await scroller.evaluate((el) => el.clientHeight);
  await page.setViewportSize({
    width: originalViewport.width,
    height: originalViewport.height - 100,
  });
  await expect
    .poll(() => scroller.evaluate((el) => el.clientHeight))
    .toBeLessThan(pinnedClientHeight);
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  await page.setViewportSize(originalViewport);
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const selectedAnchorId = await scroller.evaluate((container) => {
    const bounds = container.getBoundingClientRect();
    return [...container.querySelectorAll<HTMLElement>("[data-entry-id]")]
      .find((entry) => {
        const rect = entry.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      })
      ?.getAttribute("data-entry-id");
  });
  expect(selectedAnchorId).toBeTruthy();
  const selectedAnchor = scroller.locator(
    `[data-entry-id="${selectedAnchorId}"]`,
  );
  const oldTop = await selectedAnchor.evaluate(
    (el) => el.getBoundingClientRect().top,
  );
  await chat
    .getByRole("button", { name: "載入較舊歷史" })
    .evaluate((el: HTMLButtonElement) => el.click());
  await expect(scroller.locator('[data-entry-id="entry-0"]')).toBeAttached();
  await expect
    .poll(() =>
      selectedAnchor.evaluate(
        (el, top) => Math.abs(el.getBoundingClientRect().top - top),
        oldTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  const readingClientHeight = await scroller.evaluate((el) => el.clientHeight);
  const readingScrollTop = await scroller.evaluate((el) => el.scrollTop);
  await page.setViewportSize({
    width: originalViewport.width,
    height: originalViewport.height - 100,
  });
  await expect
    .poll(() => scroller.evaluate((el) => el.clientHeight))
    .toBeLessThan(readingClientHeight);
  await expect
    .poll(() =>
      scroller.evaluate(
        (el, top) => Math.abs(el.scrollTop - top),
        readingScrollTop,
      ),
    )
    .toBeLessThanOrEqual(2);
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeGreaterThan(2);
  await page.setViewportSize(originalViewport);
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeGreaterThan(2);
  fixture.setState("idle");
  await page.evaluate(
    (snapshot) => (window as EventWindow).__emit("snapshot", snapshot),
    fixtureSnapshot(ids[0], "idle"),
  );
  await draft.fill("send while reading older history");
  const beforePrompt = fixture.operationBodies.length;
  const releasePrompt = fixture.gateOperation();
  await buttons.prompt.click();
  await expect
    .poll(() => fixture.operationBodies.length)
    .toBe(beforePrompt + 1);
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
  releasePrompt();
  await draft.fill("prompt after accepted");
  await expect(buttons.prompt).toBeEnabled();
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);

  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeGreaterThan(48);
  const snapshotRequests = { count: 0 };
  const historyRequests = { count: 0 };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/api/v1/sessions/${ids[0]}/snapshot`)
      snapshotRequests.count++;
    if (url.pathname === `/api/v1/sessions/${ids[0]}/history`)
      historyRequests.count++;
  });
  const beforeReopen = {
    snapshot: snapshotRequests.count,
    history: historyRequests.count,
  };
  if ((page.viewportSize()?.width ?? 1024) <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await page
    .locator("nav button")
    .filter({
      hasText: `Pi session ID：${fixtureSnapshot(ids[0], "released").nativeId}`,
    })
    .click();
  await expect
    .poll(() => snapshotRequests.count)
    .toBeGreaterThan(beforeReopen.snapshot);
  await expect
    .poll(() => historyRequests.count)
    .toBeGreaterThan(beforeReopen.history);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(2);
});

test("history truncation stays entry-scoped and latest-page reload uses the maximum preview", async ({
  page,
}) => {
  const fixture = await installTransport(page);
  fixture.setHistory([
    {
      id: "short-entry",
      parentId: null,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "short message" }],
      },
    },
    {
      id: "truncated-entry",
      parentId: "short-entry",
      type: "message",
      truncated: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "bounded preview" }],
      },
    },
  ]);
  await loginAndSelect(page);
  const chat = page.getByRole("region", { name: "對話訊息" });
  await expect(chat.getByText("short message")).toBeVisible();
  await expect(chat.getByText("bounded preview")).toBeVisible();
  const previewNotice = "此歷史項目為有界預覽，部分資料未載入。";
  await expect(chat.getByText(previewNotice)).toHaveCount(1);
  const shortEntry = chat.locator('[data-entry-id="short-entry"]');
  await expect(shortEntry.getByText(previewNotice)).toHaveCount(0);
  const reloadLatest = chat.getByRole("button", {
    name: "重新載入最新頁（預覽有上限）",
  });
  await expect(reloadLatest).toBeVisible();
  const limitation =
    "預覽仍有上限；此操作只重新載入最新頁，不保證展開較舊項目。較舊項目請載入歷史。";
  await expect(reloadLatest).toHaveAttribute("aria-description", limitation);
  await expect(reloadLatest).toHaveAttribute("title", limitation);
  const historyRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === `/api/v1/sessions/${ids[0]}/history` &&
      url.searchParams.has("previewBytes")
    );
  });
  await reloadLatest.click();
  const request = await historyRequest;
  expect(new URL(request.url()).searchParams.get("previewBytes")).toBe("65536");
});

test("mobile sidebar resize and session information reset", async ({
  page,
}) => {
  await installTransport(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAndSelect(page);
  const informationToggle = page.getByRole("button", {
    name: "Session 設定與資訊",
  });
  await informationToggle.click();
  await expect(informationToggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "☰" }).click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(page.getByRole("main")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("complementary")).toBeVisible();
  await page
    .locator("nav button")
    .filter({
      hasText: `Pi session ID：${fixtureSnapshot(ids[1], "released").nativeId}`,
    })
    .click();
  await expectCurrentAppId(page, ids[1]);
  await expect(informationToggle).toHaveAttribute("aria-expanded", "false");
});
