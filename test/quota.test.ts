// Quota snapshots carry several pools (short 5-hour window, longer weekly one).
// They are alternatives, not a summed budget: an account is only usable while
// every window still has headroom, so the binding window must drive routing and
// the reset countdown.

import { expect, test } from "bun:test";
import { quotaFromSnapshot } from "../src/accounts.ts";

const SHORT = { limit_usd: "1.000000", remaining_usd: "0.000000", restores_at: "2026-11-24T20:00:00Z" };
const WEEK = { limit_usd: "7.000000", remaining_usd: "6.000000", restores_at: "2026-11-30T00:00:00Z" };

test("a drained window makes the account unavailable even when another window has budget", () => {
  const quota = quotaFromSnapshot(JSON.stringify({ pools: [SHORT, WEEK] }));
  expect(quota?.remainingMicro).toBe(0);
  expect(quota?.limitMicro).toBe(1_000_000);
  // The countdown follows the binding window, not the farther-off one.
  expect(quota?.resetsAt).toBe(Date.parse("2026-11-24T20:00:00Z"));
});

test("the lowest remaining fraction is the binding window", () => {
  const quota = quotaFromSnapshot(
    JSON.stringify({
      pools: [
        { limit_usd: "1.000000", remaining_usd: "0.500000", restores_at: "2026-11-24T20:00:00Z" },
        WEEK,
      ],
    }),
  );
  expect(quota?.remainingMicro).toBe(500_000);
  expect(quota?.limitMicro).toBe(1_000_000);
});

test("a single window reports its own numbers unchanged", () => {
  const quota = quotaFromSnapshot(
    JSON.stringify({ plan: "pro", pools: [{ limit_usd: "2.000000", remaining_usd: "1.500000", restores_at: "2026-11-25T00:00:00Z" }] }),
  );
  expect(quota?.remainingMicro).toBe(1_500_000);
  expect(quota?.limitMicro).toBe(2_000_000);
  expect(quota?.resetsAt).toBe(Date.parse("2026-11-25T00:00:00Z"));
  expect(quota?.plan).toBe("pro");
  expect(quota?.binding).toBe("window");
  expect(quota?.lifetime).toBeNull();
});

test("one-time credits are reported even when the rolling windows are healthy", () => {
  // The real upstream payload: two $1 rolling windows plus a $4 lifetime pool.
  // Showing only the windows hides most of the account's actual balance.
  const quota = quotaFromSnapshot(
    JSON.stringify({
      plan: "free",
      pools: [],
      usage_windows: [
        { id: "short", label: "All models \u00b7 5-hour usage", limit_usd: "1.000000", remaining_usd: "0.999568" },
        { id: "long", label: "All models \u00b7 Weekly usage", limit_usd: "1.000000", remaining_usd: "0.999928" },
      ],
      lifetime_allowance: { limit_usd: "4.000000", used_usd: "0.000840", remaining_usd: "3.999160" },
    }),
  );

  expect(quota?.lifetime).toEqual({ remainingMicro: 3_999_160, limitMicro: 4_000_000 });
  expect(quota?.windows).toHaveLength(2);
  // Both windows are ~100% left, so the 5-hour one binds (99.9568% < 99.9928%).
  expect(quota?.binding).toBe("window");
  expect(quota?.remainingMicro).toBe(999_568);

  // A drained lifetime pool becomes the binding budget, so routing stops using
  // the account even though its rolling windows have headroom.
  const drained = quotaFromSnapshot(
    JSON.stringify({
      plan: "free",
      usage_windows: [{ limit_usd: "1.000000", remaining_usd: "0.900000" }],
      lifetime_allowance: { limit_usd: "4.000000", remaining_usd: "0.000000" },
    }),
  );
  expect(drained?.binding).toBe("lifetime");
  expect(drained?.remainingMicro).toBe(0);
});

test("usage_windows are used when pools are absent, and malformed payloads yield null", () => {
  expect(quotaFromSnapshot(JSON.stringify({ usage_windows: [{ limit_usd: "1.000000", remaining_usd: "0.250000" }] }))?.remainingMicro).toBe(250_000);
  expect(quotaFromSnapshot("{not json")).toBeNull();
  expect(quotaFromSnapshot(JSON.stringify({ plan: "free" }))).toBeNull();
});
