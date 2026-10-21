import { expect, test } from "@playwright/test";
import { expectCurrentAppId, expectPiSessionId } from "./ui-helpers.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("discovers isolated projects and keeps sessions grouped", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await page
    .getByLabel("Owner token")
    .fill("browser-fixture-owner-token-0123456789");
  await page.getByRole("button", { name: "登入" }).click();
  const selector = page.getByLabel(/Project/);
  await expect(selector.locator("option", { hasText: "repoA" })).toHaveCount(1);
  const baseline = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string; nativeId: string }>;
  const baselineIds = new Set(baseline.map((session) => session.id));
  const descriptorPath = resolve(process.env.PRW_TEST_DESCRIPTOR!);
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    repoRoot: string;
    privateSessionRoot: string;
    cwd: string;
  };
  const created: Array<{ id: string; projectId: string }> = [];
  const seenNativeIds = new Set<string>();
  const createAndCheck = async (projectName: string, projectPath: string) => {
    if (page.viewportSize()!.width <= 700 && !(await selector.isVisible()))
      await page.getByRole("button", { name: "☰" }).click();
    await selector.selectOption({ label: projectName });
    const createButton = page.getByRole("button", { name: /新建 Session/ });
    await expect(createButton).toBeEnabled();
    const createResponse = page.waitForResponse(
      (item) =>
        item.request().method() === "POST" &&
        new URL(item.url()).pathname === "/api/v1/sessions",
    );
    await createButton.click();
    const { id, nativeId } = (await (await createResponse).json()) as {
      id: string;
      nativeId: string;
    };
    await expectCurrentAppId(page, id);
    await expectPiSessionId(page, nativeId);
    expect(seenNativeIds.has(nativeId)).toBe(false);
    seenNativeIds.add(nativeId);
    const response = await page.request.get("/api/v1/sessions");
    expect(response.ok()).toBeTruthy();
    const sessions = (await response.json()) as Array<{
      id: string;
      nativeId: string;
      nativeFile: string;
      projectId: string;
    }>;
    const record = sessions.find((session) => session.nativeId === nativeId);
    expect(record).toBeDefined();
    expect(baselineIds.has(record!.id)).toBe(false);
    expect(created.some((session) => session.id === record!.id)).toBe(false);
    created.push({ id: record!.id, projectId: record!.projectId });
    const encodedCwd = `--${projectPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    if (projectName !== "示範專案")
      expect(
        record!.nativeFile.startsWith(
          `${descriptor.privateSessionRoot}/${encodedCwd}/`,
        ),
      ).toBe(true);
    const header = JSON.parse(
      (await readFile(record!.nativeFile, "utf8")).split("\n")[0]!,
    );
    expect(header.cwd).toBe(projectPath);
    const snapshot = await page.request.get(
      `/api/v1/sessions/${record!.id}/snapshot`,
    );
    const snapshotData = await snapshot.json();
    expect(snapshotData.nativeId).toBe(nativeId);
    expect(snapshotData.runtimeState).toBe("released");
    expect(snapshotData.actualModel).toBeUndefined();
    const history = await page.request.get(
      `/api/v1/sessions/${record!.id}/history`,
    );
    expect((await history.json()).entries).toEqual([]);
    return record!;
  };

  const repoA = await createAndCheck("repoA", `${descriptor.repoRoot}/repoA`);
  const repoB = await createAndCheck("repoB", `${descriptor.repoRoot}/repoB`);
  expect(repoA.projectId).not.toBe(repoB.projectId);
  if (page.viewportSize()!.width <= 700 && !(await selector.isVisible()))
    await page.getByRole("button", { name: "☰" }).click();
  await selector.selectOption({ label: "示範專案" });
  const demo = await createAndCheck("示範專案", descriptor.cwd);
  expect(demo.projectId).toBe("demo");
  const allSessions = (await (
    await page.request.get("/api/v1/sessions")
  ).json()) as Array<{ id: string }>;
  for (const session of [...created, ...baseline])
    expect(allSessions.some((item) => item.id === session.id)).toBe(true);
  const assertNavigationFor = async (projectId: string) => {
    const expected = await page.request
      .get("/api/v1/sessions")
      .then((response) => response.json())
      .then(
        (
          sessions: Array<{ id: string; nativeId: string; projectId: string }>,
        ) =>
          sessions
            .filter((session) => session.projectId === projectId)
            .map((session) => session.nativeId)
            .sort(),
      );
    const nav = page.getByRole("navigation");
    await expect
      .poll(async () =>
        (await nav.locator("button small").allTextContents())
          .flatMap((label) =>
            [...label.matchAll(/Pi session ID：([0-9a-f-]{36})/gi)].map(
              (match) => match[1]!.trim(),
            ),
          )
          .sort(),
      )
      .toEqual(expected);
  };
  const selectAndCheckNavigation = async (
    projectName: string,
    record: { id: string; nativeId: string; projectId: string },
  ) => {
    if (page.viewportSize()!.width <= 700 && !(await selector.isVisible()))
      await page.getByRole("button", { name: "☰" }).click();
    await selector.selectOption({ label: projectName });
    await assertNavigationFor(record.projectId);
    const nav = page.getByRole("navigation");
    const ownSession = nav
      .getByRole("button")
      .filter({ hasText: `Pi session ID：${record.nativeId}` });
    await ownSession.click();
    await expectPiSessionId(page, record.nativeId);
  };
  await selectAndCheckNavigation("repoA", repoA);
  await selectAndCheckNavigation("repoB", repoB);
});
