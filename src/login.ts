// RFC 8628 device login, shared by the CLI and the agent plugins. Warm has no
// refresh grant: an expired token needs a fresh approval.

import type { Config } from "./config.ts";
import { addAccount, recordSnapshot, type Account } from "./accounts.ts";
import { fetchMe, fetchUsageRaw, type UsageRaw } from "./upstream.ts";

const CLIENT_ID = "keelcode-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export interface LoginCallbacks {
  onDeviceCode?(info: DeviceCodeInfo): void;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}

export interface DeviceLogin {
  accessToken: string;
  clientFingerprint: string | null;
  expiresIn: number;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function postJson(base: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function deviceLogin(cfg: Config, callbacks: LoginCallbacks = {}): Promise<DeviceLogin> {
  const startRes = await postJson(cfg.apiBaseUrl, "/api/auth/device/code", { client_id: CLIENT_ID }, callbacks.signal);
  if (!startRes.ok) throw new Error(`device code request failed: HTTP ${startRes.status}`);
  const start = (await startRes.json()) as Record<string, unknown>;
  const deviceCode = typeof start.device_code === "string" ? start.device_code : "";
  const userCode = typeof start.user_code === "string" ? start.user_code : "";
  const verificationUri = typeof start.verification_uri === "string" ? start.verification_uri : "https://warm.run/device";
  const verificationUriComplete =
    typeof start.verification_uri_complete === "string" ? start.verification_uri_complete : null;
  if (deviceCode === "" || userCode === "") throw new Error("device code response was missing fields");

  const expiresIn = typeof start.expires_in === "number" ? start.expires_in : 600;
  let interval = Math.max(typeof start.interval === "number" ? start.interval : 5, 1);

  callbacks.onDeviceCode?.({
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds: interval,
    expiresInSeconds: expiresIn,
  });

  const deadline = Date.now() + expiresIn * 1000;
  for (;;) {
    if (callbacks.signal?.aborted) throw new Error("login cancelled");
    if (Date.now() > deadline) throw new Error("device code expired");

    const res = await postJson(
      cfg.apiBaseUrl,
      "/api/auth/device/token",
      { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLIENT_ID },
      callbacks.signal,
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.ok && typeof body.access_token === "string") {
      return {
        accessToken: body.access_token,
        clientFingerprint:
          typeof body.client_fingerprint === "string" && /^[a-f0-9]{64}$/i.test(body.client_fingerprint)
            ? body.client_fingerprint
            : null,
        expiresIn: typeof body.expires_in === "number" ? body.expires_in : 30 * 24 * 3600,
      };
    }

    const error = typeof body.error === "string" ? body.error : `http_${res.status}`;
    if (error === "authorization_pending") {
      await sleep(interval * 1000);
      continue;
    }
    if (error === "slow_down") {
      interval = Math.min(interval + 5, 60);
      await sleep(interval * 1000);
      continue;
    }
    const description = typeof body.error_description === "string" ? body.error_description : error;
    throw new Error(`device login failed: ${description}`);
  }
}

export interface AddedAccount {
  account: Account;
  label: string;
  me: { id: string; name: string; email: string } | null;
}

/** Full `warm2api add`: device flow, identity lookup, first quota snapshot, insert. */
export async function addViaDeviceFlow(cfg: Config, callbacks: LoginCallbacks = {}): Promise<AddedAccount> {
  const login = await deviceLogin(cfg, callbacks);
  const expiresAt = Date.now() + login.expiresIn * 1000;
  const provisional = {
    accessToken: login.accessToken,
    clientFingerprint: login.clientFingerprint,
    expiresAt,
  } as const;

  let me: { id: string; name: string; email: string } | null = null;
  let plan: string | undefined;
  let snapshot: UsageRaw | null = null;

  try {
    me = await fetchMe(provisional, callbacks.signal);
  } catch (err) {
    callbacks.onProgress?.(`identity lookup failed: ${String(err)}`);
  }
  try {
    snapshot = await fetchUsageRaw(provisional, callbacks.signal);
    if (typeof snapshot.parsed.plan === "string") plan = snapshot.parsed.plan;
  } catch (err) {
    callbacks.onProgress?.(`usage lookup failed: ${String(err)}`);
  }

  const label = me?.email || me?.name || "warm-account";
  const account = addAccount({
    label,
    accessToken: login.accessToken,
    expiresAt,
    clientFingerprint: login.clientFingerprint,
    plan,
  });
  if (snapshot) recordSnapshot(account.id, snapshot.raw);

  return { account, label, me };
}
