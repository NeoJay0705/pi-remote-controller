import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { expectPiSessionId } from "./ui-helpers.js";

type Snapshot = {
  id: string;
  nativeId: string;
  runtimeState: string;
  desiredOwner: string;
};
type History = { entries: Array<{ id: string; message?: unknown }> };

async function ensureSidebar(page: Page): Promise<void> {
  if (
    (page.viewportSize()?.width ?? 1000) <= 700 &&
    !(await page.getByRole("complementary").isVisible())
  )
    await page.getByRole("button", { name: "☰" }).click();
}

async function closeSidebar(page: Page): Promise<void> {
  const close = page
    .getByRole("complementary")
    .getByRole("button", { name: "關閉" });
  if ((page.viewportSize()?.width ?? 1000) <= 700 && (await close.isVisible()))
    await close.click();
}

async function currentSession(
  page: Page,
): Promise<{ id: string; nativeId: string }> {
  const id = await page.locator("header").getAttribute("data-session-id");
  await expect(page.locator("header")).toHaveAttribute(
    "data-session-id",
    /[\w-]+/,
  );
  expect(id).toBeTruthy();
  const snapshotResponse = await page.request.get(
    `/api/v1/sessions/${id}/snapshot`,
  );
  expect(snapshotResponse.status()).toBe(200);
  const snapshot = (await snapshotResponse.json()) as Snapshot;
  return { id: id!, nativeId: snapshot.nativeId };
}

