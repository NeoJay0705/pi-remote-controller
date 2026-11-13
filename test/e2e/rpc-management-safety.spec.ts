import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const descriptorPath = process.env.PRW_RPC_DESCRIPTOR!;
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
  entries: Record<
    string,
    { id: string; nativeId: string; name: string; cwd: string; pid: number }
  >;
  projects: Array<{ id: string; cwd: string }>;
  gateDir: string;
  token: string;
};

const login = async (page: Page) => {
  await page.goto("/");
  await page.getByLabel("Owner token").fill(descriptor.token);
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.locator("header")).toBeVisible();
};
const openManagement = async (page: Page) => {
  await page
    .locator("header")
    .getByRole("button", { name: "RPC 管理" })
    .click();
  await expect(page.getByRole("heading", { name: "RPC 管理" })).toBeVisible();
};
const makeIdleRuntime = async (page: Page, label: string) => {
  const response = await page.evaluate(
    async ({ projectId, profileId, name }) => {
      const result = await fetch("/api/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, profileId, name }),
      });
      return { status: result.status, body: await result.json() };
    },
    {
      projectId: descriptor.projects[0].id,
      profileId: "fixture-profile",
      name: label,
    },
  );
  expect(response.status).toBe(201);
  const session = response.body as { id: string };
  const prompted = await page.evaluate(
    async ({ id, operationId, text }) => {
      const result = await fetch(`/api/v1/sessions/${id}/operations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, kind: "prompt", text }),
      });
      return { status: result.status, body: await result.json() };
    },
    {
      id: session.id,
      operationId: crypto.randomUUID(),
      text: "synthetic idle setup",
    },
  );
  expect(prompted.status).toBe(202);
  await expect
    .poll(async () => {
      const snapshot = (await page.evaluate(
        async (id) => (await fetch(`/api/v1/sessions/${id}/snapshot`)).json(),
        session.id,
      )) as { runtimeState: string };
      return snapshot.runtimeState;
    })
    .toBe("idle");
  return session.id;
};
const releaseButton = (page: Page, id: string) =>
  page
    .locator(".rpc-runtime-card")
    .filter({ hasText: id })
    .getByRole("button", { name: "Release RPC" });
const acceptConfirm = (page: Page) =>
  page.once("dialog", (dialog) => void dialog.accept());
test("management list freshness, failure retention, and offline guard", async ({
  page,
}) => {
  test.setTimeout(75_000);
  await login(page);
  await page.clock.install();
  let listRequests = 0;
  let mutations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST") mutations++;
  });
  let mode: "normal" | "fail" | "hang" = "normal";
  let unblock!: () => void;
  page.route("**/api/v1/runtimes", async (route) => {
    listRequests++;
    if (mode === "fail")
      return route.fulfill({ status: 503, body: "synthetic list failure" });
    if (mode === "hang")
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
    return route.continue();
  });
  await openManagement(page);
  const cards = page.locator(".rpc-runtime-card");
  await expect(
    cards.filter({ hasText: descriptor.entries.idleAlpha.id }),
  ).toHaveCount(1);
  const firstCount = listRequests;
  await page.clock.fastForward(5_000);
  await expect.poll(() => listRequests).toBeGreaterThan(firstCount);
  await page.getByRole("button", { name: "重新整理" }).click();
  await expect.poll(() => listRequests).toBeGreaterThan(firstCount + 1);
  mode = "fail";
  await page.getByRole("button", { name: "重新整理" }).click();
  await expect(page.getByRole("alert")).toContainText("更新失敗");
  await expect(
    cards.filter({ hasText: descriptor.entries.idleAlpha.id }),
  ).toHaveCount(1);
  await expect(page.locator(".rpc-runtime-card button").first()).toBeVisible();
  for (const button of await page.locator(".rpc-runtime-card button").all())
    await expect(button).toBeDisabled();
  mode = "normal";
  await page.getByRole("button", { name: "重新整理" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const recoveryCount = listRequests;
  await expect.poll(() => listRequests).toBeGreaterThan(recoveryCount - 1);
  mode = "hang";
  await page.clock.fastForward(5_000);
  await expect.poll(() => listRequests).toBeGreaterThan(recoveryCount);
  await page.clock.fastForward(16_000);
  await expect(
    page.getByRole("status").filter({ hasText: "資料已過期" }),
  ).toBeVisible();
  await expect(page.getByText(/超過 15 秒未成功更新/)).toBeVisible();
  for (const button of await page.locator(".rpc-runtime-card button").all())
    await expect(button).toBeDisabled();
  mode = "normal";
  unblock();
  await page.waitForTimeout(100);
  await page.context().setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "離線" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("目前離線");
  for (const button of await page.locator(".rpc-runtime-card button").all())
    await expect(button).toBeDisabled();
  expect(listRequests).toBeGreaterThan(0);
  expect(mutations).toBe(0);
});

test("ambiguous release delivery remains locked until receipt confirms, without replay", async ({
  page,
}) => {
  await login(page);
  const sessionId = await makeIdleRuntime(
    page,
    `Safety unknown ${crypto.randomUUID()}`,
  );
  await openManagement(page);
  const card = page.locator(".rpc-runtime-card").filter({ hasText: sessionId });
  await expect(card).toHaveCount(1);
  let posts = 0;
  let receiptQueries = 0;
  let receiptMode: "missing" | "real" = "missing";
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes(`/sessions/${sessionId}/operations`)
    )
      posts++;
  });
  page.route(`**/api/v1/sessions/${sessionId}/operations`, async (route) => {
    const response = await route.fetch();
    await route.abort("failed");
    expect(response.ok()).toBe(true);
  });
  page.route("**/api/v1/operations/*", async (route) => {
    receiptQueries++;
    if (receiptMode === "missing")
      return route.fulfill({
        status: 404,
        body: JSON.stringify({
          error: { code: "not_found", message: "missing" },
        }),
      });
    return route.continue();
  });
  acceptConfirm(page);
  await releaseButton(page, sessionId).click();
  await expect(page.getByText(/結果尚未確認；不會自動重送/)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "釋放操作收據" }),
  ).toContainText("UNKNOWN");
  await expect(releaseButton(page, sessionId)).toBeDisabled();
  const saved = (await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("prw-receipts") || "[]"),
  )) as Array<{ sessionId: string; operationId: string; status: string }>;
  const operationId = saved.find(
    (item) => item.sessionId === sessionId,
  )?.operationId;
  expect(operationId).toBeTruthy();
  expect(saved.find((item) => item.operationId === operationId)?.status).toBe(
    "UNKNOWN",
  );
  await page.getByRole("button", { name: "返回對話" }).click();
  await page.reload();
  await expect(page.locator("header")).toBeVisible();
  await openManagement(page);
  const persisted = (await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("prw-receipts") || "[]"),
  )) as Array<{ sessionId: string; operationId: string; status: string }>;
  expect(persisted).toContainEqual(
    expect.objectContaining({ sessionId, operationId, status: "UNKNOWN" }),
  );
  await expect(
    page.locator(".rpc-runtime-card").filter({ hasText: sessionId }),
  ).toHaveCount(0);
  expect(posts).toBe(1);
  receiptMode = "real";
  await page
    .getByRole("region", { name: "釋放操作收據" })
    .getByRole("button", { name: "查詢收據" })
    .click();
  await expect(
    page.getByRole("region", { name: "釋放操作收據" }),
  ).toContainText("已確認釋放");
  expect(receiptQueries).toBeGreaterThan(0);
  expect(posts).toBe(1);
  const receipt = (await page.evaluate(
    async (id) => (await fetch(`/api/v1/operations/${id}`)).json(),
    operationId,
  )) as { status: string; result?: { status?: string } };
  expect(receipt).toMatchObject({
    status: "ACCEPTED",
    result: { status: "released" },
  });
});

test("receipt storage failure, changed-state preflight, blocked target, and Escape do not mutate", async ({
  page,
}) => {
  await login(page);
  const storageTarget = await makeIdleRuntime(
    page,
    `Safety storage ${crypto.randomUUID()}`,
  );
  const runningTarget = await makeIdleRuntime(
    page,
    `Safety running ${crypto.randomUUID()}`,
  );
  if ((page.viewportSize()?.width ?? 1000) <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await page
    .getByRole("complementary")
    .getByRole("button", {
      name: new RegExp(descriptor.entries.held.name),
    })
    .click();
  await expect(page.locator("header")).toHaveAttribute(
    "data-session-id",
    descriptor.entries.held.id,
  );
  await openManagement(page);
  await expect(releaseButton(page, storageTarget)).toBeEnabled();
  const postTargets: string[] = [];
  const releasePosts: string[] = [];
  const stopPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().includes("/operations"))
      return;
    postTargets.push(request.url());
    if (request.postDataJSON()?.kind === "release")
      releasePosts.push(request.url());
    if (request.postDataJSON()?.kind === "stop") stopPosts.push(request.url());
  });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (
      window as typeof window & {
        __nativeSetItem?: typeof Storage.prototype.setItem;
      }
    ).__nativeSetItem = original;
    Storage.prototype.setItem = function (key, value) {
      if (key === "prw-receipts")
        throw new DOMException("synthetic quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  acceptConfirm(page);
  await releaseButton(page, storageTarget).click();
  await expect(
    page.getByRole("status").filter({ hasText: "無法安全保存操作收據" }),
  ).toBeVisible();
  expect(
    postTargets.filter((url) =>
      url.includes(`/sessions/${storageTarget}/operations`),
    ),
  ).toHaveLength(0);
  await page.evaluate(() => {
    const native = (
      window as typeof window & {
        __nativeSetItem?: typeof Storage.prototype.setItem;
      }
    ).__nativeSetItem;
    if (!native)
      throw new Error("native sessionStorage.setItem was not captured");
    Storage.prototype.setItem = native;
    delete (
      window as typeof window & {
        __nativeSetItem?: typeof Storage.prototype.setItem;
      }
    ).__nativeSetItem;
  });
  const nonce = `safety-${crypto.randomUUID()}`;
  await page.evaluate(
    async ({ id, operationId, text }) => {
      const response = await fetch(`/api/v1/sessions/${id}/operations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, kind: "prompt", text }),
      });
      if (!response.ok)
        throw new Error(`held prompt rejected: ${response.status}`);
    },
    {
      id: runningTarget,
      operationId: crypto.randomUUID(),
      text: `hold:${nonce}`,
    },
  );
  await expect
    .poll(async () => {
      const snapshot = (await page.evaluate(
        async (id) => (await fetch(`/api/v1/sessions/${id}/snapshot`)).json(),
        runningTarget,
      )) as { runtimeState: string };
      return snapshot.runtimeState;
    })
    .toBe("running");
  await expect(releaseButton(page, runningTarget)).toBeEnabled();
  await expect(
    releaseButton(page, descriptor.entries.blocked.id),
  ).toBeDisabled();
  const preflightPosts: string[] = [];
  await page.route(`**/api/v1/runtimes`, async (route) => {
    const response = await route.fetch();
    const values = (await response.json()) as Array<{
      id: string;
      runtimeState: string;
    }>;
    expect(values.find((item) => item.id === runningTarget)?.runtimeState).toBe(
      "running",
    );
    await route.fulfill({ response, json: values });
  });
  await page.route(
    `**/api/v1/sessions/${runningTarget}/operations`,
    async (route) => {
      preflightPosts.push(route.request().url());
      await route.continue();
    },
  );
  await expect(releaseButton(page, runningTarget)).toBeEnabled();
  acceptConfirm(page);
  await releaseButton(page, runningTarget).click();
  await expect(
    page.getByText("Runtime 狀態或身分已變更；未送出釋放操作，請重新確認。"),
  ).toBeVisible();
  expect(preflightPosts).toHaveLength(0);
  expect(
    releasePosts.filter((url) =>
      url.includes(`/sessions/${runningTarget}/operations`),
    ),
  ).toHaveLength(0);
  await page.keyboard.press("Escape");
  expect(stopPosts).toHaveLength(0);
  const heldSnapshot = (await page.evaluate(
    async (id) => (await fetch(`/api/v1/sessions/${id}/snapshot`)).json(),
    descriptor.entries.held.id,
  )) as { runtimeState: string };
  expect(heldSnapshot.runtimeState).toBe("running");
  const snapshot = (await page.evaluate(
    async (id) => (await fetch(`/api/v1/sessions/${id}/snapshot`)).json(),
    runningTarget,
  )) as { runtimeState: string };
  expect(snapshot.runtimeState).toBe("running");
  await writeFile(`${descriptor.gateDir}/${nonce}`, "");
  await expect
    .poll(async () => {
      const settled = (await page.evaluate(
        async (id) => (await fetch(`/api/v1/sessions/${id}/snapshot`)).json(),
        runningTarget,
      )) as { runtimeState: string };
      return settled.runtimeState;
    })
    .toBe("idle");
});
