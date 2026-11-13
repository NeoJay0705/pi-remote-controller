import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const screenshots = process.env.PRW_RPC_SCREENSHOTS!;
const descriptorPath = process.env.PRW_RPC_DESCRIPTOR!;
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
  entries: Record<
    string,
    { id: string; nativeId: string; name: string; cwd: string; pid: number }
  >;
  projects: Array<{ cwd: string }>;
  gateDir: string;
  rpcJournal: string;
  argvJournal: string;
  exitJournal: string;
  token: string;
};
const login = async (page: import("@playwright/test").Page) => {
  await page.goto("/");
  await page.getByLabel("Owner token").fill(descriptor.token);
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.locator("header")).toBeVisible();
};
const openManagement = async (page: import("@playwright/test").Page) => {
  await page
    .locator("header")
    .getByRole("button", { name: "RPC 管理" })
    .click();
  await expect(page.getByRole("heading", { name: "RPC 管理" })).toBeVisible();
};
const processIsRunning = async (pid: number) => {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return !!stat && stat.split(" ")[2] !== "Z";
};
const recordFile = async (nativeId: string) => {
  for (const project of descriptor.projects) {
    const dir = join(project.cwd, ".pi", "sessions");
    for (const file of await readdir(dir)) {
      const path = join(dir, file);
      if ((await readFile(path, "utf8")).includes(`"id":"${nativeId}"`))
        return path;
    }
  }
  throw new Error(`could not locate native session ${nativeId}`);
};

test("header entry lists seeded runtimes without spawning, selection, or overflow", async ({
  page,
}, testInfo) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "RPC 管理" })).toHaveCount(0);
  await expect(
    page.locator("header").getByRole("button", { name: "RPC 管理" }),
  ).toBeVisible();
  const journalBefore = await readFile(descriptor.rpcJournal, "utf8").catch(
    () => "",
  );
  await openManagement(page);
  const cards = page.locator(".rpc-runtime-card");
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(4);
  for (const key of ["idleAlpha", "idleBeta", "held", "blocked"] as const) {
    const item = descriptor.entries[key];
    const card = cards.filter({
      has: page.getByText(item.name, { exact: true }),
    });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(item.id);
    await expect(card).toContainText(item.cwd);
    await expect(card).toContainText(
      key === "held" ? "running" : key === "blocked" ? "blocked" : "idle",
    );
  }
  await expect(
    cards.filter({ hasText: descriptor.entries.released.id }),
  ).toHaveCount(0);
  await expect(page.getByRole("complementary")).toBeHidden();
  await expect(page.getByRole("button", { name: "Prompt" })).toBeHidden();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(await readFile(descriptor.rpcJournal, "utf8").catch(() => "")).toBe(
    journalBefore,
  );
  await page.screenshot({
    path: `${screenshots}/${testInfo.project.name}-listing.png`,
    fullPage: true,
  });
});

test("cancel then release exactly once, preserve native/ledger/survivor and selection draft, restart same session", async ({
  page,
}) => {
  await login(page);
  if ((page.viewportSize()?.width ?? 1000) <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  const created = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const createdResponse = await created;
  expect(createdResponse.ok()).toBe(true);
  const session = (await createdResponse.json()) as {
    id: string;
    nativeId: string;
  };
  await expect(page.locator("header")).toHaveAttribute(
    "data-session-id",
    session.id,
  );
  if ((page.viewportSize()?.width ?? 1000) <= 700)
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "關閉" })
      .click();
  await page.getByLabel("訊息草稿").fill("normal");
  const initialPrompt = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes(`/sessions/${session.id}/operations`),
  );
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  expect((await (await initialPrompt).json()).status).toBe("ACCEPTED");
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  await page
    .getByLabel("訊息草稿")
    .fill("draft preserved across RPC management");
  const nativeFile = await recordFile(session.nativeId);
  const nativeBefore = await readFile(nativeFile);
  const sessionsBefore = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string; nativeId: string }>;
  const ledgerBefore = sessionsBefore.find((item) => item.id === session.id);
  expect(ledgerBefore).toMatchObject({
    id: session.id,
    nativeId: session.nativeId,
  });
  await openManagement(page);
  const card = page
    .locator(".rpc-runtime-card")
    .filter({ hasText: session.id });
  await expect(card).toHaveCount(1);
  const survivorJournalBefore = await readFile(
    descriptor.exitJournal,
    "utf8",
  ).catch(() => "");
  expect(await processIsRunning(descriptor.entries.idleAlpha.pid)).toBe(true);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes(`/sessions/${session.id}/operations`)
    )
      requests.push(request.url());
  });
  let cancelledDialog = false;
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("確定釋放 RPC");
    cancelledDialog = true;
    void dialog.dismiss();
  });
  await card.getByRole("button", { name: "Release RPC" }).click();
  expect(cancelledDialog).toBe(true);
  await expect.poll(() => requests.length).toBe(0);
  await expect(card).toBeVisible();
  const { WriterLease } = (await import(
    pathToFileURL(
      join(resolve(process.env.PRW_RPC_BUILD_ROOT!), "dist/server/lease.js"),
    ).href
  )) as typeof import("../../src/server/lease.js");
  const releaseResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes(`/sessions/${session.id}/operations`),
  );
  let acceptedDialog = false;
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("確定釋放 RPC");
    acceptedDialog = true;
    void dialog.accept();
  });
  await card.getByRole("button", { name: "Release RPC" }).click();
  expect(acceptedDialog).toBe(true);
  expect((await (await releaseResponse).json()).status).toBe("ACCEPTED");
  await expect.poll(() => requests.length).toBe(1);
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "釋放操作收據" }),
  ).toContainText(session.id);
  const lease = await WriterLease.acquire(`${nativeFile}.prw.lock`);
  await lease.close();
  expect(await readFile(nativeFile)).toEqual(nativeBefore);
  const sessionsAfter = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string; nativeId: string }>;
  expect(sessionsAfter).toContainEqual(
    expect.objectContaining({
      id: ledgerBefore.id,
      nativeId: ledgerBefore.nativeId,
      desiredOwner: "tui",
    }),
  );
  expect(await processIsRunning(descriptor.entries.idleAlpha.pid)).toBe(true);
  const survivorJournalAfter = await readFile(
    descriptor.exitJournal,
    "utf8",
  ).catch(() => "");
  expect(
    survivorJournalAfter.slice(survivorJournalBefore.length),
  ).not.toContain(`"pid":${descriptor.entries.idleAlpha.pid}`);
  await page.getByRole("button", { name: "返回對話" }).click();
  await expect(page.locator("header")).toHaveAttribute(
    "data-session-id",
    session.id,
  );
  await expect(page.getByLabel("訊息草稿")).toHaveValue(
    "draft preserved across RPC management",
  );
  await page.getByLabel("訊息草稿").fill("normal");
  const operation = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().includes(`/sessions/${session.id}/operations`),
  );
  await page.getByRole("button", { name: "Prompt", exact: true }).click();
  expect((await (await operation).json()).status).toBe("ACCEPTED");
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  await expect(page.getByLabel("訊息草稿")).toHaveValue("");
  await openManagement(page);
  await expect(
    page.locator(".rpc-runtime-card").filter({ hasText: session.id }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "釋放操作收據" }),
  ).toContainText(session.id);
});
