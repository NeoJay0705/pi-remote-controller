import { expect, test, type Page } from "@playwright/test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { expectCurrentAppId, expectPiSessionId } from "./ui-helpers.js";
import { resolve, join } from "node:path";

async function login(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  await openSidebar(page);
  await expect(page.getByLabel("Session 名稱（選填）")).toBeVisible();
}
async function openSidebar(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1024) <= 700) {
    if (!(await page.getByLabel(/Project/).isVisible()))
      await page.getByRole("button", { name: "☰" }).click();
    await expect(page.getByLabel("Session 名稱（選填）")).toBeVisible();
  }
}
async function selectManagedSession(
  page: Page,
  idPrefix: string,
): Promise<void> {
  const sessions = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string; nativeId: string }>;
  const nativeId = sessions.find((session) =>
    session.id.startsWith(idPrefix),
  )?.nativeId;
  expect(nativeId).toBeTruthy();
  const button = page
    .getByRole("navigation")
    .getByRole("button")
    .filter({ hasText: `Pi session ID：${nativeId}` });
  await button.scrollIntoViewIfNeeded();
  await button.click();
}
async function closeSidebar(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1024) <= 700) {
    if (await page.getByLabel("Session 名稱（選填）").isVisible())
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "關閉" })
        .click();
    await expect(page.getByLabel("Session 名稱（選填）")).toBeHidden();
  }
}
async function createSession(
  page: Page,
  name: string,
): Promise<{ appId: string; nativeId: string }> {
  await openSidebar(page);
  const appIdBefore = await page
    .locator("header")
    .getAttribute("data-session-id");
  await page.getByLabel("Session 名稱（選填）").fill(name);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/sessions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const record = (await response.json()) as { id: string; nativeId: string };
  await expectCurrentAppId(page, record.id);
  expect(await page.locator("header").getAttribute("data-session-id")).not.toBe(
    appIdBefore,
  );
  await expectPiSessionId(page, record.nativeId);
  await closeSidebar(page);
  return { appId: record.id, nativeId: record.nativeId };
}

test("creates named and unnamed sessions with distinct app and Pi IDs", async ({
  page,
}) => {
  await login(page);
  const first = await createSession(page, "中文工作 🚀");
  await expect(page.locator("header strong")).toHaveText("中文工作 🚀");
  await expect(page.getByLabel("Session 名稱（選填）")).toHaveValue("");
  const second = await createSession(page, "中文工作 🚀");
  expect(first.appId).not.toBe(second.appId);
  expect(first.nativeId).not.toBe(second.nativeId);
  await expect(page.locator("header strong")).toHaveText("中文工作 🚀");
  await expectPiSessionId(page, second.nativeId);
  await expect(page.locator("header strong")).not.toContainText(
    second.nativeId,
  );
  await createSession(page, "");
  await expect(page.locator("header strong")).toHaveText("未命名 Session");
});

test("blocks invalid Unicode length before POST and retains a valid name after 503", async ({
  page,
}) => {
  await login(page);
  await openSidebar(page);
  const input = page.getByLabel("Session 名稱（選填）");
  await input.fill("😀".repeat(129));
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/v1/sessions") &&
      request.method() === "POST"
    )
      posts++;
  });
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await expect(page.getByRole("alert", { name: "全域錯誤" })).toContainText(
    "128 個 Unicode code points",
  );
  await expect(page.getByRole("alert", { name: "全域錯誤" })).toContainText(
    "控制字元或換行",
  );
  await expect(input).toHaveValue("😀".repeat(129));
  expect(posts).toBe(0);
  await input.fill("伺服器暫時失敗");
  let failedPosts = 0;
  await page.route("**/api/v1/sessions", async (route) => {
    if (route.request().method() === "POST") {
      failedPosts++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "fixture_failure" } }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await expect(page.getByRole("alert", { name: "全域錯誤" })).toContainText(
    "不會自動重送",
  );
  await expect(input).toHaveValue("伺服器暫時失敗");
  expect(failedPosts).toBe(1);
  await closeSidebar(page);
});

test("refreshes a native candidate before importing and preserves the source hash", async ({
  page,
}) => {
  await login(page);
  const descriptor = JSON.parse(
    await readFile(resolve(process.env.PRW_TEST_DESCRIPTOR!), "utf8"),
  ) as { cwd: string; sessionDir: string };
  const nativeId = randomUUID();
  const candidateFile = join(descriptor.sessionDir, `${nativeId}.jsonl`);
  await writeFile(
    candidateFile,
    `${JSON.stringify({ type: "session", version: 3, id: nativeId, cwd: descriptor.cwd })}\n${JSON.stringify({ type: "session_info", id: randomUUID(), parentId: null, name: "既有原名" })}\n`,
  );
  const before = createHash("sha256")
    .update(await readFile(candidateFile))
    .digest("hex");
  await openSidebar(page);
  await page.getByRole("button", { name: "重新整理 Session 清單" }).click();
  const candidate = page.getByLabel("加入既有 Pi session");
  const candidateOption = candidate.locator(`option[value="${candidateFile}"]`);
  await expect(candidateOption).toHaveCount(1);
  await expect(candidateOption).toBeEnabled();
  await expect(candidateOption).toContainText("既有原名");
  await candidate.selectOption(candidateFile);
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/sessions") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "加入選取的 session" }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const record = (await response.json()) as { id: string };
  await expectCurrentAppId(page, record.id);
  await expect(page.locator("header strong")).toHaveText("既有原名");
  expect(
    createHash("sha256")
      .update(await readFile(candidateFile))
      .digest("hex"),
  ).toBe(before);
  await closeSidebar(page);
});

