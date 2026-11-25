// Account lifecycle invariants: one row per Warm identity, and a purge that
// leaves no quota rows behind.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { boot, type Harness } from "./harness.ts";
import { addAccount, latestQuota, listAccounts, purgeAccount, recordSnapshot } from "../src/accounts.ts";
import { getDb } from "../src/db.ts";

let h: Harness;

beforeAll(async () => {
  h = await boot({ accounts: 0 });
});

afterAll(async () => {
  await h.close();
});

test("re-adding the same token updates the account instead of duplicating it", () => {
  const first = addAccount({ label: "baker@example.com", accessToken: "tok_identity", expiresAt: Date.now() + 1000 });
  const second = addAccount({ label: "baker@example.com", accessToken: "tok_identity", expiresAt: Date.now() + 5000 });

  expect(second.id).toBe(first.id);
  expect(listAccounts().filter((a) => a.accessToken === "tok_identity")).toHaveLength(1);
  // The longer expiry wins; re-approval never shortens a usable token.
  expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);

  const other = addAccount({ label: "other@example.com", accessToken: "tok_other", expiresAt: Date.now() + 1000 });
  expect(other.id).not.toBe(first.id);
});

test("purging an account also removes its quota snapshots", () => {
  const account = addAccount({ label: "purge@example.com", accessToken: "tok_purge", expiresAt: Date.now() + 1000 });
  const snapshot = JSON.stringify({ pools: [{ limit_usd: "1.000000", remaining_usd: "0.500000" }] });
  recordSnapshot(account.id, snapshot);
  expect(latestQuota(account.id)).not.toBeNull();

  expect(purgeAccount(account.id)).toBe(true);
  expect(latestQuota(account.id)).toBeNull();

  const orphans = getDb()
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage_snapshots WHERE account_id = ?")
    .get(account.id);
  expect(orphans?.n).toBe(0);
  expect(purgeAccount("acct_missing")).toBe(false);
});
