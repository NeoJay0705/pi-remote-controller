import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
}

async function openSidebar(page: import("@playwright/test").Page) {
  if (
    (page.viewportSize()?.width ?? 1024) <= 700 &&
    !(await page.getByRole("complementary").isVisible())
  )
    await page.getByRole("button", { name: "☰" }).click();
}

test("session sidebar overlay and Escape are scoped to the mobile menu", async ({
  page,
}) => {
  const operations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/operations$/.test(request.url()))
      operations.push((request.postDataJSON() as { kind: string }).kind);
  });
  await login(page);
  const mobile = (page.viewportSize()?.width ?? 1024) <= 700;
  const menu = page.locator('button[aria-controls="session-sidebar"]');
  if (!mobile) {
    await expect(menu).toBeHidden();
    await expect(page.getByLabel("關閉側欄遮罩")).toHaveCount(0);
    return;
  }
  await menu.click();
  const sidebar = page.getByRole("complementary");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("關閉側欄遮罩")).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "關閉" })).toBeFocused();
  await sidebar.getByText("受管 Sessions").click();
  await expect(sidebar).toBeVisible();
  const overlay = page.getByLabel("關閉側欄遮罩");
  const box = await overlay.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x + box!.width - 8, box!.y + box!.height / 2);
  await expect(sidebar).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "關閉", exact: true })
    .click();
  await page.getByLabel("訊息草稿").fill("hold:menu-escape-proof");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect
    .poll(() => operations.filter((kind) => kind === "prompt").length)
    .toBe(1);
  await expect(page.getByText(/Runtime\s+running/)).toBeVisible();
  await menu.click();
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect
    .poll(() => operations.filter((kind) => kind === "stop").length)
    .toBe(0);
});

test("late accepted operation does not sync a stale session view", async ({
  page,
}) => {
  await login(page);
  const mobile = (page.viewportSize()?.width ?? 1024) <= 700;
  const header = page.locator("header small");
  const createSession = async () => {
    await openSidebar(page);
    const previousId = (await header.innerText()).match(
      /App ID：([\w-]+)/,
    )?.[1];
    await page.getByRole("button", { name: /新建 Session/ }).click();
    let currentId: string | undefined;
    await expect
      .poll(async () => {
        currentId = (await header.innerText()).match(/App ID：([\w-]+)/)?.[1];
        return currentId && currentId !== previousId ? currentId : undefined;
      })
      .toBeTruthy();
    if (mobile && (await page.getByRole("complementary").isVisible()))
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "關閉", exact: true })
        .click();
    return currentId!;
  };
  const firstId = await createSession();
  const secondId = await createSession();
  const sessionButton = (id: string) =>
    page
      .locator("nav button")
      .filter({ hasText: id.slice(0, 8) })
      .last();
  await openSidebar(page);
  await sessionButton(firstId).click();
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();

  let intercepted = false;
  let releaseOperation!: () => void;
  const operationGate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const reads: Record<string, { snapshot: number; history: number }> = {
    [firstId]: { snapshot: 0, history: 0 },
    [secondId]: { snapshot: 0, history: 0 },
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    const match = url.pathname.match(
      /^\/api\/v1\/sessions\/([^/]+)\/(snapshot|history)$/,
    );
    if (request.method() === "GET" && match && reads[match[1]])
      reads[match[1]][match[2] as "snapshot" | "history"]++;
  });
  await page.route(
    `**/api/v1/sessions/${firstId}/operations`,
    async (route) => {
      intercepted = true;
      await operationGate;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          operationId: "delayed-accepted-operation",
          sessionId: firstId,
          kind: "prompt",
          status: "ACCEPTED",
        }),
      });
    },
  );
  await page.getByLabel("訊息草稿").fill("delayed-success-A");
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  await expect.poll(() => intercepted).toBe(true);
  await openSidebar(page);
  await sessionButton(secondId).click();
  await expect(header).toContainText(`App ID：${secondId}`);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await expect.poll(() => reads[secondId].snapshot).toBeGreaterThan(0);
  await expect.poll(() => reads[secondId].history).toBeGreaterThan(0);
  const firstReads = { ...reads[firstId] };

  releaseOperation();
  const receipts = page.locator("details").filter({ hasText: "最近操作收據" });
  await receipts.locator("summary").click();
  await expect(receipts).toContainText(
    `${firstId.slice(0, 8)} · prompt · ACCEPTED`,
  );
  const draft = page.getByLabel("訊息草稿");
  await draft.fill("B remains active");
  await expect(
    page.getByRole("button", { name: "Prompt", exact: true }),
  ).toBeEnabled();
  await expect(header).toContainText(`App ID：${secondId}`);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  expect(reads[firstId]).toEqual(firstReads);
});

