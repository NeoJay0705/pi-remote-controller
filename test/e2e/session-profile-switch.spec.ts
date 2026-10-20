import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ensureInformationClosed,
  ensureInformationOpen,
  expectCurrentAppId,
  expectPiSessionId,
} from "./ui-helpers.js";

const token = "browser-fixture-owner-token-0123456789";
const artifacts = resolve(".test-artifacts/session-profile-switch-v1");

async function openApp(page: Page) {
  await page.goto("/");
  if (await page.getByLabel("Owner token").count()) {
    await page.getByLabel("Owner token").fill(token);
    await page.getByRole("button", { name: "登入" }).click();
  }
  if ((page.viewportSize()?.width ?? 1000) <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await expect(page.getByText("受管 Sessions")).toBeVisible();
}

async function closeSidebar(page: Page) {
  const close = page
    .getByRole("complementary")
    .getByRole("button", { name: "關閉" });
  if ((page.viewportSize()?.width ?? 1000) <= 700 && (await close.isVisible()))
    await close.click();
}

async function createSession(page: Page) {
  if (
    (page.viewportSize()?.width ?? 1000) <= 700 &&
    !(await page.getByRole("complementary").isVisible())
  )
    await page.getByRole("button", { name: "☰" }).click();
  const response = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const { id, nativeId } = (await (await response).json()) as {
    id: string;
    nativeId: string;
  };
  await expectCurrentAppId(page, id);
  await closeSidebar(page);
  await expectPiSessionId(page, nativeId);
  return { id, nativeId };
}

async function selectManaged(page: Page, id: string) {
  if (
    (page.viewportSize()?.width ?? 1000) <= 700 &&
    !(await page.getByRole("complementary").isVisible())
  )
    await page.getByRole("button", { name: "☰" }).click();
  const sessions = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string; nativeId: string }>;
  const nativeId = sessions.find((session) => session.id === id)?.nativeId;
  expect(nativeId).toBeTruthy();
  await page
    .locator("nav button")
    .filter({ hasText: `Pi session ID：${nativeId}` })
    .click();
  await closeSidebar(page);
  await expectCurrentAppId(page, id);
}

const panel = (page: Page) =>
  page.getByRole("region", { name: "Session Profile" });
const savedText = (page: Page) => page.getByLabel("已保存 Session Profile");

async function openProfile(page: Page) {
  await ensureInformationOpen(page);
  const profilePanel = panel(page);
  const select = profilePanel.getByLabel("待選 Session Profile");
  if (!(await select.isVisible()))
    await profilePanel.locator("details > summary").click();
}

async function chooseProfile(page: Page, value: string) {
  await openProfile(page);
  await panel(page).getByLabel("待選 Session Profile").selectOption(value);
}
const getDescriptor = async () =>
  JSON.parse(
    await readFile(resolve(process.env.PRW_TEST_DESCRIPTOR!), "utf8"),
  ) as { argvJournal: string; gateDir: string };
const snapshot = async (page: Page, id: string) =>
  (await (
    await page.request.get(`/api/v1/sessions/${id}/snapshot`)
  ).json()) as {
    profileId: string;
    profileRevision: number;
    runtimeState: string;
  };

