// Attestation must never be disabled pool-wide by one account's transient
// failure, and sequence numbers must stay unique and never fall back to a
// replayable zero.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { boot, type Harness } from "./harness.ts";
import { listAccounts, reserveAttestSeq } from "../src/accounts.ts";
import { attestationEnabled, attestationSupport, ensureAttestation, resetAttestationState } from "../src/attest.ts";
import { loadConfig, setConfig } from "../src/config.ts";

let h: Harness;

beforeAll(async () => {
  h = await boot({ accounts: 2 });
});

afterAll(async () => {
  setConfig(loadConfig());
  await h.close();
});

test("a transient handshake failure does not disable attestation for the pool", async () => {
  resetAttestationState();
  const cfg = loadConfig();
  // Port 9 is the discard port: connection refused, not a protocol answer.
  setConfig({ ...cfg, apiBaseUrl: "http://127.0.0.1:9", attestation: "auto" });

  await expect(ensureAttestation(listAccounts()[0])).rejects.toThrow();

  expect(attestationSupport()).not.toBe("unsupported");
  expect(attestationEnabled()).toBe(true);
});

test("sequence reservations are unique and never fall back to zero", () => {
  const account = listAccounts()[0];
  const seqs = Array.from({ length: 25 }, () => reserveAttestSeq(account.id));
  expect(new Set(seqs).size).toBe(25);
  expect(Math.min(...seqs)).toBeGreaterThan(0);

  // An unknown account is a bug in the caller, not a valid sequence.
  expect(() => reserveAttestSeq("acct_does_not_exist")).toThrow(/unknown account/);
});
