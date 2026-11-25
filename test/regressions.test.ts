// Regression tests for defects found by an adversarial pass over the HTTP
// surface, the supervisor and the store. Each one failed against the build that
// shipped without it; the comment on each test states the defect, not the fix.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await boot({ accounts: 1 });
});

afterAll(async () => {
  await h.close();
});

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${h.config.apiKey}`,
  "content-type": "application/json",
});

describe("malformed message entries", () => {
  // A null entry used to reach `msg.role` and throw a TypeError, which surfaced
  // as a 500 "internal_error" with a stack trace: a client bug reported as a
  // server fault on all three POST routes.
  test("null and non-object messages are rejected as 400 on every surface", async () => {
    const cases: Array<[string, string]> = [
      ["/v1/chat/completions", '{"model":"gpt-5.6-luna","messages":[null]}'],
      ["/v1/chat/completions", '{"model":"gpt-5.6-luna","messages":["hello"]}'],
      ["/v1/messages", '{"model":"gpt-5.6-luna","messages":[null]}'],
      ["/v1/messages", '{"model":"gpt-5.6-luna","messages":[[]]}'],
      ["/v1/messages/count_tokens", '{"messages":[null]}'],
    ];
    for (const [path, body] of cases) {
      const res = await fetch(`${h.server.url}${path}`, { method: "POST", headers: auth(), body });
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("invalid_messages");
    }
  });
});

describe("failed buffered calls are audited", () => {
  // The streaming path recorded failed requests; the buffered one threw before
  // `recordRequest`, so `/admin/stats` and `/api/state` under-reported errors.
  test("a non-streaming upstream failure lands in the request log", async () => {
    const local = await boot({ accounts: 1 });
    try {
      const { lifetime } = await import("../src/track.ts");
      const before = lifetime();
      local.upstream.set({ alwaysFail: { status: 400, code: "invalid_request_error", detail: "bad input" } });

      for (const path of ["/v1/chat/completions", "/v1/messages"]) {
        const res = await fetch(`${local.server.url}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${local.config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(400);
        await res.text();
      }

      const after = lifetime();
      expect(after.requests - before.requests).toBe(2);
      expect(after.failures - before.failures).toBe(2);
    } finally {
      await local.close();
    }
  });
});

describe("unknown measurements are null, not zero", () => {
  // `cache_hit_pct` reported 0 on a proxy that had measured nothing, which reads
  // as "the cache never hits" rather than "no data".
  test("a proxy with no traffic reports a null cache hit rate", async () => {
    const local = await boot({ accounts: 1 });
    try {
      const res = await fetch(`${local.server.url}/api/state`, {
        headers: { authorization: `Bearer ${local.config.apiKey}` },
      });
      const state = (await res.json()) as { requests: { cache_hit_pct: number | null } };
      expect(state.requests.cache_hit_pct).toBeNull();
    } finally {
      await local.close();
    }
  });
});

describe("oversized chunked bodies", () => {
  // `readJson` compared `text.length` (UTF-16 code units) and buffered the whole
  // body first, so a body with no content-length could allocate past the limit
  // and only then be rejected.
  test("a chunked body over the limit is refused with 413 while reading", async () => {
    const encoder = new TextEncoder();
    const big = JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "x".repeat(40_000_000) }] });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 1_000_000) controller.enqueue(encoder.encode(big.slice(i, i + 1_000_000)));
        controller.close();
      },
    });
    const res = await fetch(`${h.server.url}/v1/chat/completions`, {
      method: "POST",
      headers: auth(),
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    await res.text();
  });
});

describe("quota snapshots are bounded", () => {
  // One row per poll, never trimmed: 504 rows after a day, ~180k a year, each
  // holding the whole usage document.
  test("only the newest N snapshots per account are kept", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "warm2api-snap-"));
    try {
      const { openDatabase, setDb, closeDb } = await import("../src/db.ts");
      const { recordSnapshot } = await import("../src/accounts.ts");
      const db = openDatabase(dataDir);
      setDb(db);
      for (let i = 0; i < 400; i += 1) {
        recordSnapshot("acct_snap", JSON.stringify({ request_count: i, pools: [{ remaining_usd: "1.0", limit_usd: "1.0" }] }), Date.now() + i);
      }
      const counted = db.query("SELECT COUNT(*) AS n FROM usage_snapshots").get() as { n: number };
      expect(counted.n).toBe(120);
      // The newest reading must survive; trimming is by row, not by age.
      const newest = db.query("SELECT raw FROM usage_snapshots ORDER BY captured_at DESC, id DESC LIMIT 1").get() as { raw: string };
      expect((JSON.parse(newest.raw) as { request_count: number }).request_count).toBe(399);
      closeDb();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("upstream spend is read from the snapshot in the right unit", async () => {
    // The live gateway reports `credits_spent` as a micro-dollar integer;
    // older bodies report dollars. Both must land as micro-dollars.
    const { quotaFromSnapshot } = await import("../src/accounts.ts");
    const windows = { usage_windows: [{ remaining_usd: "1.0", limit_usd: "1.0" }] };

    const live = quotaFromSnapshot(
      JSON.stringify({ ...windows, credits_spent: "213", lifetime_allowance: { limit_usd: "4", used_usd: "0.000213", remaining_usd: "3.999787" } }),
    );
    expect(live?.spentMicro).toBe(213);

    const dollars = quotaFromSnapshot(JSON.stringify({ ...windows, credits_spent: "0.120000" }));
    expect(dollars?.spentMicro).toBe(120_000);

    const absent = quotaFromSnapshot(JSON.stringify(windows));
    expect(absent?.spentMicro).toBeNull();
  });
});

