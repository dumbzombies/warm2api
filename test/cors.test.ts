// Browser clients: preflight must answer without credentials, and the inference
// responses must be readable cross-origin (the template this repo follows does
// both; without them a web-page SDK cannot call the proxy at all).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { boot, type Harness } from "./harness.ts";

let h: Harness;

beforeAll(async () => {
  h = await boot({ accounts: 1 });
});

afterAll(async () => {
  await h.close();
});

test("OPTIONS answers a preflight without credentials", async () => {
  // A browser never sends Authorization on a preflight, so this must not 401.
  const res = await fetch(`${h.server.url}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: {
      origin: "https://example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
});

test("JSON and streamed inference responses carry CORS", async () => {
  const headers = { "x-api-key": h.config.apiKey, "content-type": "application/json" };
  const body = JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] });

  const buffered = await fetch(`${h.server.url}/v1/chat/completions`, { method: "POST", headers, body });
  expect(buffered.headers.get("access-control-allow-origin")).toBe("*");
  await buffered.text();

  const streamed = await fetch(`${h.server.url}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  expect(streamed.headers.get("content-type")).toContain("text/event-stream");
  expect(streamed.headers.get("access-control-allow-origin")).toBe("*");
  await streamed.text();
});
