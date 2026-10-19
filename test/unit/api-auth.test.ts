import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../src/web/api.js";

const browserEvents = new EventTarget();
const windowStub = {
  dispatchEvent: browserEvents.dispatchEvent.bind(browserEvents),
};

describe("API authentication expiry notifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    browserEvents.removeEventListener("prw-auth-expired", onExpired);
  });

  let expiredCount = 0;
  const onExpired = () => {
    expiredCount++;
  };

  async function unauthorizedFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("window", windowStub);
    expiredCount = 0;
    browserEvents.addEventListener("prw-auth-expired", onExpired);
  }

  it("does not notify for an anonymous bootstrap probe and still rejects", async () => {
    await unauthorizedFetch();
    await expect(api.me(false)).rejects.toMatchObject({ status: 401 });
    expect(expiredCount).toBe(0);
  });

  it("notifies for the default me check and still rejects", async () => {
    await unauthorizedFetch();
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(expiredCount).toBe(1);
  });

  it("notifies for operation 401 responses and still rejects", async () => {
    await unauthorizedFetch();
    await expect(
      api.operation("session-id", { kind: "prompt", text: "hello" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(expiredCount).toBe(1);
  });
});
