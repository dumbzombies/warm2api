// Process-wide configuration. Resolved exactly once at startup and frozen, so
// every module can import `config` without re-reading the environment.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The version this proxy impersonates on the wire (`x-warm-client`). It must
 * match the upstream CLI the gateway expects, so it is deliberately not the
 * package version — bumping it changes how the gateway treats requests.
 */
export const CLIENT_VERSION = "0.6.0";

/** This program's own version, served by `/healthz` and `warm2api version`. */
export const APP_VERSION = "0.7.0";

export type AttestMode = "auto" | "on" | "off";

export interface DashboardAuth {
  readonly user: string;
  readonly password: string;
}

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly apiBaseUrl: string;
  readonly clientVersion: string;
  readonly pollMs: number;
  readonly attestation: AttestMode;
  readonly apiKey: string;
  readonly apiKeyPath: string;
  /** True when the listener is reachable beyond this machine. */
  readonly isPublic: boolean;
  /** Dashboard basic-auth credentials, or null when the dashboard is open. */
  readonly dashboardAuth: DashboardAuth | null;
  /** Whether inference and admin routes demand the API key. */
  readonly requireApiKey: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1", "[::1]"]);

/** A bind address only this machine can reach. Anything else is public. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOSTS.has(value)) return true;
  if (value.startsWith("127.")) return true;
  // A unix-socket path or an explicit wildcard is not loopback.
  return false;
}

export interface AuthPolicy {
  readonly isPublic: boolean;
  readonly dashboardAuth: DashboardAuth | null;
  readonly requireApiKey: boolean;
}

/**
 * Decide what guards the proxy.
 *
 * Bound to loopback, this is a personal tool: inference is open and the
 * dashboard is open unless the operator sets credentials, in which case both
 * are closed (opting into auth locally means opting in everywhere).
 *
 * Bound anywhere else, it is an internet service: refuse to run without
 * dashboard credentials and API key auth, because "open by default" on a
 * public address is an open relay to someone's paid subscription.
 */
export function resolveAuthPolicy(
  host: string,
  user: string | undefined,
  password: string | undefined,
  apiAuth: string | undefined,
): AuthPolicy {
  const isPublic = !isLoopbackHost(host);
  const hasUser = (user ?? "").trim().length > 0;
  const hasPassword = (password ?? "").length > 0;

  if (hasUser !== hasPassword) {
    throw new Error(
      "WARM2API_DASHBOARD_USER and WARM2API_DASHBOARD_PASS must be set together (or neither).",
    );
  }

  const dashboardAuth = hasUser && hasPassword ? { user: (user ?? "").trim(), password: password ?? "" } : null;

  if (isPublic) {
    if (!dashboardAuth) {
      throw new Error(
        `refusing to bind ${host}: set WARM2API_DASHBOARD_USER and WARM2API_DASHBOARD_PASS, ` +
          "and keep the API key required, or bind 127.0.0.1 for a local-only proxy.",
      );
    }
    const mode = (apiAuth ?? "on").trim().toLowerCase();
    if (mode === "off" || mode === "false" || mode === "0") {
      throw new Error(
        `refusing to bind ${host} with API auth disabled: a public proxy without the API key is an open relay.`,
      );
    }
    return { isPublic, dashboardAuth, requireApiKey: true };
  }

  // Loopback: auth is opt-in. Setting a password closes the API too, so the
  // operator never ends up with a half-guarded local proxy.
  const mode = (apiAuth ?? "").trim().toLowerCase();
  const explicitOn = mode === "on" || mode === "true" || mode === "1";
  const explicitOff = mode === "off" || mode === "false" || mode === "0";
  return {
    isPublic,
    dashboardAuth,
    requireApiKey: explicitOn || (dashboardAuth !== null && !explicitOff),
  };
}

/** The upstream CLI strips these so callers can append `/v1/messages` freely. */
export function normaliseBaseUrl(input: string): string {
  let base = input.trim().replace(/\/+$/, "");
  base = base.replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
  return base.replace(/\/+$/, "");
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Port 0 is meaningful: the OS assigns an ephemeral port (used by tests). */
function portEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : fallback;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Read the API key from env or disk, generating and persisting one on first run. */
function resolveApiKey(dataDir: string): { key: string; path: string; created: boolean } {
  const path = join(dataDir, "api-key");
  const fromEnv = process.env.WARM2API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, path, created: false };

  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 16) return { key: existing, path, created: false };
  } catch {
    /* missing file: generate below */
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems without modes */
  }
  return { key, path, created: true };
}

function attestMode(raw: string | undefined): AttestMode {
  const value = (raw ?? "auto").trim().toLowerCase();
  if (value === "on" || value === "true" || value === "1") return "on";
  if (value === "off" || value === "false" || value === "0") return "off";
  return "auto";
}

export function loadConfig(): Config {
  const dataDir = expandHome(process.env.WARM2API_DATA?.trim() || join(homedir(), ".warm2api"));
  const { key, path } = resolveApiKey(dataDir);
  const host = process.env.WARM2API_HOST?.trim() || "127.0.0.1";
  const policy = resolveAuthPolicy(
    host,
    process.env.WARM2API_DASHBOARD_USER,
    process.env.WARM2API_DASHBOARD_PASS,
    process.env.WARM2API_API_AUTH,
  );
  return Object.freeze({
    port: portEnv("WARM2API_PORT", 41673),
    host,
    dataDir,
    apiBaseUrl: normaliseBaseUrl(process.env.WARM2API_API_BASE?.trim() || "https://api.keelcode.ai"),
    clientVersion: CLIENT_VERSION,
    pollMs: intEnv("WARM2API_POLL_MS", 60_000),
    attestation: attestMode(process.env.WARM2API_ATTEST),
    apiKey: key,
    apiKeyPath: path,
    isPublic: policy.isPublic,
    dashboardAuth: policy.dashboardAuth,
    requireApiKey: policy.requireApiKey,
  });
}

let active: Config | null = null;

/** Resolved on first use so tests and plugins can set the environment first. */
export function getConfig(): Config {
  active ??= loadConfig();
  return active;
}

export function setConfig(next: Config): void {
  active = next;
}

export function resetConfig(): void {
  active = null;
}
