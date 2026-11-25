// Runs one request against a gateway that answers control-plane calls but never
// replies to /v1/messages. Prints the outcome as JSON so the test can assert on
// wall-clock time without touching the main test process's database.

import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccount } from "../../src/accounts.ts";
import { resetAttestationState } from "../../src/attest.ts";
import { loadConfig, resetConfig, setConfig } from "../../src/config.ts";
import { closeDb, initDb, setDb } from "../../src/db.ts";
import { startServer } from "../../src/server.ts";

const stalled = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.includes("handshake")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"code":"not_found"}');
    return;
  }
  if (url.includes("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
    return;
  }
  if (url.includes("/api/v1/usage")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  // /v1/messages: accept the connection and stay silent.
});

const listening = Promise.withResolvers<void>();
stalled.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;

const address = stalled.address();
if (typeof address !== "object" || !address) throw new Error("no upstream port");

const dataDir = mkdtempSync(join(tmpdir(), "warm2api-stall-"));
Object.assign(process.env, {
  WARM2API_DATA: dataDir,
  WARM2API_API_BASE: `http://127.0.0.1:${address.port}`,
  WARM2API_KEY: "stall-key",
  WARM2API_PORT: "0",
  WARM2API_UPSTREAM_TIMEOUT_MS: "120",
});

const config = loadConfig();
setConfig(config);
initDb(dataDir);
resetAttestationState();
addAccount({ label: "stall", accessToken: "tok_stall", expiresAt: Date.now() + 60_000 });
const server = await startServer(config);

const started = Date.now();
const response = await fetch(`${server.url}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: "Bearer stall-key", "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
});
await response.text();
const elapsed = Date.now() - started;

server.stop();
stalled.close();
closeDb();
setDb(null);
resetConfig();
resetAttestationState();
rmSync(dataDir, { recursive: true, force: true });

console.log(JSON.stringify({ status: response.status, elapsed }));