test("retains the HTTP name after an actual SSE snapshot and refreshes external rename", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    (
      window as typeof window & { __sessionSnapshots?: number }
    ).__sessionSnapshots = 0;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", (event) => {
          try {
            if (
              (JSON.parse((event as MessageEvent).data) as { type?: string })
                .type === "snapshot"
            )
              (window as typeof window & { __sessionSnapshots: number })
                .__sessionSnapshots++;
          } catch {
            /* Ignore unrelated stream payloads. */
          }
        });
      }
    };
  });
  await login(page);
  const created = await createSession(page, "原始名稱");
  await page.waitForFunction(
    () =>
      (window as typeof window & { __sessionSnapshots?: number })
        .__sessionSnapshots! > 0,
  );
  await expect(page.locator("header strong")).toHaveText("原始名稱");
  const sessions = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string; nativeFile: string }>;
  const record = sessions.find((session) => session.id === created.appId)!;
  await appendFile(
    record.nativeFile,
    `${JSON.stringify({ type: "session_info", id: randomUUID(), parentId: null, name: "外部更新名稱" })}\n`,
  );
  await openSidebar(page);
  await page.getByRole("button", { name: "重新整理 Session 清單" }).click();
  await selectManagedSession(page, created.appId.slice(0, 8));
  await closeSidebar(page);
  await expect(page.locator("header strong")).toHaveText("外部更新名稱");
  await expectPiSessionId(page, created.nativeId);
  await page.waitForFunction(
    () =>
      (window as typeof window & { __sessionSnapshots?: number })
        .__sessionSnapshots! > 1,
  );
  await expect(page.locator("header strong")).toHaveText("外部更新名稱");
});

test("keeps long and markup-like names as contained plain text on desktop and mobile", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as typeof window & { __sessionNameXss?: number }).__sessionNameXss =
      0;
  });
  await login(page);
  const longName = "L".repeat(128);
  await createSession(page, longName);
  await expect(page.locator("header strong")).toHaveText(longName);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  const markupName = '<img src=x onerror="window.__sessionNameXss=1">';
  const created = await createSession(page, markupName);
  await expect(page.locator("header strong")).toHaveText(markupName);
  await expectPiSessionId(page, created.nativeId);
  await expect(page.locator("header img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __sessionNameXss?: number })
          .__sessionNameXss,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

test("selects a late managed session by pointer in a long mobile sidebar", async ({
  page,
}) => {
  await login(page);
  const created: Array<{ appId: string; nativeId: string }> = [];
  for (let index = 1; index <= 8; index++) {
    created.push(await createSession(page, `手機長清單 ${index}`));
  }
  await openSidebar(page);
  const managed = page.getByRole("navigation").getByRole("button");
  expect(await managed.count()).toBeGreaterThanOrEqual(8);
  const first = created[0]!;
  const target = created[7]!;
  await selectManagedSession(page, first.appId.slice(0, 8));
  await expect(page.locator("header strong")).toHaveText("手機長清單 1");
  await expectCurrentAppId(page, first.appId);
  await expectPiSessionId(page, first.nativeId);

  await openSidebar(page);
  await selectManagedSession(page, target.appId.slice(0, 8));
  await expect(page.locator("header strong")).toHaveText("手機長清單 8");
  await expect(page.locator("header strong")).not.toHaveText("手機長清單 1");
  await expectCurrentAppId(page, target.appId);
  await expect(page.locator("header")).not.toHaveAttribute(
    "data-session-id",
    first.appId,
  );
  await expectPiSessionId(page, target.nativeId);
  await closeSidebar(page);
});

test("ignores late A metadata after selecting a differently named B session", async ({
  page,
}) => {
  await login(page);
  const sessionA = await createSession(page, "A 標題");
  const sessionB = await createSession(page, "B 標題");
  let releaseA!: () => void;
  let interceptedA!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    interceptedA = resolve;
  });
  let aSnapshotCount = 0;
  const route = `**/api/v1/sessions/${sessionA.appId}/snapshot`;
  await page.route(route, async (requestRoute) => {
    aSnapshotCount++;
    if (aSnapshotCount === 1) {
      await requestRoute.continue();
      return;
    }
    interceptedA();
    await held;
    await requestRoute.continue();
  });
  await openSidebar(page);
  await selectManagedSession(page, sessionA.appId.slice(0, 8));
  await intercepted;
  await openSidebar(page);
  await selectManagedSession(page, sessionB.appId.slice(0, 8));
  await expect(page.locator("header strong")).toHaveText("B 標題");
  const lateAResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/sessions/${sessionA.appId}/snapshot`),
  );
  releaseA();
  await lateAResponse;
  await page.unroute(route);
  await expect(page.locator("header strong")).toHaveText("B 標題");
  await expect(page.locator("header strong")).not.toContainText("A 標題");
  await closeSidebar(page);
});
