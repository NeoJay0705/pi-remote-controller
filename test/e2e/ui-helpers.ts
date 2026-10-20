import { expect, type Page } from "@playwright/test";

export async function currentAppId(page: Page): Promise<string> {
  const id = await page.locator("header").getAttribute("data-session-id");
  expect(id).toBeTruthy();
  return id!;
}

export async function expectCurrentAppId(
  page: Page,
  id: string,
): Promise<void> {
  await expect(page.locator("header")).toHaveAttribute("data-session-id", id);
}

export async function ensureInformationOpen(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1024) <= 700) {
    const sidebar = page.getByRole("complementary");
    if (await sidebar.isVisible()) {
      await sidebar.getByRole("button", { name: "關閉" }).click();
      await expect(sidebar).toBeHidden();
    }
  }
  const toggle = page.getByRole("button", { name: "Session 設定與資訊" });
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

export async function ensureInformationClosed(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Session 設定與資訊" });
  if ((await toggle.getAttribute("aria-expanded")) === "true")
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

export async function expectPiSessionId(page: Page, nativeId: string) {
  await ensureInformationOpen(page);
  await expect(
    page
      .getByRole("region", { name: "Session 設定與資訊" })
      .getByLabel("Pi session ID"),
  ).toContainText(nativeId);
  await ensureInformationClosed(page);
}

export async function expectNoReceiptUi(page: Page): Promise<void> {
  await expect(page.getByText(/最近操作收據/)).toHaveCount(0);
}

export async function savedReceipts(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("prw-receipts") || "[]") as Array<{
        operationId: string;
        sessionId: string;
        kind: string;
        status: string;
      }>,
  );
}
