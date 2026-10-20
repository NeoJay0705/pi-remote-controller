import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/shared/contracts.js";

const ids = {
  newest: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  older: "00000000-0000-4000-8000-000000000001",
  other: "00000000-0000-4000-8000-000000000002",
};
const longName = "非常長的中文工作階段名稱".repeat(12);
const longNativeId = "原生識別碼很長".repeat(16);
type State = Snapshot["runtimeState"];
type EventWindow = Window & { __emit: (type: string, data: unknown) => void };

function snapshot(
  id: string,
  runtimeState: State,
  queue: unknown[] = [],
): Snapshot {
  return {
    id,
    nativeId: id === ids.newest ? longNativeId : `native-${id}`,
    projectId: id === ids.other ? "second" : "demo",
    profileId: "fixture-profile",
    profileRevision: 0,
    nameInfo: { status: "named", name: longName },
    desiredOwner: "web",
    runtimeState,
    actualProvider: "fixture-provider",
    actualModel: "fixture-model",
    actualThinking: "high",
    cwd: "/fixture/" + "very-long-path/".repeat(30),
    sessionDir: "/fixture/session/" + "directory/".repeat(30),
    nativeCommand: "fixture-command " + "argument ".repeat(30),
    queue: queue as Snapshot["queue"],
    cleared: [],
    pendingDialogs: [],
  };
}

const sessionRows = [
  {
    id: ids.older,
    nativeId: `native-${ids.older}`,
    projectId: "demo",
    profileId: "fixture-profile",
    profileRevision: 0,
    nameInfo: { status: "named", name: "較舊名稱" },
    fileUpdatedAt: 1000,
  },
  {
    id: ids.newest,
    nativeId: longNativeId,
    projectId: "demo",
    profileId: "fixture-profile",
    profileRevision: 0,
    nameInfo: { status: "named", name: longName },
    fileUpdatedAt: 3000,
  },
  {
    id: ids.other,
    nativeId: `native-${ids.other}`,
    projectId: "second",
    profileId: "fixture-profile",
    profileRevision: 0,
    nameInfo: { status: "named", name: "另一個 Project" },
    fileUpdatedAt: 2000,
  },
];

async function installFixture(page: Page) {
  let sessions = [...sessionRows];
  const nativeCandidates = [
    { file: "/fixture/old.jsonl", id: "candidate-old", fileUpdatedAt: 1000 },
    { file: "/fixture/new.jsonl", id: "candidate-new", fileUpdatedAt: 3000 },
    { file: "/fixture/tie-b.jsonl", id: "tie-b", fileUpdatedAt: 2000 },
    { file: "/fixture/tie-a.jsonl", id: "tie-a", fileUpdatedAt: 2000 },
    { file: "/fixture/unknown.jsonl", id: "candidate-unknown" },
    {
      file: "/fixture/unsafe.jsonl",
      id: "unsafe",
      error: "unsafe path",
      fileUpdatedAt: 4000,
    },
  ];
  const states = new Map<string, State>([
    [ids.newest, "released"],
    [ids.older, "released"],
    [ids.other, "released"],
  ]);
  const queues = new Map<string, unknown[]>();
  const addedFiles = new Set<string>();
  const operationPosts: Array<{ id: string; body: Record<string, unknown> }> =
    [];
  let abortPrompt = false;
  let receiptGets = 0;
  await page.route("**/api/v1/auth/**", (route) =>
    route.fulfill({
      status: route.request().url().endsWith("/me") ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    }),
  );
  await page.route("**/api/v1/projects", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { id: "demo", name: "Demo" },
        { id: "second", name: "Second" },
      ]),
    }),
  );
  await page.route("**/api/v1/profiles", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{ id: "fixture-profile", name: "Fixture" }]),
    }),
  );
  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(sessions),
      });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { nativeFile?: string };
      if (body.nativeFile) addedFiles.add(body.nativeFile);
      const candidate = nativeCandidates.find(
        (item) => item.file === body.nativeFile,
      );
      const session = {
        ...sessionRows[0]!,
        id: "11111111-1111-4111-8111-111111111111",
        nativeId: candidate?.id ?? "",
        projectId: "demo",
        fileUpdatedAt: candidate?.fileUpdatedAt,
        nameInfo: { status: "named", name: "建立完成" },
      };
      sessions = [...sessions.filter((row) => row.id !== session.id), session];
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(session),
      });
    }
    return route.continue();
  });
  await page.route("**/api/v1/projects/*/native-sessions", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        nativeCandidates.filter((candidate) => !addedFiles.has(candidate.file)),
      ),
    }),
  );
  await page.route("**/api/v1/sessions/*/snapshot", (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    const selected = sessions.find((row) => row.id === id);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...snapshot(id, states.get(id) ?? "released", queues.get(id) ?? []),
        ...(selected
          ? {
              nativeId: selected.nativeId,
              nameInfo: selected.nameInfo,
              projectId: selected.projectId,
            }
          : {}),
      }),
    });
  });
  await page.route("**/api/v1/sessions/*/history**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        entries: [],
        incomplete: false,
        truncated: false,
      }),
    }),
  );
  await page.route("**/api/v1/sessions/*/operations", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    operationPosts.push({ id, body });
    if (abortPrompt && body.kind === "prompt") return route.abort();
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        operationId: body.operationId,
        sessionId: id,
        kind: body.kind,
        status: "ACCEPTED",
      }),
    });
  });
  await page.route("**/api/v1/operations/*", async (route) => {
    receiptGets++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unavailable" } }),
    });
  });
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
    get operationPosts() {
      return operationPosts;
    },
    get receiptGets() {
      return receiptGets;
    },
    setState(id: string, state: State, queue: unknown[] = []) {
      states.set(id, state);
      queues.set(id, queue);
    },
    setAbortPrompt(value: boolean) {
      abortPrompt = value;
    },
    setSessions(value: typeof sessions) {
      sessions = value;
    },
  };
}

