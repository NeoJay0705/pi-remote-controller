import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ownerToken = "browser-fixture-owner-token-0123456789";

test("browse and select a nested directory with its native session", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page.getByLabel("Owner token").fill(ownerToken);
  await page.getByRole("button", { name: "登入" }).click();
  const projectSelect = page.getByLabel(/Project/);
  if (page.viewportSize()!.width <= 700 && !(await projectSelect.isVisible()))
    await page.getByRole("button", { name: "☰" }).click();

  await page.getByRole("button", { name: "瀏覽目錄" }).click();
  await expect(page.getByLabel("目錄路徑")).toHaveText("repos");
  await page.getByRole("button", { name: "container", exact: true }).click();
  await expect(page.getByLabel("目錄路徑")).toHaveText("repos / container");
  await expect(
    page.getByRole("button", { name: "nested-a", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "上一層" }).click();
  await expect(page.getByLabel("目錄路徑")).toHaveText("repos");
  await expect(
    page.getByRole("button", { name: "container", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "container", exact: true }).click();
  await page.getByRole("button", { name: "nested-a", exact: true }).click();
  await expect(page.getByLabel("目錄路徑")).toHaveText(
    "repos / container / nested-a",
  );

  const selection = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/projects",
  );
  await page.getByRole("button", { name: "選擇此目錄" }).click();
  const picked = (await (await selection).json()) as {
    id: string;
    name: string;
  };
  await expect(projectSelect).toHaveValue(picked.id);
  await expect(projectSelect.locator("option:checked")).toHaveText(picked.name);
  const nestedNativeId = "9f3a70b5-19de-47e5-ae03-8d36af01a491";
  const nativeSelect = page.getByLabel("加入既有 Pi session");
  await expect(
    nativeSelect.locator(`option[value*="${nestedNativeId}"]`),
  ).toHaveCount(1);
});

test("create and select a nested directory for a new session", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page.getByLabel("Owner token").fill(ownerToken);
  await page.getByRole("button", { name: "登入" }).click();
  const projectSelect = page.getByLabel(/Project/);
  if (page.viewportSize()!.width <= 700 && !(await projectSelect.isVisible()))
    await page.getByRole("button", { name: "☰" }).click();

  await page.getByRole("button", { name: "瀏覽目錄" }).click();
  await page.getByRole("button", { name: "container", exact: true }).click();
  const folderName = `created-${randomUUID()}`;
  await page.getByLabel("新目錄名稱").fill(folderName);
  const selection = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/projects",
  );
  await page.getByRole("button", { name: "建立並選擇" }).click();
  const picked = (await (await selection).json()) as {
    id: string;
    name: string;
  };
  await expect(projectSelect).toHaveValue(picked.id);
  await expect(projectSelect.locator("option:checked")).toHaveText(picked.name);

  const descriptorPath = resolve(process.env.PRW_TEST_DESCRIPTOR!);
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    repoRoot: string;
    privateSessionRoot: string;
  };
  const directory = join(descriptor.repoRoot, "container", folderName);
  const createResponse = page.waitForResponse(
    (item) =>
      item.request().method() === "POST" &&
      new URL(item.url()).pathname === "/api/v1/sessions",
  );
  await page.getByRole("button", { name: /新建 Session/ }).click();
  const created = (await (await createResponse).json()) as {
    id: string;
    projectId: string;
  };
  expect(created.projectId).toBe(picked.id);

  const sessionResponse = await page.request.get("/api/v1/sessions");
  expect(sessionResponse.ok()).toBeTruthy();
  const sessions = (await sessionResponse.json()) as Array<{
    id: string;
    projectId: string;
    nativeFile: string;
  }>;
  const session = sessions.find((item) => item.id === created.id);
  expect(session).toBeDefined();
  expect(session!.projectId).toBe(picked.id);
  const encodedCwd = `--${directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const expectedSessionDir = join(descriptor.privateSessionRoot, encodedCwd);
  expect(dirname(session!.nativeFile)).toBe(expectedSessionDir);
  const header = JSON.parse(
    (await readFile(session!.nativeFile, "utf8")).split("\n")[0]!,
  ) as {
    cwd: string;
  };
  expect(header.cwd).toBe(directory);
});
