import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectCurrentAppId } from "./ui-helpers.js";

type Descriptor = { gateDir: string };
type HistoryEntry = {
  id: string;
  message?: { role?: string; content?: unknown };
};

async function sidebar(page: Page, open: boolean): Promise<void> {
  if ((page.viewportSize()?.width ?? 1024) <= 700) {
    const panel = page.getByRole("complementary");
    if (open && !(await panel.isVisible()))
      await page.getByRole("button", { name: "☰" }).click();
    if (!open && (await panel.isVisible()))
      await panel.getByRole("button", { name: "關閉" }).click();
  }
}

async function gate(path: string): Promise<void> {
  await writeFile(path, "continue", { mode: 0o600 });
}

test("subagent snapshots remain request-scoped, safe, and recoverable", async ({
  page,
}) => {
  const descriptorPath = process.env.PRW_TEST_DESCRIPTOR;
  expect(descriptorPath).toBeTruthy();
  const descriptor = JSON.parse(
    await readFile(descriptorPath!, "utf8"),
  ) as Descriptor;
  const nonce = randomUUID();
  const prompts: string[] = [];
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/operations$/.test(new URL(request.url()).pathname)
    ) {
      const body = request.postDataJSON() as { kind: string; text?: string };
      if (body.kind === "prompt") prompts.push(body.text ?? "");
    }
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      externalRequests.push(request.url());
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      externalRequests.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  await sidebar(page, true);
  await expect(page.getByText("受管 Sessions")).toBeVisible();
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await sidebar(page, false);
  const appIdHeader = page.locator("header");
  await expect(appIdHeader).toHaveAttribute(
    "data-session-id",
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  );
  const sessionId = await appIdHeader.getAttribute("data-session-id");
  expect(sessionId).toBeTruthy();
  const initialSnapshot = (await (
    await page.request.get(`/api/v1/sessions/${sessionId}/snapshot`)
  ).json()) as Snapshot;
  const history = async (): Promise<HistoryEntry[]> => {
    const result = await page.request.get(
      `/api/v1/sessions/${sessionId}/history`,
    );
    expect(result.status()).toBe(200);
    return ((await result.json()) as { entries: HistoryEntry[] }).entries;
  };
  const requestFor = async (prompt: string): Promise<string | undefined> => {
    const entry = (await history()).find(
      (item) =>
        item.message?.role === "user" &&
        JSON.stringify(item.message.content).includes(prompt),
    );
    return entry?.id;
  };

  const demo = `tools-demo:${nonce}`;
  await page.getByLabel("訊息草稿").fill(demo);
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect.poll(() => requestFor(demo)).toBeTruthy();
  const demoRequest = (await requestFor(demo))!;
  const demoGroup = page.locator(`[data-request-id="${demoRequest}"]`);
  const parentCard = demoGroup.locator(
    '[data-tool-call-id^="fake-tools-demo-"]',
  );
  await expect(parentCard).toBeVisible();
  await expect(demoGroup.locator("[data-tool-call-id]")).toHaveCount(1);
  await expect(
    parentCard.getByText("父 agent 等待子 agent 回報", { exact: false }),
  ).toBeVisible();
  await expect(parentCard).toContainText("執行中");
  await expect(page.getByLabel("Runtime：running")).toBeVisible();

  const progressGate = resolve(descriptor.gateDir, `${nonce}.progress`);
  await gate(progressGate);
  const childWorking = demoGroup.getByText(`child-working-${nonce}`, {
    exact: false,
  });
  await expect(childWorking).toBeVisible();
  await expect(childWorking).toHaveCount(1);
  const repairGate = resolve(descriptor.gateDir, `${nonce}.repair`);
  await gate(repairGate);
  await expect(demoGroup.getByText("recoverable-error-proof")).toBeVisible();
  await expect(demoGroup.getByText(`repair-progress-${nonce}`)).toBeVisible();
  await expect(parentCard).toContainText("執行中");
  expect(await history()).toBeTruthy();
  await gate(resolve(descriptor.gateDir, `${nonce}.finish`));
  await expect(demoGroup.getByText(`tools-done-${nonce}`)).toBeVisible();
  await expect(demoGroup.getByText(`child-complete-${nonce}`)).toBeVisible();
  await expect(page.getByLabel("Runtime：idle")).toBeVisible();
  await expect(parentCard).toContainText("呼叫完成");

  const simpleNonce = randomUUID();
  const simple = `tools-simple:${simpleNonce}`;
  await page.getByLabel("訊息草稿").fill(simple);
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect.poll(() => requestFor(simple)).toBeTruthy();
  const simpleRequest = (await requestFor(simple))!;
  expect(simpleRequest).not.toBe(demoRequest);
  const simpleGroup = page.locator(`[data-request-id="${simpleRequest}"]`);
  await expect(
    simpleGroup.locator('[data-tool-call-id^="fake-tools-simple-"]'),
  ).toBeVisible();
  await expect(simpleGroup.locator("[data-tool-call-id]")).toHaveCount(1);
  await expect(
    demoGroup.locator('[data-tool-call-id^="fake-tools-demo-"]'),
  ).toHaveCount(1);
  await gate(resolve(descriptor.gateDir, `${simpleNonce}.finish`));
  await expect(
    simpleGroup.getByText(`tools-done-${simpleNonce}`),
  ).toBeVisible();
  await expect(
    simpleGroup.locator('[data-tool-call-id^="fake-tools-demo-"]'),
  ).toHaveCount(0);
  await expect(page.getByText(/工具活動\s*\(/)).toHaveCount(0);
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts).toEqual([demo, simple]);

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  for (const sentinel of [
    "SYSTEM-SENTINEL",
    "THINKING-SENTINEL",
    "SIGNATURE-SENTINEL",
    "RAWSTDERR-SENTINEL",
  ])
    await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(
    page.locator('img[src^="https://external.invalid"]'),
  ).toHaveCount(0);
  expect(externalRequests).toEqual([]);

  await page.reload();
  await sidebar(page, true);
  const savedSession = page
    .locator("nav button")
    .filter({ hasText: `Pi session ID：${initialSnapshot.nativeId}` });
  await expect(savedSession).toBeVisible();
  await savedSession.click();
  await sidebar(page, false);
  await expectCurrentAppId(page, sessionId!);
  await expect.poll(() => requestFor(demo)).toBeTruthy();
  const persistedDemoRequest = (await requestFor(demo))!;
  const persistedGroup = page.locator(
    `[data-request-id="${persistedDemoRequest}"]`,
  );
  const persistedCard = persistedGroup.locator(
    '[data-tool-call-id^="fake-tools-demo-"]',
  );
  await expect(persistedCard).toBeVisible();
  await persistedCard.locator("summary").first().click();
  await expect(persistedCard).toContainText("fake/worker-model");
  await expect(persistedCard).toContainText(`child-working-${nonce}`);
  await expect(persistedCard).toContainText("recoverable-error-proof");
  await expect(persistedCard).toContainText(`repair-progress-${nonce}`);
  await expect(persistedCard).not.toContainText("late-child");
  await expect(
    persistedGroup.getByText(`tools-done-${nonce}`, { exact: false }),
  ).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await sidebar(page, true);
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await sidebar(page, false);
  const otherAppIdHeader = page.locator("header");
  await expect
    .poll(async () => {
      const id = await otherAppIdHeader.getAttribute("data-session-id");
      return id && id !== sessionId ? id : undefined;
    })
    .toBeTruthy();
  const otherSessionId = await otherAppIdHeader.getAttribute("data-session-id");
  expect(otherSessionId).toBeTruthy();
  expect(otherSessionId).not.toBe(sessionId);
  await expect(page.getByLabel("Runtime：released")).toBeVisible();
  await expect(
    page.getByText(`tools-done-${nonce}`, { exact: false }),
  ).toHaveCount(0);
  await sidebar(page, true);
  await page
    .locator("nav button")
    .filter({ hasText: `Pi session ID：${initialSnapshot.nativeId}` })
    .click();
  await sidebar(page, false);
  await expectCurrentAppId(page, sessionId!);
  await expect(
    page.getByText(`tools-done-${nonce}`, { exact: false }),
  ).toBeVisible();
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts).toEqual([demo, simple]);
});