async function login(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
}

async function openSidebarIfMobile(page: Page) {
  if ((page.viewportSize()?.width ?? 1024) <= 700) {
    const menu = page.getByRole("button", { name: "☰" });
    if ((await menu.getAttribute("aria-expanded")) === "false")
      await menu.click();
  }
}

async function selectSession(page: Page, id: string) {
  await openSidebarIfMobile(page);
  await page
    .locator("nav button")
    .filter({
      hasText:
        id === ids.newest
          ? longNativeId
          : id === ids.other
            ? `native-${id}`
            : `native-${id}`,
    })
    .click();
}

test("managed and native lists sort by file time, filter projects, refresh, and add candidates safely", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await login(page);
  await openSidebarIfMobile(page);
  const managed = page.locator("nav button");
  await expect(managed).toHaveCount(2);
  await expect(managed.nth(0)).toContainText(longNativeId);
  await expect(managed.nth(0)).toContainText(/檔案更新：.*GMT/);
  await expect(managed.nth(1)).toContainText(ids.older);
  const managedText = await managed.allTextContents();
  expect(managedText.join(" ")).not.toContain("App ID：");
  expect(managedText.join(" ")).not.toContain("fixture-profile");
  const select = page.getByLabel("加入既有 Pi session");
  const orderedCandidateFiles = await select
    .locator("option")
    .evaluateAll((items) =>
      items.map((item) => (item as HTMLOptionElement).value).filter(Boolean),
    );
  expect(orderedCandidateFiles).toEqual([
    "/fixture/unsafe.jsonl",
    "/fixture/new.jsonl",
    "/fixture/tie-a.jsonl",
    "/fixture/tie-b.jsonl",
    "/fixture/old.jsonl",
    "/fixture/unknown.jsonl",
  ]);
  await expect(
    select.locator('option[value="/fixture/new.jsonl"]'),
  ).toContainText("candidate-new");
  await expect(
    select.locator('option[value="/fixture/new.jsonl"]'),
  ).toContainText(/檔案更新：.*GMT/);
  await expect(
    select.locator('option[value="/fixture/unsafe.jsonl"]'),
  ).toHaveAttribute("disabled", "");
  expect(
    await select
      .locator('option[value="/fixture/unsafe.jsonl"]')
      .evaluate((item) => (item as HTMLOptionElement).disabled),
  ).toBe(true);
  await expect(
    select.locator('option[value="/fixture/unknown.jsonl"]'),
  ).toContainText("檔案更新：時間未知");
  await expect(
    select.locator('option[value="/fixture/unsafe.jsonl"]'),
  ).toContainText("unsafe path");
  await page.getByLabel(/Project/).selectOption("second");
  await expect(page.locator("nav button")).toHaveCount(1);
  await expect(page.locator("nav button").first()).toContainText(ids.other);
  await page.getByLabel(/Project/).selectOption("demo");
  await expect(page.locator("nav button")).toHaveCount(2);
  fixture.setSessions(
    sessionRows.map((row) =>
      row.id === ids.older ? { ...row, fileUpdatedAt: 4000 } : row,
    ),
  );
  await page.getByRole("button", { name: "重新整理 Session 清單" }).click();
  await expect(page.locator("nav button").first()).toContainText(ids.older);
  await openSidebarIfMobile(page);
  await page
    .getByLabel("加入既有 Pi session")
    .selectOption("/fixture/new.jsonl");
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "加入選取的 session" }).click();
  const addedRow = page
    .locator("nav button")
    .filter({ hasText: "candidate-new" });
  await expect(addedRow).toBeVisible();
  await expect(page.locator("nav button").first()).toContainText(ids.older);
  await expect(page.locator("nav button").nth(1)).toContainText(
    "candidate-new",
  );
  await expect(addedRow).toContainText(/檔案更新：.*GMT/);
  await expect(
    select.locator('option[value="/fixture/new.jsonl"]'),
  ).toHaveCount(0);
});