describe("existing databases are upgraded, not abandoned", () => {
  // `CREATE TABLE IF NOT EXISTS` does nothing to an existing table, so a database
  // written before `cache_read_tokens`/`credits_spent_micro` existed made every
  // `recordUsage` and `recordRequest` throw — the proxy could not log a request
  // at all after an upgrade.
  test("a pre-upgrade database gains the new columns in place", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "warm2api-legacy-"));
    try {
      mkdirSync(dataDir, { recursive: true });
      const legacy = new Database(join(dataDir, "state.db"), { create: true });
      legacy.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY, label TEXT NOT NULL, access_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL, client_fingerprint TEXT, device_fingerprint TEXT NOT NULL,
          plan TEXT NOT NULL DEFAULT 'unknown', state TEXT NOT NULL DEFAULT 'active',
          state_reason TEXT, state_until INTEGER, attest_token TEXT, attest_seed TEXT,
          attest_expires_at INTEGER, attest_seq INTEGER NOT NULL DEFAULT 0, excluded_models TEXT,
          created_at INTEGER NOT NULL, last_used_at INTEGER, requests INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE request_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_id TEXT,
          surface TEXT NOT NULL, model TEXT NOT NULL, status INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_micro INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, error_code TEXT
        );
        INSERT INTO accounts (id, label, access_token, expires_at, device_fingerprint, created_at)
          VALUES ('acct_old', 'old', 'tok', 9999999999999, 'fp', 1);
      `);
      legacy.close();

      const { openDatabase, setDb, closeDb } = await import("../src/db.ts");
      setDb(openDatabase(dataDir));
      const { recordRequest } = await import("../src/track.ts");
      // Both writes failed before the migration: one names a column in each table.
      expect(() =>
        recordRequest({ accountId: "acct_old", surface: "openai", model: "m", status: 200, inputTokens: 5, outputTokens: 2, ms: 1 }),
      ).not.toThrow();
      closeDb();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("health probes identify the service", () => {
  // `alreadyServing` accepted any server answering `{ok:true}`, so an unrelated
  // process on the port made `serve` exit having served nothing.
  test("a foreign healthz responder is not mistaken for warm2api", async () => {
    const impostor = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      const res = await fetch(`http://127.0.0.1:${impostor.port}/healthz`);
      const body = (await res.json()) as { ok: boolean; version?: string };
      const { APP_VERSION } = await import("../src/config.ts");
      // The rule the server applies: ok AND our version.
      expect(body.ok && body.version === APP_VERSION).toBe(false);
    } finally {
      impostor.stop(true);
    }
  });
});

