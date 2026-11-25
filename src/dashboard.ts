// Self-contained dashboard: one HTML document, no external assets, mobile-first.
// Login sessions live in this process only (a device approval is stateful and
// short-lived; restarting the proxy just means starting the approval again).

import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import { addViaDeviceFlow, type AddedAccount, type DeviceCodeInfo } from "./login.ts";

export interface LoginView {
  id: string;
  status: "pending" | "complete" | "error";
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string | null;
  expires_in?: number;
  account_id?: string;
  label?: string;
  message?: string;
  created_at: number;
}

interface LoginSession {
  view: LoginView;
  timer: TimerHandle | null;
}

/** Handle from `setTimeout`; the DOM and Node typings disagree, so name it once. */
type TimerHandle = ReturnType<typeof setTimeout>;

const SESSIONS = new Map<string, LoginSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of SESSIONS) {
    if (session.view.created_at > cutoff) continue;
    clearTimeout(session.timer);
    SESSIONS.delete(id);
  }
}

export async function startLogin(cfg: Config): Promise<LoginView> {
  sweep();
  const id = randomBytes(9).toString("hex");
  const view: LoginView = { id, status: "pending", created_at: Date.now() };
  const session: LoginSession = { view, timer: null };
  const codeReady = Promise.withResolvers<void>();
  SESSIONS.set(id, session);
  void addViaDeviceFlow(cfg, {
    onDeviceCode: (info: DeviceCodeInfo) => {
      view.user_code = info.userCode;
      view.verification_uri = info.verificationUri;
      view.verification_uri_complete = info.verificationUriComplete;
      view.expires_in = info.expiresInSeconds;
      codeReady.resolve();
    },
  })
    .then((added: AddedAccount) => {
      view.status = "complete";
      view.account_id = added.account.id;
      view.label = added.label;
    })
    .catch((err: unknown) => {
      view.status = "error";
      view.message = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      codeReady.resolve();
      clearTimeout(session.timer);
      session.timer = setTimeout(() => SESSIONS.delete(id), SESSION_TTL_MS);
    });

  // The device code is the whole point of this call: wait for it (or for the
  // flow to fail) so the page can render the code immediately.
  await Promise.race([
    codeReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  return view;
}

export function getLogin(id: string): LoginView | null {
  const session = SESSIONS.get(id);
  return session ? session.view : null;
}