test("bounded information and compact one-line layout work on desktop and 320px mobile", async ({
  page,
}) => {
  await installFixture(page);
  await login(page);
  await selectSession(page, ids.newest);
  const infoButton = page.getByRole("button", { name: "Session 設定與資訊" });
  const panel = page.getByRole("region", { name: "Session 設定與資訊" });
  await expect(infoButton).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "複製 cwd" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Runtime：released" }),
  ).toHaveCount(0);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Session 設定與資訊" }).focus();
  await page.keyboard.press("Enter");
  await expect(infoButton).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toContainText(longName);
  await expect(panel).toContainText(longNativeId);
  await expect(panel).toContainText(ids.newest);
  await expect
    .poll(() =>
      panel.evaluate(
        (el) =>
          el.scrollHeight > el.clientHeight &&
          el.clientHeight <= Math.min(window.innerHeight * 0.38, 320) + 2,
      ),
    )
    .toBe(true);
  await panel.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(panel.getByText(/Outcome/)).toBeAttached();
  await expect(page.getByLabel("訊息草稿")).toBeVisible();
  await expect(page.getByRole("region", { name: "對話訊息" })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  const geometry = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    headerHeight: document.querySelector("header")!.getBoundingClientRect()
      .height,
    headerRows: getComputedStyle(document.querySelector("header")!).flexWrap,
    nameOverflow:
      document.querySelector("header strong")!.scrollWidth >
      document.querySelector("header strong")!.clientWidth,
    textarea: document
      .querySelector("textarea")!
      .getBoundingClientRect()
      .toJSON(),
    controlsContentWidth: (() => {
      const controlsElement = document.querySelector("[class*=controls]")!;
      const controlsRect = controlsElement.getBoundingClientRect();
      const style = getComputedStyle(controlsElement);
      return (
        controlsRect.width -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight) -
        Number.parseFloat(style.borderLeftWidth) -
        Number.parseFloat(style.borderRightWidth)
      );
    })(),
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(320);
  expect(geometry.headerHeight).toBeLessThanOrEqual(60);
  expect(geometry.headerRows).toBe("nowrap");
  expect(geometry.nameOverflow).toBe(true);
  expect(
    Math.abs(geometry.textarea.width - geometry.controlsContentWidth),
  ).toBeLessThanOrEqual(1);
  await expect(infoButton).toHaveAttribute("aria-label", "Session 設定與資訊");
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await page.evaluate(
    (value) => (window as EventWindow).__emit("snapshot", value),
    snapshot(ids.newest, "reconfiguring"),
  );
  await expect(page.getByLabel("Runtime：reconfiguring")).toBeAttached();
  const reconfiguringGeometry = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    headerHeight: document.querySelector("header")!.getBoundingClientRect()
      .height,
    buttonsOutside: [...document.querySelectorAll("header button")].some(
      (button) => button.getBoundingClientRect().right > 320,
    ),
  }));
  expect(reconfiguringGeometry.documentWidth).toBeLessThanOrEqual(320);
  expect(reconfiguringGeometry.headerHeight).toBeLessThanOrEqual(60);
  expect(reconfiguringGeometry.buttonsOutside).toBe(false);
  expect(
    await page
      .getByRole("button", { name: /^(Compact|Prompt|Steering|Follow-up)$/ })
      .count(),
  ).toBe(4);
  await infoButton.click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "複製 cwd" })).toHaveCount(0);
  await infoButton.click();
  await expect(panel).toBeVisible();
  await openSidebarIfMobile(page);
  await page
    .locator("nav button")
    .filter({ hasText: `native-${ids.older}` })
    .click();
  await expect(infoButton).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
});

