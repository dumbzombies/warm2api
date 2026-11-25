// Rotation, retirement and revival, driven over HTTP against three accounts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { boot, type Harness } from "./harness.ts";
import {
  getAccount,
  latestQuota,
  listAccounts,
  recordSnapshot,
  reviveAccount,
  selectAccount,
  setAccountState,
} from "../src/accounts.ts";
import { pollOnce } from "../src/poller.ts";

let h: Harness;

const RESTORES_AT = "2026-01-01T05:00:00.000Z";

function quotaBody(remaining: string): string {
  return JSON.stringify({
    plan: "pro",
    pools: [
      {
        id: "short",
        scope: "premium",
        limit_usd: "1.000000",
        remaining_usd: remaining,
        restores_at: RESTORES_AT,
      },
    ],
  });
}

async function chatOnce(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${h.config.apiKey}` },
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function resetPool(): void {
  h.upstream.reset();
  for (const account of listAccounts()) {
    reviveAccount(account.id);
    // Clear an exhausted snapshot so routing can pick the account again.
    recordSnapshot(account.id, quotaBody("1.000000"));
  }
}

beforeAll(async () => {
  h = await boot({ accounts: 3 });
});

afterAll(async () => {
  await h.close();
});

test("a 429 window-exceeded retires that account and the request still succeeds", async () => {
  resetPool();
  h.upstream.set({
    fixture: "text",
    failures: [{ status: 429, code: "usage_window_exceeded", restores_at: RESTORES_AT }],
  });

  const response = await chatOnce();
  expect(response.status).toBe(200);
  const choices = response.body.choices as Array<{ message: { content: string } }>;
  expect(choices[0]?.message.content).toBe("Hello from Warm");

  const retired = listAccounts().filter((a) => a.state === "retired");
  expect(retired.length).toBe(1);
  expect(retired[0].stateReason).toBe("usage_window_exceeded");
  expect(retired[0].stateUntil).toBe(Date.parse(RESTORES_AT));
});

test("routing sticks to one account so prefix caches keep hitting", () => {
  resetPool();
  const a = selectAccount("gpt-5.6-luna");
  const b = selectAccount("gpt-5.6-luna");
  expect(a).not.toBeNull();
  expect(b?.id).toBe(a?.id);

  recordSnapshot(a!.id, quotaBody("0.000000"));
  const c = selectAccount("gpt-5.6-luna");
  expect(c).not.toBeNull();
  expect(c?.id).not.toBe(a?.id);
});

test("an account whose snapshot shows zero remaining is skipped", () => {
  resetPool();
  const target = listAccounts()[0];
  recordSnapshot(target.id, quotaBody("0.000000"));
  expect(latestQuota(target.id)?.remainingMicro).toBe(0);

  const chosen = selectAccount("gpt-5.6-luna");
  expect(chosen).not.toBeNull();
  expect(chosen?.id).not.toBe(target.id);
});

test("the poller revives a retired account once quota refills", async () => {
  resetPool();
  const target = listAccounts()[1];
  recordSnapshot(target.id, quotaBody("0.000000"));
  setAccountState(target.id, "retired", "usage_window_exceeded", null);
  expect(getAccount(target.id)?.state).toBe("retired");

  h.upstream.set({ usage: "refilled" });
  const results = await pollOnce(h.config);
  expect(results.some((r) => r.accountId === target.id && r.revived)).toBe(true);
  expect(getAccount(target.id)?.state).toBe("active");
});

test("account_disabled fails hard and the poller never revives it", async () => {
  resetPool();
  h.upstream.set({ fixture: "text", failures: [{ status: 403, code: "account_disabled" }] });

  const response = await chatOnce();
  expect(response.status).toBe(403);
  const error = response.body.error as { code: string };
  expect(error.code).toBe("account_disabled");

  const disabled = listAccounts().filter((a) => a.state === "disabled");
  expect(disabled.length).toBe(1);

  h.upstream.set({ usage: "refilled" });
  await pollOnce(h.config);
  expect(getAccount(disabled[0].id)?.state).toBe("disabled");
});

test("an exhausted pool returns 502 no_usable_account", async () => {
  resetPool();
  h.upstream.set({ fixture: "text", alwaysFail: { status: 429, code: "usage_window_exceeded" } });

  const response = await chatOnce();
  expect(response.status).toBe(502);
  const error = response.body.error as { code: string; type: string; message: string };
  expect(error.code).toBe("no_usable_account");
  expect(error.type).toBe("api_error");
  expect(error.message).toBe("no usable Warm account");
});
