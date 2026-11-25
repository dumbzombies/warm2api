// Boot helper: a fake upstream plus a real warm2api server on an ephemeral port,
// with an isolated data directory per test file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeUpstream, type Behaviour, type FakeUpstream } from "./fake-upstream.ts";
import { loadConfig, resetConfig, setConfig, type Config } from "../src/config.ts";
import { closeDb, initDb, setDb } from "../src/db.ts";
import { addAccount, type Account } from "../src/accounts.ts";
import { resetCatalogCache, startServer, type RunningServer } from "../src/server.ts";
import { resetAttestationState } from "../src/attest.ts";

export interface Harness {
  upstream: FakeUpstream;
  server: RunningServer;
  config: Config;
  dataDir: string;
  accounts: Account[];
  addAccount(label?: string): Account;
  close(): Promise<void>;
}

export async function boot(options: { accounts?: number; behaviour?: Partial<Behaviour> } = {}): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "warm2api-test-"));
  const upstream = await startFakeUpstream(options.behaviour ?? {});

  process.env.WARM2API_DATA = dataDir;
  process.env.WARM2API_API_BASE = upstream.url;
  process.env.WARM2API_KEY = "test-local-key";
  process.env.WARM2API_PORT = "0";
  process.env.WARM2API_ATTEST = "auto";
  // The harness models a guarded proxy: these tests assert that calls without a
  // key are rejected. The loopback-open default is covered in test/auth.test.ts.
  process.env.WARM2API_API_AUTH = "on";

  const config = loadConfig();
  setConfig(config);
  initDb(dataDir);

  const accounts: Account[] = [];
  const addAccountFor = (label?: string): Account => {
    const account = addAccount({
      label: label ?? `acct-${accounts.length + 1}`,
      accessToken: `tok_${accounts.length + 1}`,
      expiresAt: Date.now() + 30 * 24 * 3600_000,
      clientFingerprint: "b".repeat(64),
    });
    accounts.push(account);
    return account;
  };
  for (let i = 0; i < (options.accounts ?? 1); i += 1) addAccountFor();

  const server = await startServer(config);

  return {
    upstream,
    server,
    config,
    dataDir,
    accounts,
    addAccount: addAccountFor,
    async close() {
      server.stop();
      await upstream.close();
      closeDb();
      setDb(null);
      resetCatalogCache();
      resetAttestationState();
      resetConfig();
      rmSync(dataDir, { recursive: true, force: true });
      for (const key of [
        "WARM2API_DATA",
        "WARM2API_API_BASE",
        "WARM2API_KEY",
        "WARM2API_PORT",
        "WARM2API_ATTEST",
        "WARM2API_API_AUTH",
        "WARM2API_DASHBOARD_USER",
        "WARM2API_DASHBOARD_PASS",
      ]) {
        delete process.env[key];
      }
    },
  };
}
