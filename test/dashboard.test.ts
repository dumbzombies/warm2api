// The dashboard is a real surface: auth gate, cookie shortcut, device login and
// live quota, all exercised over HTTP against the fake upstream.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { boot, type Harness } from "./harness.ts";
import { latestQuota, listAccounts } from "../src/accounts.ts";

let h: Harness;

beforeAll(async () => {
  h = await boot({ accounts: 0 });
});

afterAll(async () => {
  await h.close();
});

test("the dashboard ships as a self-contained mobile document", async () => {
  const res = await fetch(`${h.server.url}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1');
  expect(html).toContain("safe-area-inset-bottom");
  expect(html).toContain("Add a Warm account");
  expect(html).toContain("Refresh quotas");
  // Tabs and the catalog view must be part of the shell, not a separate page.
  expect(html).toContain('id="tab-models"');
  expect(html).toContain('id="panel-models"');
  expect(html).toContain("Model catalog");
  // No external assets or fonts: the dashboard must work offline on loopback.
  expect(html.includes('src="http') || html.includes('href="http')).toBe(false);
});

test("the dashboard is a real asset file, served intact", async () => {
  // The UI lives in src/ui.html (read at startup, like the template this repo
  // follows) rather than inside a template literal. If packaging drops it the
  // proxy must still answer, but with the fallback page, so pin the real one.
  const { readFileSync } = await import("node:fs");
  const file = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  expect(file.length).toBeGreaterThan(30_000);
  expect(file.startsWith("<!doctype html>")).toBe(true);
  expect(file.trimEnd().endsWith("</html>")).toBe(true);

  const html = await (await fetch(`${h.server.url}/`)).text();
  expect(html).toBe(file);
  expect(html.includes("assets missing")).toBe(false);
});

test("the dashboard can be hidden per request with ?dash=0", async () => {
  const res = await fetch(`${h.server.url}/?dash=0`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { dashboard: string; api: string[] };
  expect(body.dashboard).toBe("off");
  expect(body.api).toContain("/v1/chat/completions");
});

test("admin data is gated, and a key link unlocks it with a cookie", async () => {
  expect((await fetch(`${h.server.url}/admin/accounts`)).status).toBe(401);
  expect((await fetch(`${h.server.url}/?key=wrong`)).status).toBe(401);

  const unlock = await fetch(`${h.server.url}/?key=${h.config.apiKey}`, { redirect: "manual" });
  expect(unlock.status).toBe(302);
  expect(unlock.headers.get("location")).toBe("/");
  const cookie = unlock.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("warm2api_key=");
  expect(cookie).toContain("HttpOnly");

  const list = await fetch(`${h.server.url}/admin/accounts`, {
    headers: { cookie: `warm2api_key=${encodeURIComponent(h.config.apiKey)}` },
  });
  expect(list.status).toBe(200);
  const body = (await list.json()) as { accounts: unknown[] };
  expect(Array.isArray(body.accounts)).toBe(true);
});

test("device login from the dashboard creates an account with a quota snapshot", async () => {
  const start = await fetch(`${h.server.url}/admin/login`, {
    method: "POST",
    headers: { "x-api-key": h.config.apiKey },
  });
  expect(start.status).toBe(200);
  const session = (await start.json()) as { id: string; status: string; user_code?: string; verification_uri?: string };
  expect(session.status).toBe("pending");
  expect(session.id).toMatch(/^[a-f0-9]{18}$/);
  expect(session.user_code).toBe("TESTCODE");
  expect(session.verification_uri).toContain("warm.run/device");

  // The delay lives inside the server's device-flow polling loop; there is no
  // injectable clock on that boundary, so watch the deadline instead.
  let view: { status: string; account_id?: string; label?: string } = { status: "pending" };
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    const res = await fetch(`${h.server.url}/admin/login/${session.id}`, {
      headers: { "x-api-key": h.config.apiKey },
    });
    view = (await res.json()) as { status: string; account_id?: string; label?: string };
    if (view.status !== "pending") break;
  }
  expect(view.status).toBe("complete");
  expect(view.account_id).toBeString();

  const account = listAccounts().find((a) => a.id === view.account_id);
  expect(account).toBeDefined();
  expect(account?.state).toBe("active");
  expect(latestQuota(String(view.account_id))?.remainingMicro).toBe(1_000_000);

  const unknown = await fetch(`${h.server.url}/admin/login/deadbeef`, {
    headers: { "x-api-key": h.config.apiKey },
  });
  expect(unknown.status).toBe(404);
});

test("refresh quotas runs the poller and reports per-account results", async () => {
  h.upstream.set({ usage: "refilled" });
  const res = await fetch(`${h.server.url}/admin/poll`, {
    method: "POST",
    headers: { "x-api-key": h.config.apiKey },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: Array<{ accountId: string; ok: boolean; remainingMicro: number }> };
  expect(body.results.length).toBe(listAccounts().length);
  expect(body.results.every((r) => r.ok)).toBe(true);
  expect(body.results[0].remainingMicro).toBe(1_000_000);
});

test("the account list carries the live quota fields the dashboard renders", async () => {
  const res = await fetch(`${h.server.url}/admin/accounts`, { headers: { "x-api-key": h.config.apiKey } });
  const body = (await res.json()) as {
    accounts: Array<{ remaining_usd: number | null; limit_usd: number | null; resets_at: string | null; state: string }>;
  };
  const account = body.accounts[0];
  expect(account.remaining_usd).toBe(1);
  expect(account.limit_usd).toBe(1);
  expect(account.resets_at).toBeString();
  expect(account.state).toBe("active");
});

test("the model catalog is served to the dashboard with context and prices", async () => {
  const res = await fetch(`${h.server.url}/admin/models`, { headers: { "x-api-key": h.config.apiKey } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    models: Array<{ id: string; context: number; input_per_m: number | null; output_per_m: number | null }>;
  };
  const ids = body.models.map((m) => m.id);
  expect(ids).toContain("gpt-5.6-luna");
  for (const id of h.upstream.behaviour.models) expect(ids).toContain(id);
  const opus = body.models.find((m) => m.id === "claude-opus-4-8");
  expect(opus?.context).toBe(200_000);
  expect(opus?.input_per_m).toBe(15);
  expect(opus?.output_per_m).toBe(75);
});

test("an active account can be removed from the dashboard", async () => {
  const extra = h.addAccount("duplicate@example.com");
  const before = listAccounts().length;
  const res = await fetch(`${h.server.url}/admin/accounts/${extra.id}`, {
    method: "DELETE",
    headers: { "x-api-key": h.config.apiKey },
  });
  expect(res.status).toBe(200);
  expect(listAccounts().length).toBe(before - 1);
  expect(listAccounts().some((a) => a.id === extra.id)).toBe(false);
});

test("malformed percent-escapes in cookies and paths never become 500s", async () => {
  // A cookie value reaches the decoder before auth runs: it must not throw.
  const badCookie = await fetch(`${h.server.url}/admin/accounts`, {
    headers: { cookie: "warm2api_key=%zz" },
  });
  expect(badCookie.status).toBe(401);
  expect(((await badCookie.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");

  // A malformed id is simply unknown, not an internal error.
  for (const [path, method] of [
    [`/admin/accounts/%zz`, "DELETE"],
    [`/admin/accounts/%E0%A4%A/revive`, "POST"],
    [`/admin/login/%zz`, "GET"],
  ] as const) {
    const res = await fetch(`${h.server.url}${path}`, { method, headers: { "x-api-key": h.config.apiKey } });
    expect(res.status).toBe(404);
  }

  // A bad cookie must not shadow a valid header credential.
  const both = await fetch(`${h.server.url}/admin/accounts`, {
    headers: { cookie: "warm2api_key=%zz", "x-api-key": h.config.apiKey },
  });
  expect(both.status).toBe(200);
});