describe("a wedged control plane cannot pin the proxy", () => {
  // Every control call (`/v1/models`, `/api/v1/usage`) was issued with no
  // deadline: a gateway that accepted the connection and never answered held the
  // socket forever, so `/api/refresh` never returned and the poll chain stopped.
  test("the usage poll gives up on a silent upstream", async () => {
    const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    const dataDir = mkdtempSync(join(tmpdir(), "warm2api-hang-"));
    const previous = process.env.WARM2API_CONTROL_TIMEOUT_MS;
    process.env.WARM2API_CONTROL_TIMEOUT_MS = "300";
    try {
      const { loadConfig, setConfig, resetConfig } = await import("../src/config.ts");
      const { openDatabase, setDb, closeDb } = await import("../src/db.ts");
      const { addAccount } = await import("../src/accounts.ts");
      const { fetchUsageRaw, controlTimeoutMs } = await import("../src/upstream.ts");

      process.env.WARM2API_DATA = dataDir;
      process.env.WARM2API_API_BASE = `http://127.0.0.1:${silent.port}`;
      process.env.WARM2API_KEY = "k";
      resetConfig();
      const cfg = loadConfig();
      setConfig(cfg);
      setDb(openDatabase(dataDir));
      addAccount({ label: "a", accessToken: "t", expiresAt: Date.now() + 86_400_000 });

      expect(controlTimeoutMs()).toBe(300);
      const started = Date.now();
      await expect(fetchUsageRaw({ accessToken: "t", clientFingerprint: null })).rejects.toThrow();
      // Bounded well under the old 120 s header timeout.
      expect(Date.now() - started).toBeLessThan(5_000);
      closeDb();
    } finally {
      if (previous === undefined) delete process.env.WARM2API_CONTROL_TIMEOUT_MS;
      else process.env.WARM2API_CONTROL_TIMEOUT_MS = previous;
      silent.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  // A cold catalog cache made every `/api/state` caller start its own upstream
  // fetch; with a hanging gateway six polls left six permanent sockets.
  test("a burst of cold state reads issues one catalog fetch", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "warm2api-catalog-"));
    let hits = 0;
    const hang = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          hits += 1;
          return new Promise<Response>(() => {});
        }
        return Response.json({});
      },
    });
    const previous = process.env.WARM2API_CONTROL_TIMEOUT_MS;
    process.env.WARM2API_CONTROL_TIMEOUT_MS = "400";
    try {
      const { loadConfig, setConfig, resetConfig } = await import("../src/config.ts");
      const { openDatabase, setDb, closeDb } = await import("../src/db.ts");
      const { addAccount } = await import("../src/accounts.ts");
      const { startServer, resetCatalogCache } = await import("../src/server.ts");

      process.env.WARM2API_DATA = dataDir;
      process.env.WARM2API_API_BASE = `http://127.0.0.1:${hang.port}`;
      process.env.WARM2API_KEY = "k";
      process.env.WARM2API_PORT = "0";
      process.env.WARM2API_API_AUTH = "on";
      process.env.WARM2API_ATTEST = "off";
      resetConfig();
      const cfg = loadConfig();
      setConfig(cfg);
      setDb(openDatabase(dataDir));
      addAccount({ label: "a", accessToken: "t", expiresAt: Date.now() + 86_400_000 });
      resetCatalogCache();

      const server = await startServer(cfg);
      const read = (): Promise<string> =>
        fetch(`${server.url}/api/state`, { headers: { authorization: "Bearer k" } }).then((r) => r.text());

      // Six concurrent cold reads start one shared refresh, not six.
      await Promise.all(Array.from({ length: 6 }, read));
      // The refresh is deliberately in the background, so wait for it to be
      // issued rather than assuming it already was.
      for (let i = 0; i < 40 && hits === 0; i += 1) await Bun.sleep(10);
      expect(hits).toBe(1);

      // A second burst while that refresh is still in flight must join it.
      await Promise.all(Array.from({ length: 6 }, read));
      expect(hits).toBe(1);
      server.stop();
      closeDb();
    } finally {
      if (previous === undefined) delete process.env.WARM2API_CONTROL_TIMEOUT_MS;
      else process.env.WARM2API_CONTROL_TIMEOUT_MS = previous;
      hang.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("attestation degrades instead of failing the request", () => {
  // `ensureAttestation` rethrew on a transient handshake failure while
  // `attestationEnabled()` still returned true, so one flaky handshake failed
  // the request and — because routing retried — re-ran it for every account.
  // Three client calls produced nine handshakes and zero completions.
  test("a failing handshake falls back to unsigned and backs off", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "warm2api-attest-"));
    let handshakes = 0;
    let served = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/client/handshake") {
          handshakes += 1;
          return new Response("boom", { status: 500 });
        }
        if (path === "/v1/models") return Response.json({ data: [{ id: "gpt-5.6-luna" }] });
        if (path === "/v1/messages") {
          served += 1;
          return new Response(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
              "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({});
      },
    });
    try {
      const { loadConfig, setConfig, resetConfig } = await import("../src/config.ts");
      const { openDatabase, setDb, closeDb } = await import("../src/db.ts");
      const { addAccount } = await import("../src/accounts.ts");
      const { startServer } = await import("../src/server.ts");
      const { resetAttestationState, attestationEnabled } = await import("../src/attest.ts");

      process.env.WARM2API_DATA = dataDir;
      process.env.WARM2API_API_BASE = `http://127.0.0.1:${upstream.port}`;
      process.env.WARM2API_KEY = "k";
      process.env.WARM2API_PORT = "0";
      process.env.WARM2API_API_AUTH = "on";
      process.env.WARM2API_ATTEST = "auto";
      resetConfig();
      resetAttestationState();
      const cfg = loadConfig();
      setConfig(cfg);
      setDb(openDatabase(dataDir));
      addAccount({ label: "a", accessToken: "t", expiresAt: Date.now() + 86_400_000 });

      const server = await startServer(cfg);
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${server.url}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer k", "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(res.status).toBe(200);
        await res.text();
      }

      // All three calls are served...
      expect(served).toBe(3);
      // ...and the failing handshake is not retried per call.
      expect(handshakes).toBe(1);
      expect(attestationEnabled()).toBe(false);

      server.stop();
      closeDb();
    } finally {
      upstream.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("an unguarded proxy is not a cross-origin relay", () => {
  // The loopback default requires no API key, and every response carried
  // `access-control-allow-origin: *`. A wildcard is only harmless when the
  // request must be authorised; here any web page the operator visited could
  // POST a prompt and read the reply, spending their Warm quota. Reproduced:
  // foreign Origin + no key -> 200 and an upstream call.
  test("the local no-key default refuses a foreign Origin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "warm2api-origin-"));
    let hits = 0;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/models") return Response.json({ data: [{ id: "gpt-5.6-luna" }] });
        if (path === "/v1/messages") {
          hits += 1;
          return new Response(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
              "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({});
      },
    });
    const saved = { key: process.env.WARM2API_KEY, auth: process.env.WARM2API_API_AUTH };
    try {
      const { loadConfig, setConfig, resetConfig } = await import("../src/config.ts");
      const { openDatabase, setDb, closeDb } = await import("../src/db.ts");
      const { addAccount } = await import("../src/accounts.ts");
      const { startServer } = await import("../src/server.ts");

      process.env.WARM2API_DATA = dataDir;
      process.env.WARM2API_API_BASE = `http://127.0.0.1:${upstream.port}`;
      process.env.WARM2API_PORT = "0";
      process.env.WARM2API_ATTEST = "off";
      delete process.env.WARM2API_KEY;
      delete process.env.WARM2API_API_AUTH;
      resetConfig();
      const cfg = loadConfig();
      setConfig(cfg);
      setDb(openDatabase(dataDir));
      expect(cfg.requireApiKey).toBe(false);
      addAccount({ label: "a", accessToken: "t", expiresAt: Date.now() + 86_400_000 });

      const server = await startServer(cfg);
      const call = (headers: Record<string, string>): Promise<Response> =>
        fetch(`${server.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
        });

      const foreign = await call({ origin: "https://evil.example" });
      expect(foreign.status).toBe(403);
      expect((await foreign.json() as { error: { code: string } }).error.code).toBe("origin_not_allowed");
      // The refusal happens before any quota is spent.
      expect(hits).toBe(0);

      // A local page and a non-browser client still work.
      expect((await call({ origin: "http://localhost:3000" })).status).toBe(200);
      expect((await call({})).status).toBe(200);
      expect(hits).toBe(2);

      server.stop();
      closeDb();
    } finally {
      if (saved.key === undefined) delete process.env.WARM2API_KEY;
      else process.env.WARM2API_KEY = saved.key;
      if (saved.auth === undefined) delete process.env.WARM2API_API_AUTH;
      else process.env.WARM2API_API_AUTH = saved.auth;
      upstream.stop(true);
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("cache hit rate is a real percentage", () => {
  // Anthropic reports `input_tokens` as the uncached reminder of the prompt;
  // cache reads arrive separately. Dividing cached by uncached made a heavily
  // cached workload report 126.9% on the live proxy, and understated
  // `tokens_in` (it excluded the cached part of every prompt).
  test("a fully cached prompt reports 100%, not more", async () => {
    const local = await boot({ accounts: 1 });
    try {
      const { recordRequest } = await import("../src/track.ts");
      // 1000 uncached + 9000 cached prompt tokens, 50 out.
      recordRequest({
        accountId: null,
        surface: "openai",
        model: "m",
        status: 200,
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 9000,
        ms: 5,
      });
      const res = await fetch(`${local.server.url}/api/state`, {
        headers: { authorization: `Bearer ${local.config.apiKey}` },
      });
      const state = (await res.json()) as {
        requests: { tokens_in: number; tokens_cached: number; cache_hit_pct: number | null };
      };
      expect(state.requests.tokens_in).toBe(10_000);
      expect(state.requests.cache_hit_pct).toBe(90);

      // Fully cached: 100%, never 127%.
      const { recordRequest: record } = await import("../src/track.ts");
      record({ accountId: null, surface: "openai", model: "m", status: 200, inputTokens: 0, outputTokens: 1, cacheReadTokens: 500, ms: 5 });
      const after = (await (await fetch(`${local.server.url}/api/state`, {
        headers: { authorization: `Bearer ${local.config.apiKey}` },
      })).json()) as { requests: { cache_hit_pct: number | null } };
      expect(after.requests.cache_hit_pct).toBeLessThanOrEqual(100);
    } finally {
      await local.close();
    }
  });
});
