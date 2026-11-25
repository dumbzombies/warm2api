// Control-plane surface: `/api/state`, `/api/refresh` and the one-api billing
// pair. These are what the quota script, the agent plugins and `hermes usage`
// read, so the shapes and the arithmetic are the contract.
//
// The absent-snapshot case matters most: reporting 0% used for a pool nobody has
// measured would make every consumer claim a fully unspent budget.

import { expect, test } from "bun:test";
import { boot } from "./harness.ts";

const key = "test-local-key";
const auth = { authorization: `Bearer ${key}` };

interface Pool {
  accounts: number;
  limit_usd: number | null;
  remaining_usd: number | null;
  used_usd: number | null;
  used_percent: number | null;
  binding_label: string | null;
  resets_at: string | null;
}

interface State {
  ok: boolean;
  version: string;
  mode: string;
  uptime_s: number;
  accounts: { total: number; list: unknown[] };
  pool: Pool;
  requests: { total: number; errors: number; cache_hit_pct: number };
  models: string[];
}

interface Subscription {
  object: string;
  hard_limit_usd: number;
  soft_limit_usd: number;
  system_hard_limit_usd: number;
  remaining_usd: number | null;
  used_usd: number | null;
  currency: string;
}

interface Usage {
  object: string;
  total_usage: number;
  daily_costs: unknown[];
  limit_usd: number | null;
  remaining_usd: number | null;
  used_usd: number | null;
  used_percent: number | null;
  resets_at: string | null;
  period: { start: string | null; end: string | null };
}

/** Typed boundary read: `res.json()` is untyped, the caller validates fields. */
async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("/api/state reports the pool, counts and models", async () => {
  const h = await boot({ accounts: 2 });
  try {
    await fetch(`${h.server.url}/admin/poll`, { method: "POST", headers: auth });
    const res = await fetch(`${h.server.url}/api/state`, { headers: auth });
    expect(res.status).toBe(200);
    const state = await read<State>(res);

    expect(state.ok).toBe(true);
    expect(state.accounts.total).toBe(2);
    expect(state.accounts.list).toHaveLength(2);
    // The fake upstream reports $1 per account → $2 of pool capacity.
    expect(state.pool.accounts).toBe(2);
    expect(state.pool.limit_usd).toBe(2);
    expect(state.pool.remaining_usd).toBe(2);
    expect(state.pool.used_percent).toBe(0);
    expect(state.models.length).toBeGreaterThan(0);
    expect(typeof state.uptime_s).toBe("number");
  } finally {
    await h.close();
  }
});

test("/api/state needs the key on a guarded proxy", async () => {
  const h = await boot({ accounts: 1 });
  try {
    expect((await fetch(`${h.server.url}/api/state`)).status).toBe(401);
  } finally {
    await h.close();
  }
});

test("a pool with no snapshot reports null, never zero percent", async () => {
  // No poll: the accounts exist but the gateway was never asked.
  const h = await boot({ accounts: 1 });
  try {
    const state = await read<State>(await fetch(`${h.server.url}/api/state`, { headers: auth }));
    expect(state.pool.accounts).toBe(0);
    expect(state.pool.used_percent).toBeNull();
    expect(state.pool.limit_usd).toBeNull();
  } finally {
    await h.close();
  }
});

test("billing endpoints speak one-api, in cents, at both prefixes", async () => {
  const h = await boot({ accounts: 2 });
  try {
    await fetch(`${h.server.url}/admin/poll`, { method: "POST", headers: auth });

    for (const prefix of ["", "/v1"]) {
      const subscription = await read<Subscription>(
        await fetch(`${h.server.url}${prefix}/dashboard/billing/subscription`, { headers: auth }),
      );
      expect(subscription.object).toBe("billing_subscription");
      // All three hard limits carry the pool capacity so readers agree.
      expect(subscription.hard_limit_usd).toBe(2);
      expect(subscription.soft_limit_usd).toBe(2);
      expect(subscription.system_hard_limit_usd).toBe(2);
      expect(subscription.remaining_usd).toBe(2);
      expect(subscription.used_usd).toBe(0);
      expect(subscription.currency).toBe("USD");

      const usage = await read<Usage>(
        await fetch(`${h.server.url}${prefix}/dashboard/billing/usage?start_date=2026-01-01`, { headers: auth }),
      );
      expect(usage.object).toBe("list");
      // CENTS: 0 USD spent is 0; the field must still exist and be a number.
      expect(usage.total_usage).toBe(0);
      expect(usage.daily_costs).toEqual([]);
      expect(usage.period.start).toBe("2026-01-01");
    }
  } finally {
    await h.close();
  }
});

test("a second account joins the pool only once it has a snapshot", async () => {
  const h = await boot({ accounts: 1 });
  try {
    await fetch(`${h.server.url}/admin/poll`, { method: "POST", headers: auth });
    const add = await fetch(`${h.server.url}/admin/accounts`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ accessToken: "tok_spend", label: "spend@example.com" }),
    });
    expect(add.status).toBe(201);

    // Unpolled: the new row has no measured budget, so capacity stays at $1.
    const before = await read<Usage>(await fetch(`${h.server.url}/dashboard/billing/usage`, { headers: auth }));
    expect(before.limit_usd).toBe(1);

    await fetch(`${h.server.url}/admin/poll`, { method: "POST", headers: auth });
    const after = await read<Usage>(await fetch(`${h.server.url}/dashboard/billing/usage`, { headers: auth }));
    expect(after.limit_usd).toBe(2);
    expect(after.total_usage).toBe(0);
  } finally {
    await h.close();
  }
});

test("/api/refresh re-polls and returns fresh state", async () => {
  const h = await boot({ accounts: 1 });
  try {
    const before = await read<State>(await fetch(`${h.server.url}/api/state`, { headers: auth }));
    expect(before.pool.accounts).toBe(0);

    const res = await fetch(`${h.server.url}/api/refresh`, { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    const after = await read<State & { polled: unknown }>(res);
    expect(after.pool.accounts).toBe(1);
    expect(after.pool.limit_usd).toBe(1);
    expect(Array.isArray(after.polled)).toBe(true);
  } finally {
    await h.close();
  }
});

test("billing and state reject writes instead of 404ing", async () => {
  const h = await boot({ accounts: 1 });
  try {
    expect((await fetch(`${h.server.url}/dashboard/billing/usage`, { method: "POST", headers: auth })).status).toBe(405);
    expect((await fetch(`${h.server.url}/api/state`, { method: "POST", headers: auth })).status).toBe(405);
    expect((await fetch(`${h.server.url}/v1/dashboard/billing/usage`, { method: "POST", headers: auth })).status).toBe(
      405,
    );
  } finally {
    await h.close();
  }
});

test("billing answers a preflight like the rest of the API", async () => {
  const h = await boot({ accounts: 1 });
  try {
    const res = await fetch(`${h.server.url}/dashboard/billing/subscription`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  } finally {
    await h.close();
  }
});
