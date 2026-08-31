import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchUsageWithMeta, invalidateAnthropicQuotaUsage } from "./oauth";

describe("Anthropic usage cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches usage again after the token cache is invalidated", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ five_hour: { utilization: 10, resets_at: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const accessToken = "sk-ant-oat01-cache-test-unique";

    await fetchUsageWithMeta(accessToken);
    await fetchUsageWithMeta(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateAnthropicQuotaUsage(accessToken);
    await fetchUsageWithMeta(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