test("cold profile save preserves draft and survives reload without starting Pi", async ({
  page,
}, testInfo) => {
  await openApp(page);
  const session = await createSession(page);
  await ensureInformationOpen(page);
  const profilePanel = panel(page);
  const profileSelect = profilePanel.getByLabel("待選 Session Profile");
  await expect(profilePanel.locator("details > summary")).toBeVisible();
  await expect(profileSelect).toBeHidden();
  await profilePanel.locator("details > summary").click();
  await expect(profileSelect).toBeVisible();
  const descriptor = await getDescriptor();
  const journalPath = descriptor.argvJournal;
  const journalBefore = await readFile(journalPath, "utf8").catch(() => "");
  await page.getByLabel("訊息草稿").fill("cold draft stays");
  await chooseProfile(page, "fake-alt");
  const operation = page.waitForRequest(
    (item) =>
      item.method() === "POST" &&
      item.url().includes(`/sessions/${session.id}/operations`),
  );
  await panel(page).getByRole("button", { name: "套用 Profile" }).click();
  expect((await operation).postDataJSON()).toMatchObject({
    kind: "change_profile",
    profileId: "fake-alt",
    expectedProfileId: "fake",
    expectedProfileRevision: 0,
  });
  expect((await operation).postDataJSON()).not.toHaveProperty("text");
  await expect(savedText(page)).toContainText("fake-alt");
  await openProfile(page);
  await expect(page.getByLabel("訊息草稿")).toHaveValue("cold draft stays");
  await expect(
    page.getByText("套用後已保存；Pi 尚未啟動驗證。實際設定會在啟動後確認。"),
  ).toBeVisible();
  expect(await snapshot(page, session.id)).toMatchObject({
    profileId: "fake-alt",
    profileRevision: 1,
    runtimeState: "released",
  });
  await expect(page.getByText("fake-alt-model", { exact: true })).toHaveCount(
    0,
  );
  const journalAfter = await readFile(journalPath, "utf8").catch(() => "");
  expect(journalAfter.slice(journalBefore.length)).not.toContain(
    session.nativeId,
  );
  if (testInfo.project.name === "desktop")
    await page.screenshot({
      path: resolve(artifacts, "desktop.png"),
      fullPage: true,
    });
  await page.reload();
  if ((page.viewportSize()?.width ?? 1000) <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await expect(page.getByText("受管 Sessions")).toBeVisible();
  await selectManaged(page, session.id);
  await ensureInformationOpen(page);
  await expect(savedText(page)).toContainText("fake-alt");
});

test("active switch applies actual profile and accepts a unique next prompt while preserving draft", async ({
  page,
}) => {
  await openApp(page);
  const session = await createSession(page);
  await page.getByLabel("訊息草稿").fill("normal");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  await page.getByLabel("訊息草稿").fill("draft after profile switch");
  await chooseProfile(page, "fake-alt");
  await panel(page).getByRole("button", { name: "套用 Profile" }).click();
  await expect(savedText(page)).toContainText("fake-alt");
  await ensureInformationOpen(page);
  const information = page.getByRole("region", { name: "Session 設定與資訊" });
  await expect(
    information.getByText("fake-alt-model", { exact: true }),
  ).toBeVisible();
  await expect(
    information.getByText("fake-alt-provider", { exact: true }),
  ).toBeVisible();
  await expect(information.getByText("medium", { exact: true })).toBeVisible();
  await ensureInformationClosed(page);
  await expect(page.getByLabel("訊息草稿")).toHaveValue(
    "draft after profile switch",
  );
  const descriptor = await getDescriptor();
  await expect
    .poll(async () =>
      (await readFile(descriptor.argvJournal, "utf8")).includes(
        "fake-alt-model",
      ),
    )
    .toBe(true);
  const nonce = `profile-next-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.getByLabel("訊息草稿").fill(nonce);
  const before = (await (
    await page.request.get(`/api/v1/sessions/${session.id}/history`)
  ).json()) as {
    entries: Array<{ message?: { content?: Array<{ text?: string }> } }>;
  };
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/sessions/${session.id}/operations`),
  );
  await page.getByRole("button", { name: "Prompt" }).click();
  const receiptResponse = await accepted;
  expect(await receiptResponse.json()).toMatchObject({ status: "ACCEPTED" });
  await expect
    .poll(async () => {
      const history = (await (
        await page.request.get(`/api/v1/sessions/${session.id}/history`)
      ).json()) as typeof before;
      return JSON.stringify(history.entries);
    })
    .toContain(nonce);
  const after = (await (
    await page.request.get(`/api/v1/sessions/${session.id}/history`)
  ).json()) as typeof before;
  expect(JSON.stringify(after.entries.slice(before.entries.length))).toContain(
    nonce,
  );
  await expect(page.getByLabel("訊息草稿")).toHaveValue("");
});

test("busy runtime disables apply and permits it after work settles", async ({
  page,
}) => {
  await openApp(page);
  const session = await createSession(page);
  await page.getByLabel("訊息草稿").fill("normal");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  const descriptor = await getDescriptor();
  const nonce = `profile-busy-${Date.now()}`;
  await page.getByLabel("訊息草稿").fill(`hold:${nonce}`);
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect(page.getByLabel("Runtime：running")).toBeVisible();
  await chooseProfile(page, "fake-alt");
  await expect(
    panel(page).getByRole("button", { name: "套用 Profile" }),
  ).toBeDisabled();
  await writeFile(resolve(descriptor.gateDir, nonce), "complete", {
    mode: 0o600,
  });
  await expect
    .poll(async () => (await snapshot(page, session.id)).runtimeState)
    .toBe("idle");
  await expect(
    panel(page).getByRole("button", { name: "套用 Profile" }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "套用 Profile" }).click();
  await expect(savedText(page)).toContainText("fake-alt");
});

