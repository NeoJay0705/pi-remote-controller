import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectPiSessionId } from "./ui-helpers.js";

type Descriptor = { cwd: string; sessionDir: string };

test("imports native history with pagination and browser security on desktop and mobile", async ({
  page,
}) => {
  const descriptorPath = process.env.PRW_TEST_DESCRIPTOR;
  expect(descriptorPath).toBeTruthy();
  const descriptor = JSON.parse(
    await readFile(descriptorPath!, "utf8"),
  ) as Descriptor;
  const nativeId = randomUUID();
  const ids = Array.from({ length: 132 }, () => randomUUID());
  const entries = ids.map((id, index) => {
    const parentId = index === 0 ? null : ids[index - 1]!;
    const base = {
      id,
      parentId,
      timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    };
    if (index === 0)
      return {
        ...base,
        type: "message",
        message: { role: "user", content: "oldest-history-proof" },
      };
    if (index === 65)
      return {
        ...base,
        type: "compaction",
        summary: "compaction-summary-proof **summary markdown**",
        firstKeptEntryId: ids[index + 1],
        tokensBefore: 1234,
      };
    if (index === 90)
      return {
        ...base,
        type: "message",
        message: { role: "toolResult", content: "tool-result-proof" },
      };
    if (index === ids.length - 1)
      return {
        ...base,
        type: "message",
        message: {
          role: "assistant",
          content: `newest-history-proof\n\n<script>window.__prw_xss = true</script><img src=x onerror="window.__prw_xss = true">\n\n[javascript link](javascript:window.__prw_xss=true)\n\n![external image](https://external.invalid/image)\n\n\`\`\`text\n${"x".repeat(5000)}\n\`\`\``,
        },
      };
    return {
      ...base,
      type: "message",
      message: { role: "user", content: `synthetic-history-${index}` },
    };
  });
  const nativeFile = join(descriptor.sessionDir, `${nativeId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: nativeId,
    cwd: descriptor.cwd,
    timestamp: new Date().toISOString(),
  };
  await writeFile(
    nativeFile,
    `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    { mode: 0o600, flag: "wx" },
  );

  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      externalRequests.push(request.url());
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      externalRequests.push(route.request().url());
      await route.abort();
      return;
    }
    await route.continue();
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
  const candidateValuesBefore = await candidate
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  await candidate.selectOption(nativeFile);
  await sidebar.getByRole("button", { name: "加入選取的 session" }).click();
  if (mobile) await sidebar.getByRole("button", { name: "關閉" }).click();

  await expectPiSessionId(page, nativeId);
  await expect(
    page.getByText("newest-history-proof", { exact: false }),
  ).toHaveCount(1);
  await expect(
    page.getByText("oldest-history-proof", { exact: false }),
  ).toHaveCount(0);
  const sessionsResponse = await page.request.get("/api/v1/sessions");
  expect(sessionsResponse.status()).toBe(200);
  const sessions = (await sessionsResponse.json()) as Array<{
    id: string;
    nativeId: string;
    nativeFile: string;
  }>;
  const imported = sessions.find((session) => session.nativeId === nativeId);
  expect(imported).toBeTruthy();
  expect(imported!.nativeFile).toBe(nativeFile);
  if (mobile) await page.getByRole("button", { name: "☰" }).click();
  const candidateValuesAfter = await sidebar
    .getByLabel("加入既有 Pi session")
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  expect(candidateValuesAfter.sort()).toEqual(
    candidateValuesBefore.filter((value) => value !== nativeFile).sort(),
  );
  await expect(sidebar.getByRole("option", { name: nativeId })).toHaveCount(0);
  if (mobile) await sidebar.getByRole("button", { name: "關閉" }).click();
  const persistedHeader = JSON.parse(
    (await readFile(imported!.nativeFile, "utf8")).split("\n", 1)[0]!,
  ) as typeof header;
  expect(persistedHeader.cwd).toBe(descriptor.cwd);
  const snapshotResponse = await page.request.get(
    `/api/v1/sessions/${imported!.id}/snapshot`,
  );
  expect(snapshotResponse.status()).toBe(200);
  const snapshot = (await snapshotResponse.json()) as {
    nativeId: string;
    runtimeState: string;
  };
  expect(snapshot.nativeId).toBe(nativeId);
  expect(snapshot.runtimeState).toBe("released");

  await page.getByRole("button", { name: "載入較舊歷史" }).click();
  await expect(
    page.getByText("oldest-history-proof", { exact: false }),
  ).toHaveCount(1);
  await expect(
    page.getByText("newest-history-proof", { exact: false }),
  ).toHaveCount(1);
  await expect(page.getByText(/compaction-summary-proof/)).toBeVisible();
  await expect(
    page.getByText("tool-result-proof", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await expect(
    page.locator("pre").filter({ hasText: "x".repeat(200) }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as Window & { __prw_xss?: boolean }).__prw_xss,
    ),
  ).toBeUndefined();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(
    page.locator('img[src^="https://external.invalid"]'),
  ).toHaveCount(0);
  await expect(page.locator("img[onerror], script:not([src])")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
