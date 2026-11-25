// Micro-dollars and the attestation sequence counter.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, formatMicro, initDb, parseMicro, setDb } from "../src/db.ts";
import { loadConfig, resetConfig, setConfig } from "../src/config.ts";
import { addAccount, reserveAttestSeq } from "../src/accounts.ts";

const dataDir = mkdtempSync(join(tmpdir(), "warm2api-unit-"));
process.env.WARM2API_DATA = dataDir;
process.env.WARM2API_KEY = "unit-test-key";
process.env.WARM2API_PORT = "0";
setConfig(loadConfig());
initDb(dataDir);

afterAll(() => {
  closeDb();
  setDb(null);
  resetConfig();
  rmSync(dataDir, { recursive: true, force: true });
});

test("micro-dollars round-trip without float math", () => {
  expect(parseMicro("1.000000")).toBe(1_000_000);
  expect(parseMicro("0.000042")).toBe(42);
  expect(parseMicro("12.345678")).toBe(12_345_678);
  expect(parseMicro("-0.500000")).toBe(-500_000);
  expect(parseMicro("0")).toBe(0);
  expect(formatMicro(1_000_000)).toBe("1.000000");
  expect(formatMicro(42)).toBe("0.000042");
  expect(formatMicro(12_345_678)).toBe("12.345678");
  expect(formatMicro(parseMicro("1.000000"))).toBe("1.000000");
});

test("reserveAttestSeq hands out strictly increasing values", async () => {
  const account = addAccount({
    label: "seq",
    accessToken: "tok_seq",
    expiresAt: Date.now() + 3_600_000,
  });
  const values = await Promise.all(Array.from({ length: 20 }, async () => reserveAttestSeq(account.id)));
  const sorted = [...values].sort((a, b) => a - b);
  expect(new Set(values).size).toBe(20);
  expect(sorted).toEqual(Array.from({ length: 20 }, (_v, i) => i + 1));
});