test("session switching survives offline completion and page reconnect", async ({
  page,
  context,
}) => {
  const prompts: Array<{ sessionId: string; text?: string }> = [];
  const otherOperations: string[] = [];
  context.on("request", (request) => {
    if (
      request.method() !== "POST" ||
      !/\/api\/v1\/sessions\/[^/]+\/operations$/.test(request.url())
    )
      return;
    const sessionId = request
      .url()
      .match(/\/sessions\/([^/]+)\/operations/)?.[1];
    const body = request.postDataJSON() as { kind: string; text?: string };
    if (body.kind === "prompt")
      prompts.push({ sessionId: sessionId ?? "", text: body.text });
    else otherOperations.push(body.kind);
  });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  await ensureSidebar(page);
  await expect(page.getByText("受管 Sessions")).toBeVisible();

  await ensureSidebar(page);
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await closeSidebar(page);
  await expect(page.locator("header")).toHaveAttribute(
    "data-session-id",
    /[\w-]+/,
  );
  const sessionA = await currentSession(page);

  await ensureSidebar(page);
  await page.getByRole("button", { name: /新建 Session/ }).click();
  await closeSidebar(page);
  await expect
    .poll(async () => (await currentSession(page)).id)
    .not.toBe(sessionA.id);
  const sessionB = await currentSession(page);
  expect(sessionA.id).not.toBe(sessionB.id);
  expect(sessionA.nativeId).not.toBe(sessionB.nativeId);

  const gateName = randomUUID();
  const descriptorPath = resolve(
    process.env.PRW_TEST_DESCRIPTOR ??
      ".test-artifacts/browser-state/descriptor.json",
  );
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    gateDir: string;
  };
  const gatePath = resolve(descriptor.gateDir, gateName);
  const sessionButton = (nativeId: string) =>
    page
      .locator("nav button")
      .filter({ hasText: `Pi session ID：${nativeId}` });

  await ensureSidebar(page);
  await sessionButton(sessionA.nativeId).click();
  await closeSidebar(page);
  const snapshotA = async (): Promise<Snapshot> => {
    const result = await page.request.get(
      `/api/v1/sessions/${sessionA.id}/snapshot`,
    );
    expect(result.status()).toBe(200);
    return (await result.json()) as Snapshot;
  };
  await expect
    .poll(async () => (await snapshotA()).runtimeState)
    .toBe("released");
  await page.getByLabel("訊息草稿").fill(`hold:${gateName}`);
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect
    .poll(async () => (await snapshotA()).runtimeState)
    .toBe("running");
  expect(prompts).toEqual([
    { sessionId: sessionA.id, text: `hold:${gateName}` },
  ]);

  await ensureSidebar(page);
  await sessionButton(sessionB.nativeId).click();
  await closeSidebar(page);
  await page.getByLabel("訊息草稿").fill("draft-B-must-survive");

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await expect(page.getByText("○ 離線", { exact: true })).toBeVisible();
  await writeFile(gatePath, "complete", { mode: 0o600 });
  await expect.poll(async () => (await snapshotA()).runtimeState).toBe("idle");
  const historyAResponse = await page.request.get(
    `/api/v1/sessions/${sessionA.id}/history`,
  );
  expect(historyAResponse.status()).toBe(200);
  await historyAResponse.json();
  await expect
    .poll(async () => {
      const history = (await (
        await page.request.get(`/api/v1/sessions/${sessionA.id}/history`)
      ).json()) as History;
      return history.entries.some((entry) =>
        JSON.stringify(entry.message).includes("done"),
      );
    })
    .toBe(true);
  await expect(page.getByText("done", { exact: true })).toHaveCount(0);
  await expect(page.locator("header")).toHaveAttribute(
    "data-session-id",
    sessionB.id,
  );
  await expect(page.locator("header")).not.toHaveAttribute(
    "data-session-id",
    sessionA.id,
  );
  await expect(
    page.getByRole("region", { name: "Session 設定與資訊" }),
  ).toHaveCount(0);
  expect(await page.getByLabel("訊息草稿").inputValue()).toBe(
    "draft-B-must-survive",
  );

  await context.setOffline(false);
  await expect(page.getByText("● 已連線", { exact: true })).toBeVisible();
  await expect(page.getByLabel("訊息草稿")).toHaveValue("draft-B-must-survive");

  await ensureSidebar(page);
  await sessionButton(sessionA.nativeId).click();
  await closeSidebar(page);
  await expectPiSessionId(page, sessionA.nativeId);
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await snapshotA()).nativeId)
    .toBe(sessionA.nativeId);

  await ensureSidebar(page);
  await sessionButton(sessionB.nativeId).click();
  await closeSidebar(page);
  await expectPiSessionId(page, sessionB.nativeId);
  await expect(page.getByLabel("訊息草稿")).toHaveValue("draft-B-must-survive");
  await expect(page.getByText("done", { exact: true })).toHaveCount(0);

  const reopened = await context.newPage();
  try {
    await reopened.goto("/");
    await expect(reopened.locator("header")).toBeVisible();
    await ensureSidebar(reopened);
    await expect(reopened.getByText("受管 Sessions")).toBeVisible();
    await reopened
      .locator("nav button")
      .filter({ hasText: `Pi session ID：${sessionA.nativeId}` })
      .click();
    await closeSidebar(reopened);
    await expectPiSessionId(reopened, sessionA.nativeId);
    await expect(reopened.getByText("done", { exact: true })).toBeVisible();
  } finally {
    await reopened.close();
  }

  await expect
    .poll(
      () => prompts.filter(({ sessionId }) => sessionId === sessionA.id).length,
    )
    .toBe(1);
  expect(otherOperations).toEqual([]);
  expect(prompts.filter(({ sessionId }) => sessionId === sessionB.id)).toEqual(
    [],
  );
  const finalHistoryA = (await (
    await page.request.get(`/api/v1/sessions/${sessionA.id}/history`)
  ).json()) as History;
  const finalHistoryB = (await (
    await page.request.get(`/api/v1/sessions/${sessionB.id}/history`)
  ).json()) as History;
  expect(
    finalHistoryA.entries.some((entry) =>
      JSON.stringify(entry.message).includes("done"),
    ),
  ).toBe(true);
  expect(finalHistoryB.entries).toEqual([]);
});