test("external window updates saved revision and generation guard protects session B", async ({
  page,
  context,
}) => {
  await openApp(page);
  const a = await createSession(page);
  const b = await createSession(page);
  await selectManaged(page, a.id);
  const external = await context.newPage();
  try {
    await openApp(external);
    await selectManaged(external, a.id);
    await chooseProfile(external, "fake-alt");
    await panel(external).getByRole("button", { name: "套用 Profile" }).click();
    await expect(savedText(external)).toContainText("fake-alt");
    await ensureInformationOpen(page);
    await expect(savedText(page)).toContainText("fake-alt");
    await openProfile(page);
    await expect(panel(page).getByLabel("待選 Session Profile")).toHaveValue(
      "fake-alt",
    );
    await expect(
      panel(page).getByRole("button", { name: "套用 Profile" }),
    ).toBeDisabled();
    await selectManaged(external, a.id);
    await chooseProfile(external, "fake");
    await panel(external).getByRole("button", { name: "套用 Profile" }).click();
    await expect(savedText(external)).toContainText("（fake）");
    await expect(savedText(page)).toContainText("（fake）");
    await openProfile(page);
    await expect(panel(page).getByLabel("待選 Session Profile")).toHaveValue(
      "fake",
    );

    await selectManaged(page, a.id);
    await chooseProfile(page, "fake-alt");
    let release!: () => void;
    const held = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    let resolveHandled!: () => void;
    let rejectHandled!: (error: unknown) => void;
    const handled = new Promise<void>((resolveDone, rejectDone) => {
      resolveHandled = resolveDone;
      rejectHandled = rejectDone;
    });
    let operationPostCount = 0;
    const routePattern = `**/api/v1/sessions/${a.id}/operations`;
    await page.route(routePattern, async (route) => {
      operationPostCount++;
      try {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
        resolveHandled();
      } catch (error) {
        rejectHandled(error);
        throw error;
      }
    });
    const operationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v1/sessions/${a.id}/operations`,
    );
    await panel(page).getByRole("button", { name: "套用 Profile" }).click();
    try {
      await expect
        .poll(async () => (await snapshot(page, a.id)).profileId)
        .toBe("fake-alt");
      // Complete another external revision while the first response remains held.
      await selectManaged(external, a.id);
      await chooseProfile(external, "fake");
      await panel(external)
        .getByRole("button", { name: "套用 Profile" })
        .click();
      await expect(savedText(external)).toContainText("（fake）");
      await chooseProfile(external, "fake-alt");
      await panel(external)
        .getByRole("button", { name: "套用 Profile" })
        .click();
      await expect(savedText(external)).toContainText("fake-alt");

      await selectManaged(page, b.id);
      await page.getByLabel("訊息草稿").fill("B draft remains");
    } finally {
      release();
      await handled;
      await page.unroute(routePattern);
    }
    const firstReceipt = await operationResponse;
    expect(firstReceipt.ok()).toBe(true);
    expect(await firstReceipt.json()).toMatchObject({ status: "ACCEPTED" });
    expect(operationPostCount).toBe(1);
    await ensureInformationOpen(page);
    await expect(savedText(page)).toContainText("（fake）");
    await expect(panel(page).getByLabel("待選 Session Profile")).toHaveValue(
      "fake",
    );
    await expect(page.getByLabel("訊息草稿")).toHaveValue("B draft remains");
    expect(await snapshot(page, b.id)).toMatchObject({
      profileId: "fake",
      profileRevision: 0,
    });
  } finally {
    await external.close();
  }
});

test("mobile pointer can apply profile and keep draft usable", async ({
  page,
}, testInfo) => {
  await openApp(page);
  const session = await createSession(page);
  await page.getByLabel("訊息草稿").fill("mobile draft retained");
  const profile = panel(page);
  await chooseProfile(page, "fake-alt");
  await profile.getByRole("button", { name: "套用 Profile" }).click();
  await expect(savedText(page)).toContainText("fake-alt");
  await expect(page.getByLabel("訊息草稿")).toHaveValue(
    "mobile draft retained",
  );
  if (testInfo.project.name === "mobile")
    await page.screenshot({
      path: resolve(artifacts, "mobile.png"),
      fullPage: true,
    });
  expect(await snapshot(page, session.id)).toMatchObject({
    profileId: "fake-alt",
    profileRevision: 1,
  });
});
