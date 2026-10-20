import { test, expect } from "@playwright/test";
import {
  expectNoReceiptUi,
  expectPiSessionId,
  savedReceipts,
} from "./ui-helpers.js";

type Snapshot = {
  id: string;
  nativeId: string;
  runtimeState: string;
  desiredOwner: string;
  queue: Array<{ kind: string; text: string }>;
  cleared: Array<{ kind: string; text: string }>;
};

test("queue, stop, compact, release, and prompt preserve session state", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
  });
  const operationRequests: Array<{
    kind: string;
    text?: string;
    operationId: string;
    sessionId: string;
  }> = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/sessions\/[^/]+\/operations$/.test(request.url())
    ) {
      const sessionId =
        new URL(request.url()).pathname.match(
          /\/sessions\/([^/]+)\/operations$/,
        )?.[1] ?? "";
      operationRequests.push({
        ...(request.postDataJSON() as {
          kind: string;
          text?: string;
          operationId: string;
        }),
        sessionId,
      });
    }
  });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  if (page.viewportSize()?.width && page.viewportSize()!.width <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await expect(page.getByText("受管 Sessions")).toBeVisible();
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const createdResponse = await createResponse;
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()) as {
    id: string;
    nativeId: string;
  };
  if (page.viewportSize()?.width && page.viewportSize()!.width <= 700)
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "關閉" })
      .click();

  const header = page.locator("header");
  await expect(header).toHaveAttribute("data-session-id", created.id);
  await expectPiSessionId(page, created.nativeId);
  const sessionId = created.id;

  const getSnapshot = async (): Promise<Snapshot> => {
    const snapshotResponse = await page.request.get(
      `/api/v1/sessions/${sessionId}/snapshot`,
    );
    expect(snapshotResponse.status()).toBe(200);
    return (await snapshotResponse.json()) as Snapshot;
  };
  const initialSnapshot = await getSnapshot();
  const nativeId = initialSnapshot.nativeId;
  expect(initialSnapshot.runtimeState).toBe("released");

  const draft = page.getByLabel("訊息草稿");
  await draft.fill("hold:queue-case");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect
    .poll(async () => (await getSnapshot()).runtimeState)
    .toBe("running");

  await draft.fill("steer item");
  await page.getByRole("button", { name: "Steering" }).click();
  await expect
    .poll(async () => (await getSnapshot()).queue)
    .toEqual([{ kind: "steer", text: "steer item" }]);

  await draft.fill("follow item");
  await page.getByRole("button", { name: "Follow-up" }).click();
  await expect
    .poll(async () => (await getSnapshot()).queue)
    .toEqual([
      { kind: "steer", text: "steer item" },
      { kind: "follow_up", text: "follow item" },
    ]);
  const queuedItems = page.locator("details").filter({
    hasText: "steer item",
  });
  await expect(
    queuedItems.getByText("Steering", { exact: true }),
  ).toBeVisible();
  await expect(
    queuedItems.getByText("Follow-up", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("pre").getByText("steer item")).toBeVisible();
  await expect(page.locator("pre").getByText("follow item")).toBeVisible();

  await draft.fill("keep my draft");
  await draft.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await expect
    .poll(() => operationRequests.filter(({ kind }) => kind === "stop").length)
    .toBe(0);
  expect((await getSnapshot()).runtimeState).toBe("running");
  expect(await draft.inputValue()).toBe("keep my draft");

  await page
    .getByRole("button", { name: "清佇列並停止；不回滾檔案/commit" })
    .click();
  await expect
    .poll(async () => {
      const snapshot = await getSnapshot();
      return {
        runtimeState: snapshot.runtimeState,
        queue: snapshot.queue,
        cleared: snapshot.cleared,
      };
    })
    .toEqual({
      runtimeState: "idle",
      queue: [],
      cleared: [
        { kind: "steer", text: "steer item" },
        { kind: "follow_up", text: "follow item" },
      ],
    });
  expect(await draft.inputValue()).toBe("keep my draft");
  await page.getByText("已清除佇列（不會自動重送）").click();
  const clearedItems = page
    .locator("details")
    .filter({ hasText: "已清除佇列（不會自動重送）" });
  await expect(
    clearedItems.getByText("steer item", { exact: true }),
  ).toBeVisible();
  await expect(
    clearedItems.getByText("follow item", { exact: true }),
  ).toBeVisible();
  expect(await draft.inputValue()).toBe("keep my draft");
  const requestCountBeforeCopy = operationRequests.length;
  await clearedItems.getByRole("button", { name: "複製" }).first().click();
  const manualCopy = page.getByLabel("手動複製內容");
  await expect(manualCopy).toHaveValue("steer item");
  expect(await draft.inputValue()).toBe("keep my draft");
  expect(operationRequests).toHaveLength(requestCountBeforeCopy);
  await page.getByRole("button", { name: "關閉" }).last().click();

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise<void>((_resolve, reject) => {
            (
              window as Window & { rejectClipboard?: () => void }
            ).rejectClipboard = () => reject(new Error("fixture rejection"));
          }),
      },
      configurable: true,
    });
  });
  await clearedItems.getByRole("button", { name: "複製" }).first().click();
  await page.waitForFunction(
    () =>
      typeof (window as Window & { rejectClipboard?: () => void })
        .rejectClipboard === "function",
  );
  if (page.viewportSize()?.width && page.viewportSize()!.width <= 700)
    await page.getByRole("button", { name: "☰" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button")
    .filter({ hasText: `Pi session ID：${created.nativeId}` })
    .click();
  await page.evaluate(() => {
    (window as Window & { rejectClipboard?: () => void }).rejectClipboard?.();
  });
  await expect(page.getByLabel("手動複製")).toHaveCount(0);
  expect(await draft.inputValue()).toBe("keep my draft");
  expect(operationRequests).toHaveLength(requestCountBeforeCopy);

  await page.getByRole("button", { name: "Compact" }).click();
  await expect
    .poll(async () => (await getSnapshot()).runtimeState)
    .toBe("idle");
  expect((await getSnapshot()).nativeId).toBe(nativeId);

  await expect(page.getByRole("button", { name: "交接 TUI" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Claim 回 Web" })).toHaveCount(
    0,
  );
  const releaseResponse = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/sessions/${id}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        kind: "release",
      }),
    });
    return response.status;
  }, sessionId);
  expect(releaseResponse).toBe(202);
  await expect
    .poll(async () => {
      const snapshot = await getSnapshot();
      return [snapshot.runtimeState, snapshot.desiredOwner];
    })
    .toEqual(["released", "tui"]);
  expect((await getSnapshot()).nativeId).toBe(nativeId);

  await draft.fill("fast");
  await page.getByRole("button", { name: "Prompt" }).click();
  await expect
    .poll(async () => {
      const snapshot = await getSnapshot();
      return [snapshot.runtimeState, snapshot.desiredOwner];
    })
    .toEqual(["idle", "web"]);
  expect((await getSnapshot()).nativeId).toBe(nativeId);

  await expect
    .poll(() => operationRequests.filter(({ kind }) => kind === "stop").length)
    .toBe(1);
  expect(operationRequests.filter(({ kind }) => kind === "steer")).toHaveLength(
    1,
  );
  expect(
    operationRequests.filter(({ kind }) => kind === "follow_up"),
  ).toHaveLength(1);
  expect(
    operationRequests
      .filter(({ kind }) => kind === "prompt")
      .map(({ text }) => text),
  ).toEqual(["hold:queue-case", "fast"]);
  expect(operationRequests.map(({ kind }) => kind)).toEqual([
    "prompt",
    "steer",
    "follow_up",
    "stop",
    "compact",
    "release",
    "prompt",
  ]);
  await expectNoReceiptUi(page);
  await expect
    .poll(async () => savedReceipts(page))
    .toEqual(
      expect.arrayContaining(
        operationRequests
          .filter((operation) => operation.kind !== "release")
          .map((operation) =>
            expect.objectContaining({
              operationId: operation.operationId,
              sessionId: operation.sessionId,
              kind: operation.kind,
              status: expect.stringMatching(/ACCEPTED|HANDLED/),
            }),
          ),
      ),
    );
  await expect(draft).toHaveValue("");
  await expect(page.getByText("fast", { exact: true })).toHaveCount(1);
  await expect(page.getByText("keep my draft", { exact: true })).toHaveCount(0);
});
