// A deterministic stand-in for api.keelcode.ai. No test may touch the real API:
// every byte here is scripted, and every request is recorded for assertions.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Failure {
  status: number;
  code: string;
  restores_at?: string;
  detail?: string;
}

export type UsageMode = "fresh" | "spent" | "refilled";

export interface Behaviour {
  fixture: string;
  usage: UsageMode;
  models: string[];
  failures: Failure[];
  alwaysFail: Failure | null;
}

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  raw: string;
}

export interface FakeUpstream {
  url: string;
  port: number;
  requests: Recorded[];
  messages: Recorded[];
  behaviour: Behaviour;
  set(patch: Partial<Behaviour>): void;
  reset(): void;
  close(): Promise<void>;
}

const FIXTURES = join(import.meta.dir, "fixtures");

function usageBody(mode: UsageMode): unknown {
  const remaining = mode === "spent" ? "0.000000" : "1.000000";
  const window = {
    id: "short",
    scope: "premium",
    label: "Premium",
    hours: 5,
    limit_usd: "1.000000",
    used_usd: mode === "spent" ? "1.000000" : "0.000000",
    reserved_usd: "0.000000",
    remaining_usd: remaining,
    restores_at: "2026-01-01T05:00:00.000Z",
    merges: 0,
  };
  return {
    request_count: 3,
    input_tokens: "1200",
    output_tokens: "800",
    credits_spent: "0.120000",
    plan: "pro",
    period: { starts_at: "2026-01-01T00:00:00.000Z", resets_at: "2026-01-01T05:00:00.000Z" },
    pools: [window],
    usage_windows: [window],
    window_merges: { enabled: true, allowed: 2, used: 0, remaining: 2, next_available_at: null },
    capacity: [{ model: "gpt-5.6-luna", share: 1.0 }],
    entitlement: null,
    free_launch: { state: "active", models: ["gpt-5.6-luna"] },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    data += chunk;
  });
  req.on("end", () => resolve(data));
  req.on("error", reject);
  return promise;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startFakeUpstream(patch: Partial<Behaviour> = {}): Promise<FakeUpstream> {
  const behaviour: Behaviour = {
    fixture: "text",
    usage: "fresh",
    models: ["gpt-5.6-luna", "kimi-k2.6", "glm-5.2", "claude-opus-4-8"],
    failures: [],
    alwaysFail: null,
    ...patch,
  };
  const requests: Recorded[] = [];
  const messages: Recorded[] = [];
  let issued = 0;
  let pendingPolls = 0;
  const state = { usageCalls: 0 };

  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const url = new URL(req.url ?? "/", "http://localhost");
      let body: Record<string, unknown> | null = null;
      if (raw.trim().length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
          }
        } catch {
          body = null;
        }
      }
      const record: Recorded = { method: req.method ?? "GET", path: url.pathname, headers: req.headers, body, raw };
      requests.push(record);

      const bearer = typeof req.headers.authorization === "string" ? req.headers.authorization : "";

      if (url.pathname === "/api/auth/device/code" && req.method === "POST") {
        sendJson(res, 200, {
          device_code: "device-code-1",
          user_code: "TESTCODE",
          verification_uri: "https://warm.run/device",
          verification_uri_complete: "https://warm.run/device?user_code=TESTCODE",
          expires_in: 600,
          interval: 1,
        });
        return;
      }

      if (url.pathname === "/api/auth/device/token" && req.method === "POST") {
        pendingPolls += 1;
        if (pendingPolls === 1) {
          sendJson(res, 400, { error: "authorization_pending" });
          return;
        }
        issued += 1;
        sendJson(res, 200, {
          access_token: `tok_${issued}`,
          token_type: "Bearer",
          expires_in: 2_592_000,
          client_fingerprint: "a".repeat(63) + String(issued % 10),
        });
        return;
      }

      if (url.pathname === "/api/v1/client/handshake") {
        sendJson(res, 404, {
          type: "https://warm.run/problems/not_found",
          title: "Not found",
          detail: "This endpoint is not enabled.",
          code: "not_found",
        });
        return;
      }

      if (!bearer.startsWith("Bearer ")) {
        sendJson(res, 401, { code: "unauthorized", detail: "missing bearer" });
        return;
      }

      if (url.pathname === "/api/v1/me") {
        sendJson(res, 200, { id: "user_1", name: "Test User", email: "test@example.com" });
        return;
      }

      if (url.pathname === "/api/v1/usage") {
        state.usageCalls += 1;
        sendJson(res, 200, usageBody(behaviour.usage));
        return;
      }

      if (url.pathname === "/api/v1/usage/recent") {
        sendJson(res, 200, {
          runs: [],
          summary: { total: 0, completed: 0, failed: 0, input_tokens: 0, output_tokens: 0, cost: "0.000000" },
        });
        return;
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        sendJson(res, 200, {
          data: behaviour.models.map((id) => ({ id, display_name: id, created_at: "2026-01-01T00:00:00.000Z" })),
        });
        return;
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        messages.push(record);
        const failure =
          behaviour.failures.length > 0 ? behaviour.failures.shift() ?? null : behaviour.alwaysFail;
        if (failure) {
          sendJson(res, failure.status, {
            type: `https://warm.run/problems/${failure.code}`,
            title: failure.code,
            detail: failure.detail ?? failure.code,
            code: failure.code,
            ...(failure.restores_at ? { restores_at: failure.restores_at } : {}),
          });
          return;
        }

        const token = bearer.slice("Bearer ".length);
        const fixtureName = behaviour.fixture;
        let payload: string;
        try {
          payload = readFileSync(join(FIXTURES, `${fixtureName}.sse`), "utf8");
        } catch {
          sendJson(res, 500, { code: "fixture_missing", detail: fixtureName });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-fake-token": token,
        });
        res.end(payload);
        return;
      }

      sendJson(res, 404, { code: "not_found", detail: url.pathname });
    })();
  });

  const listening = Promise.withResolvers<{ port: number }>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    listening.resolve({ port: typeof address === "object" && address ? address.port : 0 });
  });
  const { port } = await listening.promise;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    messages,
    behaviour,
    set(patch) {
      Object.assign(behaviour, patch);
    },
    reset() {
      behaviour.failures.length = 0;
      behaviour.alwaysFail = null;
      behaviour.fixture = "text";
      behaviour.usage = "fresh";
    },
    close() {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      return promise;
    },
  };
}