test("late operation errors stay with their original session", async ({
  page,
}) => {
  await login(page);
  const mobile = (page.viewportSize()?.width ?? 1024) <= 700;
  const header = page.locator("header small");
  const createSession = async () => {
    await openSidebar(page);
    const previousId = (await header.innerText()).match(
      /App ID：([\w-]+)/,
    )?.[1];
    await page.getByRole("button", { name: /新建 Session/ }).click();
    let currentId: string | undefined;
    await expect
      .poll(async () => {
        currentId = (await header.innerText()).match(/App ID：([\w-]+)/)?.[1];
        return currentId &&
          currentId !== previousId &&
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(currentId)
          ? currentId
          : undefined;
      })
      .toBeTruthy();
    expect(currentId).toBeTruthy();
    expect(currentId).not.toBe(previousId);
    if (mobile && (await page.getByRole("complementary").isVisible()))
      await page
        .getByRole("complementary")
        .getByRole("button", { name: "關閉", exact: true })
        .click();
    return currentId!;
  };
  const firstId = await createSession();
  const secondId = await createSession();
  expect(firstId).toBeTruthy();
  expect(secondId).toBeTruthy();
  expect(firstId).not.toBe(secondId);
  const sessionButton = (id: string) =>
    page
      .locator("nav button")
      .filter({ hasText: id.slice(0, 8) })
      .last();
  await openSidebar(page);
  await sessionButton(firstId).click();
  if (mobile) await expect(page.getByRole("complementary")).toBeHidden();

  let intercepted = false;
  let releaseOperation!: () => void;
  const operationGate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  let operationResponse503 = false;
  let receiptResponse404 = false;
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "POST" &&
      url.pathname === `/api/v1/sessions/${firstId}/operations` &&
      response.status() === 503
    )
      operationResponse503 = true;
    if (
      /^\/api\/v1\/operations\/[^/]+$/.test(url.pathname) &&
      response.status() === 404
    )
      receiptResponse404 = true;
  });
  await page.route(
    `**/api/v1/sessions/${firstId}/operations`,
    async (route) => {
      intercepted = true;
      await operationGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unknown", message: "failed" } }),
      });
    },
  );
  await page.getByLabel("訊息草稿").fill("failure-A");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect.poll(() => intercepted).toBe(true);
  await openSidebar(page);
  await sessionButton(secondId).click();
  await expect(header).toContainText(`App ID：${secondId}`);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  releaseOperation();
  await expect.poll(() => operationResponse503).toBe(true);
  await expect.poll(() => receiptResponse404).toBe(true);
  await page.getByLabel("訊息草稿").fill("keep-B-busy-clear");
  await expect(page.getByRole("button", { name: "Prompt" })).toBeEnabled();
  await expect(page.getByLabel("Session 錯誤")).toHaveCount(0);

  await openSidebar(page);
  await sessionButton(firstId).click();
  await expect(page.getByRole("alert", { name: "Session 錯誤" })).toContainText(
    "請求失敗 (503)",
  );
  await page.getByRole("button", { name: "關閉 Session 錯誤" }).click();
  await expect(page.getByRole("alert", { name: "Session 錯誤" })).toHaveCount(
    0,
  );

  await openSidebar(page);
  await sessionButton(secondId).click();
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await page.route(`**/api/v1/sessions/${secondId}/operations`, (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "unauthorized", message: "expired" },
      }),
    }),
  );
  await page.getByLabel("訊息草稿").fill("auth-expired");
  await expect(page.getByRole("button", { name: "Prompt" })).toBeEnabled();
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect(page.getByLabel("Owner token")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("登入已逾期");
});
