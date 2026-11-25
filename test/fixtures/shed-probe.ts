// Fires oversized in-flight bodies at a proxy with a tiny byte budget: some must
// be shed with 503 while /admin stays answerable. Prints one JSON line.

import { addAccount } from "../../src/accounts.ts";
import { resetAttestationState } from "../../src/attest.ts";
import { loadConfig, resetConfig, setConfig } from "../../src/config.ts";
import { closeDb, initDb, setDb } from "../../src/db.ts";
import { startFakeUpstream } from "../fake-upstream.ts";
import { startServer } from "../../src/server.ts";

const upstream = await startFakeUpstream({});
const dataDir = await Bun.$`mktemp -d`.text().then((s) => s.trim());
Object.assign(process.env, {
  WARM2API_DATA: dataDir,
  WARM2API_API_BASE: upstream.url,
  WARM2API_KEY: "shed-key",
  WARM2API_PORT: "0",
  WARM2API_MAX_IN_FLIGHT_BYTES: "8388608",
});

const config = loadConfig();
setConfig(config);
initDb(dataDir);
resetAttestationState();
addAccount({ label: "shed", accessToken: "tok_shed", expiresAt: Date.now() + 60_000 });
const server = await startServer(config);

const body = JSON.stringify({
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "x".repeat(8_000_000) }],
});
const send = () =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer shed-key", "content-type": "application/json" },
    body,
  }).then(async (response) => {
    await response.text();
    return response.status;
  });

const statuses = await Promise.all(Array.from({ length: 8 }, send));
const shed = statuses.filter((status) => status === 503).length;

const admin = await fetch(`${server.url}/admin/accounts`, { headers: { "x-api-key": "shed-key" } });
const adminStatus = admin.status;
await admin.text();

server.stop();
await upstream.close();
closeDb();
setDb(null);
resetConfig();
resetAttestationState();
await Bun.$`rm -rf ${dataDir}`.quiet();

console.log(JSON.stringify({ shed, admin: adminStatus }));
