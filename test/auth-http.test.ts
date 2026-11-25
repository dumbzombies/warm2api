// End-to-end auth: a configured dashboard password really does gate the HTML
// document and every admin route over the wire.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { addAccount } from "../src/accounts.ts";
import { resetAttestationState } from "../src/attest.ts";
import { loadConfig, resetConfig, setConfig } from "../src/config.ts";
import { closeDb, initDb, setDb } from "../src/db.ts";
import { startFakeUpstream } from "./fake-upstream.ts";
import { startServer } from "../src/server.ts";

const credentials = (user: string, password: string): string =>
  `Basic ${btoa(`${user}:${password}`)}`;

test("a configured password gates the dashboard and admin routes", async () => {
  const upstream = await startFakeUpstream({});
  const dataDir = mkdtempSync(join(tmpdir(), "warm2api-auth-"));
  const previous = { ...process.env };

  Object.assign(process.env, {
    WARM2API_DATA: dataDir,
    WARM2API_API_BASE: upstream.url,
    WARM2API_KEY: "auth-test-key",
    WARM2API_PORT: "0",
    WARM2API_HOST: "127.0.0.1",
    WARM2API_DASHBOARD_USER: "ada",
    WARM2API_DASHBOARD_PASS: "hunter2",
  });

  const config = loadConfig();
  setConfig(config);
  initDb(dataDir);
  resetAttestationState();
  addAccount({ label: "auth", accessToken: "tok_auth", expiresAt: Date.now() + 60_000 });
  const server = await startServer(config);

  try {
    expect(config.dashboardAuth).toEqual({ user: "ada", password: "hunter2" });
    expect(config.requireApiKey).toBe(true);

    // Dashboard document: refused without credentials, served with them.
    const anonymous = await fetch(`${server.url}/`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic");

    const wrongPassword = await fetch(`${server.url}/`, { headers: { authorization: credentials("ada", "nope") } });
    expect(wrongPassword.status).toBe(401);

    const unlocked = await fetch(`${server.url}/`, { headers: { authorization: credentials("ada", "hunter2") } });
    expect(unlocked.status).toBe(200);
    expect(await unlocked.text()).toContain("warm2api");

    // Admin routes: no key and no credentials is rejected; both together work.
    const adminAnonymous = await fetch(`${server.url}/admin/accounts`);
    expect(adminAnonymous.status).toBe(401);

    const adminNoKey = await fetch(`${server.url}/admin/accounts`, {
      headers: { authorization: credentials("ada", "hunter2") },
    });
    expect(adminNoKey.status).toBe(401);

    const adminAuthed = await fetch(`${server.url}/admin/accounts`, {
      headers: { authorization: credentials("ada", "hunter2"), "x-api-key": "auth-test-key" },
    });
    expect(adminAuthed.status).toBe(200);

    // Inference stays behind the API key when the dashboard password is set.
    const inferenceAnonymous = await fetch(`${server.url}/v1/models`);
    expect(inferenceAnonymous.status).toBe(401);
    const inferenceAuthed = await fetch(`${server.url}/v1/models`, {
      headers: { "x-api-key": "auth-test-key" },
    });
    expect(inferenceAuthed.status).toBe(200);
  } finally {
    server.stop();
    await upstream.close();
    closeDb();
    setDb(null);
    resetConfig();
    resetAttestationState();
    rmSync(dataDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});

test("a localhost proxy with no credentials serves the dashboard and API openly", async () => {
  const upstream = await startFakeUpstream({});
  const dataDir = mkdtempSync(join(tmpdir(), "warm2api-open-"));
  const previous = { ...process.env };

  Object.assign(process.env, {
    WARM2API_DATA: dataDir,
    WARM2API_API_BASE: upstream.url,
    WARM2API_KEY: "open-test-key",
    WARM2API_PORT: "0",
    WARM2API_HOST: "127.0.0.1",
    WARM2API_DASHBOARD_USER: "",
    WARM2API_DASHBOARD_PASS: "",
    WARM2API_API_AUTH: "",
  });

  const config = loadConfig();
  setConfig(config);
  initDb(dataDir);
  resetAttestationState();
  const server = await startServer(config);

  try {
    expect(config.dashboardAuth).toBeNull();
    expect(config.requireApiKey).toBe(false);

    expect((await fetch(`${server.url}/`)).status).toBe(200);
    expect((await fetch(`${server.url}/admin/accounts`)).status).toBe(200);
    expect((await fetch(`${server.url}/v1/models`)).status).toBe(200);
  } finally {
    server.stop();
    await upstream.close();
    closeDb();
    setDb(null);
    resetConfig();
    resetAttestationState();
    rmSync(dataDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
});
