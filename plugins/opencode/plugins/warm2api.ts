// opencode plugin: bring the bundled warm2api proxy up when opencode loads it.
//
// This opencode build evaluates plugin modules but never calls the exported
// hooks (same constraint mistral-vibe.ts documents), so the provider cannot be
// injected from here. `install.sh` writes the static `provider.warm` block into
// opencode.jsonc instead, and this module only guarantees the proxy the block
// points at is listening. Self-contained: `dist/warm2api.mjs` beside this file
// is the whole proxy.

import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.WARM2API_PORT ?? 41673);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.WARM2API_DATA?.trim() || join(homedir(), ".warm2api");
const KEY_PATH = join(DATA_DIR, "api-key");

/** Empty when the proxy has no key yet: a loopback proxy is open by default. */
function apiKey(): string {
  if (!existsSync(KEY_PATH)) return "";
  return readFileSync(KEY_PATH, "utf8").trim();
}

function bundlePath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [join(here, "..", "dist", "warm2api.mjs"), join(here, "dist", "warm2api.mjs")];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`warm2api bundle missing (looked in ${candidates.join(", ")}); run bun run build:plugins`);
  return found;
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Reuse a listening proxy, otherwise start the bundled one in the background. */
async function ensureServer(): Promise<string> {
  if (await healthy()) return BASE;
  mkdirSync(DATA_DIR, { recursive: true });
  const log = openSync(join(DATA_DIR, "plugin.log"), "a");
  const child = Bun.spawn([process.execPath, bundlePath(), "serve"], {
    env: { ...process.env, WARM2API_PORT: String(PORT) },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await healthy()) return BASE;
    await Bun.sleep(120);
  }
  throw new Error(`warm2api did not become healthy on ${BASE}; see ${join(DATA_DIR, "plugin.log")}`);
}

// Module load is the only hook this build gives us, and it is not awaited.
// Starting the proxy is fire-and-forget on purpose: a failed start must not take
// opencode down with it, and the provider block's baseURL is correct either way.
void ensureServer().catch((err: unknown) => {
  console.error(`[warm2api] ${err instanceof Error ? err.message : String(err)}`);
});

export default {
  id: "warm2api.opencode",
  async setup() {
    return async () => {};
  },
};
