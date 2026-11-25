// Warm client attestation. The handshake is disabled upstream today (404 before
// auth), so this module is complete but self-disabling: it tries once, records
// "unsupported", and retries 24 h later.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config.ts";
import type { Account } from "./accounts.ts";

const KEY = Buffer.from(
  "654cb037a6e543233be05e82ccc3cda1a7140ec6635c4d6f771187a05212efac",
  "hex",
);

/** sha256 over NUL-joined parts, hex. Layout copied from the shipped client. */
export function H(...parts: (string | Buffer)[]): string {
  const hash = createHash("sha256");
  parts.forEach((part, i) => {
    if (i > 0) hash.update("\0");
    hash.update(part);
  });
  return hash.digest("hex");
}

export function sentinelLine(): string {
  return `[keelcode-client-integrity:kc.integrity.${H(KEY, "system-sentinel").slice(0, 40)}]`;
}

/** sha256("keelcode-device:v1:" + machineId), hex. */
export function deviceFingerprint(machineId: string): string {
  return createHash("sha256").update(`keelcode-device:v1:${machineId}`).digest("hex");
}

function readMachineId(): string | null {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f]{32}$/.test(value)) return value;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

let cachedDeviceFingerprint: string | null = null;

/** One install-wide fingerprint: /etc/machine-id, else a persisted uuid. */
export function installDeviceFingerprint(): string {
  if (cachedDeviceFingerprint) return cachedDeviceFingerprint;
  const machineId = readMachineId() ?? persistedMachineId();
  cachedDeviceFingerprint = deviceFingerprint(machineId);
  return cachedDeviceFingerprint;
}

function persistedMachineId(): string {
  const path = join(getConfig().dataDir, "device.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { machineId?: unknown };
    if (typeof parsed.machineId === "string" && parsed.machineId.length > 0) return parsed.machineId;
  } catch {
    /* generate below */
  }
  const machineId = randomUUID().replace(/-/g, "");
  mkdirSync(getConfig().dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ machineId }, null, 2), { mode: 0o600 });
  return machineId;
}

export function platform(): string {
  return `${process.platform}-${process.arch}`;
}

export type HandshakeResult =
  | { token: string; seed: string; expiresAt: number }
  | { unsupported: true };

export async function handshake(
  account: Account,
  signal?: AbortSignal,
): Promise<HandshakeResult> {
  const device = installDeviceFingerprint();
  const nonce = randomBytes(16).toString("hex");
  const ts = Date.now();
  const proof = H(KEY, "handshake", getConfig().clientVersion, device, nonce, String(ts));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${account.accessToken}`,
    "x-warm-client": `keelcode-cli/${getConfig().clientVersion}`,
  };
  if (account.clientFingerprint) headers["x-warm-client-fingerprint"] = account.clientFingerprint;

  const res = await fetch(new URL("/api/v1/client/handshake", getConfig().apiBaseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      client_version: getConfig().clientVersion,
      device_fingerprint: device,
      platform: platform(),
      nonce,
      ts,
      proof,
    }),
    signal,
  });

  if (res.status === 404 || res.status === 501) return { unsupported: true };
  if (!res.ok) throw new Error(`attestation handshake failed (${res.status})`);

  const body = (await res.json()) as { token?: unknown; seed?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || typeof body.seed !== "string") {
    throw new Error("attestation handshake returned an unexpected body");
  }
  const expiresAt =
    typeof body.expires_at === "number"
      ? body.expires_at < 1e12
        ? body.expires_at * 1000
        : body.expires_at
      : typeof body.expires_at === "string"
        ? Date.parse(body.expires_at)
        : 0;
  return { token: body.token, seed: body.seed, expiresAt };
}

/** `"<seq>.<ts>.<hash>"` for one signed request. */
export function signRequest(
  account: Account,
  seq: number,
  ts: number,
  method: string,
  path: string,
  body: string,
): string {
  if (!account.attest) throw new Error("cannot sign without an attestation session");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = H(account.attest.seed, "req", String(seq), String(ts), method, path, bodyHash);
  return `${seq}.${ts}.${sig}`;
}

/** Prepend the integrity sentinel to a request's system prompt. */
export function injectSentinel<T extends { system?: string | Array<{ type: string; text?: string }> }>(
  request: T,
): T {
  const line = sentinelLine();
  const system = request.system;
  if (Array.isArray(system)) {
    return { ...request, system: [{ type: "text", text: line }, ...system] };
  }
  if (typeof system === "string" && system.length > 0) {
    return { ...request, system: `${line}\n${system}` };
  }
  return { ...request, system: line };
}

// ---------- support state ----------

type Support = "unknown" | "supported" | "unsupported";

let support: Support = "unknown";
let retryAt = 0;

export function attestationEnabled(): boolean {
  if (getConfig().attestation === "off") return false;
  if (support === "unsupported") return false;
  // A failed handshake sets `retryAt` but leaves support "unknown"; check the
  // backoff for both non-supported states so a flapping endpoint is retried once
  // a minute instead of on every request.
  if (Date.now() < retryAt) return false;
  return true;
}

/**
 * Ensure the account has a live attestation session. Returns null when
 * attestation is off or the upstream does not implement the handshake; the
 * caller then sends unsigned requests (exactly what the real client does).
 */
export async function ensureAttestation(
  account: Account,
  signal?: AbortSignal,
): Promise<Account["attest"]> {
  if (!attestationEnabled()) return account.attest;
  if (account.attest && account.attest.expiresAt - 300_000 > Date.now()) return account.attest;

  try {
    const result = await handshake(account, signal);
    if ("unsupported" in result) {
      support = "unsupported";
      retryAt = Date.now() + 24 * 3_600_000;
      return null;
    }
    support = "supported";
    return { token: result.token, seed: result.seed, expiresAt: result.expiresAt, seq: account.attest?.seq ?? 0 };
  } catch (err) {
    // A transient failure (network, 5xx, one account's 403) says nothing about
    // whether the upstream implements attestation, so it must not disable the
    // feature for every other account. Back off briefly and let the caller
    // proceed **unsigned**, exactly as the real client does — rethrowing here
    // aborted the whole request and, with `attestationEnabled()` still true,
    // burned every rotation attempt on the same handshake.
    support = support === "supported" ? "supported" : "unknown";
    retryAt = Date.now() + 60_000;
    console.warn(`[warm2api] attestation handshake failed, sending this request unsigned: ${String(err)}`);
    return account.attest;
  }
}

export function resetAttestationState(): void {
  support = "unknown";
  retryAt = 0;
}

export function attestationSupport(): Support {
  return support;
}

export { KEY as ATTEST_KEY };