test("composer alignment, compact eligibility, and UNKNOWN operation never auto-replay", async ({
  page,
}) => {
  const fixture = await installFixture(page);
  await login(page);
  await selectSession(page, ids.newest);
  const draft = page.getByLabel("訊息草稿");
  const compact = page.getByRole("button", { name: "Compact" });
  const prompt = page.getByRole("button", { name: "Prompt", exact: true });
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  const releasedAlignment = await page.evaluate(() => {
    const notice = document.querySelector('main > p[role="status"]')!;
    const textarea = document.querySelector("textarea")!;
    return Math.abs(
      notice.getBoundingClientRect().left +
        Number.parseFloat(getComputedStyle(notice).paddingLeft) -
        textarea.getBoundingClientRect().left,
    );
  });
  expect(releasedAlignment).toBeLessThanOrEqual(1);
  if ((page.viewportSize()?.width ?? 1024) > 700)
    expect(
      await page
        .locator("header")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(60);
  fixture.setState(ids.newest, "idle");
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await page.evaluate(
    (value) => (window as EventWindow).__emit("snapshot", value),
    snapshot(ids.newest, "idle"),
  );
  await expect(compact).toBeEnabled();
  const desktopLayout = await page.evaluate(() => {
    const promptButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Prompt",
    )!;
    const compactButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Compact",
    )!;
    return {
      compactTop: compactButton.getBoundingClientRect().top,
      promptTop: promptButton.getBoundingClientRect().top,
      textareaHeight: document
        .querySelector("textarea")!
        .getBoundingClientRect().height,
    };
  });
  if ((page.viewportSize()?.width ?? 1024) > 700)
    expect(desktopLayout.compactTop).toBeLessThan(desktopLayout.promptTop);
  expect(desktopLayout.textareaHeight).toBeGreaterThanOrEqual(100);
  await draft.fill("ready after compact");
  await compact.click();
  await expect
    .poll(() => fixture.operationPosts.at(-1)?.body.kind)
    .toBe("compact");
  await expect(compact).toBeEnabled();
  await expect(prompt).toBeEnabled();
  for (const state of ["released", "running", "blocked", "idle"] as const) {
    const queue =
      state === "idle" ? [{ id: "queued", kind: "steer", text: "queued" }] : [];
    await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
    fixture.setState(ids.newest, state, queue);
    await page.evaluate(
      (value) => (window as EventWindow).__emit("snapshot", value),
      snapshot(ids.newest, state, queue),
    );
    if (state === "idle" && queue.length) await expect(compact).toBeDisabled();
    else await expect(compact).toBeDisabled();
    const before = fixture.operationPosts.length;
    await compact.evaluate((el: HTMLButtonElement) => el.click());
    expect(fixture.operationPosts).toHaveLength(before);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const textarea = document
      .querySelector("textarea")!
      .getBoundingClientRect();
    const controlsElement = document.querySelector("[class*=controls]")!;
    const controlsRect = controlsElement.getBoundingClientRect();
    const style = getComputedStyle(controlsElement);
    const controlsContentWidth =
      controlsRect.width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      Number.parseFloat(style.borderLeftWidth) -
      Number.parseFloat(style.borderRightWidth);
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) =>
        ["Compact", "Prompt", "Steering", "Follow-up"].includes(
          button.textContent?.trim() ?? "",
        ),
      )
      .map((button) => button.getBoundingClientRect());
    return {
      textareaWidth: textarea.width,
      controlsContentWidth,
      buttonCount: buttons.length,
      rowTops: [...new Set(buttons.map((rect) => Math.round(rect.top)))].length,
    };
  });
  expect(
    Math.abs(mobile.textareaWidth - mobile.controlsContentWidth),
  ).toBeLessThanOrEqual(1);
  expect(mobile.buttonCount).toBe(4);
  expect(mobile.rowTops).toBeLessThanOrEqual(2);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  fixture.setState(ids.newest, "released");
  await page.evaluate(
    (value) => (window as EventWindow).__emit("snapshot", value),
    snapshot(ids.newest, "released"),
  );
  await draft.fill("ambiguous operation");
  fixture.setAbortPrompt(true);
  const beforePrompt = fixture.operationPosts.length;
  const promptFailure = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.method() === "POST" &&
      request.url().includes(`/sessions/${ids.newest}/operations`),
  });
  await prompt.click();
  await promptFailure;
  await expect(
    page.getByText("操作結果尚未確認；不會自動重送，請勿直接重送。", {
      exact: false,
    }),
  ).toBeVisible();
  await expect.poll(() => fixture.operationPosts.length).toBe(beforePrompt + 1);
  await expect(page.getByText("最近操作收據")).toHaveCount(0);
  await expect
    .poll(async () =>
      JSON.parse(
        (await page.evaluate(() => sessionStorage.getItem("prw-receipts"))) ||
          "[]",
      ).some((receipt: { status: string }) => receipt.status === "UNKNOWN"),
    )
    .toBe(true);
  const receiptQueriesBeforeReload = fixture.receiptGets;
  await page.reload();
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  await expect
    .poll(() => fixture.receiptGets)
    .toBeGreaterThan(receiptQueriesBeforeReload);
  expect(fixture.operationPosts).toHaveLength(beforePrompt + 1);
});
