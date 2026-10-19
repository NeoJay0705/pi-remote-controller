import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

type Descriptor = { cwd: string; sessionDir: string };

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function lastRecord(file: string): Promise<Record<string, unknown>> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").trimEnd().split("\n");
    return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

test("recovers from initial history load failure without losing the draft", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const operationRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/sessions\/[^/]+\/operations$/.test(request.url())
    )
      operationRequests.push(request.url());
  });
  await page.goto("/");
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  const mobile = (page.viewportSize()?.width ?? 1024) <= 700;
  if (mobile) await page.getByRole("button", { name: "☰" }).click();
  await expect(
    page.getByRole("complementary").getByText("受管 Sessions"),
  ).toBeVisible();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const created = (await (await createResponse).json()) as {
    id: string;
    nativeId: string;
  };
  if (mobile)
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "關閉" })
      .click();
  await expect(page.getByLabel("Pi session ID")).toContainText(
    created.nativeId,
  );
  const runtimeStatus = page
    .getByRole("status")
    .filter({ hasText: "Pi 尚未啟動" });
  await expect(runtimeStatus).toBeVisible();
  await expect(runtimeStatus).toContainText("Pi 尚未啟動");
  await page.getByLabel("訊息草稿").fill("keep after failed load");
  let failHistory = true;
  await page.route(
    `**/api/v1/sessions/${created.id}/history?limit=**`,
    async (route) => {
      if (failHistory)
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "invalid-record", message: "History unavailable" },
          }),
        });
      else await route.continue();
    },
  );
  if (mobile) await page.getByRole("button", { name: "☰" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button")
    .filter({ hasText: created.nativeId.slice(0, 8) })
    .click();
  await expect(page.getByText("無法載入 session 狀態與歷史")).toBeVisible();
  await expect(page.getByRole("button", { name: "重試載入" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "歷史讀取失敗（invalid-record）；讀取器無法處理部分紀錄。",
  );
  await expect(page.getByText("同步 session 狀態與歷史…")).toHaveCount(0);
  expect(operationRequests).toHaveLength(0);
  failHistory = false;
  await page.getByRole("button", { name: "重試載入" }).click();
  await expect(page.getByLabel("Pi session ID")).toContainText(
    created.nativeId,
  );
  await expect(runtimeStatus).toBeVisible();
  await expect(runtimeStatus).toContainText("Pi 尚未啟動");
  await expect(page.getByLabel("訊息草稿")).toHaveValue(
    "keep after failed load",
  );
  await expect(page.getByText("● 已連線")).toBeVisible();
  await expect
    .poll(async () =>
      (
        await page.request.get(
          `/api/v1/sessions/${created.id}/history?limit=100`,
        )
      ).status(),
    )
    .toBe(200);
  await expect(page.getByRole("alert")).toContainText(
    "歷史讀取失敗（invalid-record）；讀取器無法處理部分紀錄。",
  );
  await page.getByRole("button", { name: "關閉 Session 錯誤" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(operationRequests).toHaveLength(0);
});

test("imports and appends to native sessions without losing external history", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const descriptorPath = process.env.PRW_TEST_DESCRIPTOR;
  expect(descriptorPath).toBeTruthy();
  const descriptor = JSON.parse(
    await readFile(descriptorPath!, "utf8"),
  ) as Descriptor;
  const nativeId = randomUUID();
  const retiredId = randomUUID();
  const currentRootId = randomUUID();
  const externalId = randomUUID();
  const nativeFile = join(descriptor.sessionDir, `${nativeId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: nativeId,
    cwd: descriptor.cwd,
    timestamp: new Date().toISOString(),
  };
  const retiredPrefix = JSON.stringify({
    id: retiredId,
    parentId: null,
    type: "message",
    message: { role: "user", content: "" },
  }).slice(0, -3);
  const currentRoot = {
    id: currentRootId,
    parentId: null,
    type: "message",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "latest-root-proof" },
  };
  const file = await open(nativeFile, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(header)}\n${retiredPrefix}`);
    const chunk = "retired-root-payload-".repeat(3000);
    const payloadBytes = 110 * 1024 * 1024;
    for (let written = 0; written < payloadBytes; written += chunk.length)
      await file.writeFile(
        chunk.slice(0, Math.min(chunk.length, payloadBytes - written)),
      );
    await file.writeFile(`"}}\n${JSON.stringify(currentRoot)}\n`);
  } finally {
    await file.close();
  }
  const sourceStat = await stat(nativeFile);
  const sourceHash = await fileHash(nativeFile);

  const operationRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/sessions\/[^/]+\/operations$/.test(request.url())
    )
      operationRequests.push(request.url());
  });

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
  });
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  const mobile = (page.viewportSize()?.width ?? 1024) <= 700;
  if (mobile) await page.getByRole("button", { name: "☰" }).click();
  const sidebar = page.getByRole("complementary");
  await expect(sidebar.getByText("受管 Sessions")).toBeVisible();
  const candidate = sidebar.getByLabel("加入既有 Pi session");
  const nativeOption = candidate.locator(`option[value="${nativeFile}"]`);
  await expect(nativeOption).toHaveCount(1);
  await expect(nativeOption).toBeEnabled();
  await expect(nativeOption).toContainText(nativeId);
  await candidate.selectOption(nativeFile);
  await sidebar.getByRole("button", { name: "加入選取的 session" }).click();
  if (mobile) await sidebar.getByRole("button", { name: "關閉" }).click();

  await expect(page.getByLabel("Pi session ID")).toContainText(nativeId);
  await expect(
    page.getByText("latest-root-proof", { exact: false }),
  ).toHaveCount(1);
  await expect(
    page.getByText("retired-root-payload", { exact: false }),
  ).toHaveCount(0);
  const sessionsResponse = await page.request.get("/api/v1/sessions");
  expect(sessionsResponse.status()).toBe(200);
  const sessions = (await sessionsResponse.json()) as Array<{
    id: string;
    nativeId: string;
    nativeFile: string;
  }>;
  const imported = sessions.find((session) => session.nativeId === nativeId);
  expect(imported?.nativeFile).toBe(nativeFile);
  const snapshotResponse = await page.request.get(
    `/api/v1/sessions/${imported!.id}/snapshot`,
  );
  expect(snapshotResponse.status()).toBe(200);
  const snapshot = (await snapshotResponse.json()) as {
    id: string;
    nativeId: string;
    runtimeState: string;
    cwd: string;
    sessionDir: string;
    nativeCommand: string;
  };
  expect(snapshot).toMatchObject({
    id: imported!.id,
    nativeId,
    runtimeState: "released",
    cwd: descriptor.cwd,
    sessionDir: descriptor.sessionDir,
    nativeCommand: `cd '${descriptor.cwd}' && pi --session-dir '${descriptor.sessionDir}' --session '${nativeId}'`,
  });
  await expect(page.getByText(`App ID：${imported!.id}`)).toBeVisible();
  await expect(
    page.getByText(`cwd ${descriptor.cwd}`, { exact: false }),
  ).toBeHidden();
  await page.getByText("Session 資訊").click();
  await expect(
    page.getByText(`cwd ${descriptor.cwd}`, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(`Session dir ${descriptor.sessionDir}`, { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "複製原生 Pi 命令" }).click();
  await expect(page.getByLabel("手動複製內容")).toHaveValue(
    snapshot.nativeCommand,
  );
  await page.getByRole("button", { name: "關閉" }).last().click();
  const sessionAccessWarning = page
    .getByRole("note")
    .filter({ hasText: "請勿讓 Web 與原生 Pi 同時寫入" });
  await expect(sessionAccessWarning).toContainText(
    "請勿讓 Web 與原生 Pi 同時寫入",
  );
  await expect(sessionAccessWarning).toBeVisible();
  await page.getByText("Session 資訊").click();
  await expect(sessionAccessWarning).toBeHidden();
  await expect(page.getByRole("button", { name: "交接 TUI" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Claim 回 Web" })).toHaveCount(
    0,
  );
  expect((await stat(nativeFile)).size).toBe(sourceStat.size);
  expect(await fileHash(nativeFile)).toBe(sourceHash);
  expect(operationRequests).toHaveLength(0);

  await appendFile(
    nativeFile,
    `${JSON.stringify({
      id: externalId,
      parentId: currentRootId,
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "external-append-proof" },
    })}\n`,
  );
  await page.reload();
  if (await page.getByLabel("Owner token").count()) {
    await page
      .getByLabel("Owner token")
      .fill("browser-fixture-owner-token-0123456789");
    await page.getByRole("button", { name: "登入" }).click();
  }
  if (mobile) await page.getByRole("button", { name: "☰" }).click();
  await expect(
    page.getByRole("complementary").getByText("受管 Sessions"),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button")
    .filter({ hasText: nativeId.slice(0, 8) })
    .click();
  if (mobile) await expect(page.getByRole("complementary")).toBeHidden();
  await expect(
    page.getByText("external-append-proof", { exact: false }),
  ).toHaveCount(1);
  expect(operationRequests).toHaveLength(0);

  await page.getByLabel("訊息草稿").fill("fast");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect(page.getByText("fast", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const record = await lastRecord(nativeFile);
      return [
        record.parentId,
        (record.message as { content?: string })?.content,
      ];
    })
    .toEqual([externalId, "fast"]);
  expect(operationRequests).toHaveLength(1);
});
