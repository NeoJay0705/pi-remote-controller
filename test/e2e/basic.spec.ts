import { test, expect } from "@playwright/test";
import {
  ensureInformationOpen,
  expectNoReceiptUi,
  expectPiSessionId,
  savedReceipts,
} from "./ui-helpers.js";
test("login and create managed native session", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });
  const operationIds: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/sessions\/[^/]+\/operations$/.test(request.url())
    )
      operationIds.push(
        (request.postDataJSON() as { operationId: string }).operationId,
      );
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const assets = await page
    .locator('script[src], link[rel="stylesheet"][href]')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node instanceof HTMLScriptElement
          ? node.src
          : (node as HTMLLinkElement).href,
      ),
    );
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    const result = await page.request.get(asset);
    expect(result.status()).toBe(200);
    expect(result.headers()["content-type"]).toMatch(
      asset.endsWith(".css") ? /text\/css/ : /javascript/,
    );
  }
  const emptyProjectNativeRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/projects//native-sessions")
      emptyProjectNativeRequests.push(request.url());
  });
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  if (page.viewportSize()?.width && page.viewportSize()!.width <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await expect(page.getByText("受管 Sessions")).toBeVisible();
  const appRoot = page.locator("#root > div");
  await expect(appRoot).toBeVisible();
  const palette = await appRoot.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
  }));
  expect(palette.background).toBe("rgb(250, 247, 240)");
  expect(palette.color).toBe("rgb(25, 25, 25)");
  expect(emptyProjectNativeRequests).toEqual([]);
  const createdResponse = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const created = (await (await createdResponse).json()) as {
    id: string;
    nativeId: string;
  };
  if (page.viewportSize()?.width && page.viewportSize()!.width <= 700)
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "關閉" })
      .click();
  await expectPiSessionId(page, created.nativeId);
  const runtimeStatus = page
    .getByRole("status")
    .filter({ hasText: "Pi 尚未啟動" });
  await expect(runtimeStatus).toBeVisible();
  await expect(runtimeStatus).toContainText("Pi 尚未啟動");
  const missing = await page.request.get("/api/v1/does-not-exist");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-type"]).toMatch(/application\/json/);
  await page.getByLabel("訊息草稿").fill("normal");
  await page.getByRole("button", { name: "Prompt" }).click();
  await ensureInformationOpen(page);
  await expect(
    page
      .getByRole("region", { name: "Session 設定與資訊" })
      .getByText("fake-model"),
  ).toBeVisible();
  await expect(
    page.getByText("streaming response", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  await expect(page.getByText("done", { exact: true })).toHaveCount(1);
  await expect.poll(() => operationIds.length).toBe(1);
  expect(operationIds[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await expectNoReceiptUi(page);
  await expect
    .poll(async () => savedReceipts(page))
    .toContainEqual(
      expect.objectContaining({
        operationId: operationIds[0],
        sessionId: created.id,
        kind: "prompt",
        status: expect.stringMatching(/ACCEPTED|HANDLED/),
      }),
    );
  await page.reload();
  await expect(page.locator("header[data-session-id]")).toHaveAttribute(
    "data-session-id",
    created.id,
  );
  await expect(page.getByLabel("Owner token")).toHaveCount(0);
  await expect(page.getByText("done", { exact: true })).toHaveCount(1);
  expect(operationIds).toHaveLength(1);
});
