// Optional live check. Skipped unless WARM2API_LIVE=1 and the local database
// holds at least one active account; never runs in CI.

import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, setConfig } from "../src/config.ts";
import { closeDb, initDb } from "../src/db.ts";
import { listAccounts } from "../src/accounts.ts";
import { startServer } from "../src/server.ts";

const live = process.env.WARM2API_LIVE === "1";

test.skipIf(!live)("live: a real completion round-trips through both surfaces", async () => {
  const config = loadConfig();
  setConfig(config);
  initDb(config.dataDir);

  const accounts = listAccounts().filter((a) => a.state === "active");
  expect(accounts.length).toBeGreaterThan(0);

  const server = await startServer(config);
  try {
    const client = new Anthropic({ baseURL: server.url, apiKey: config.apiKey });
    const message = await client.messages.create({
      model: "gpt-5.6-luna",
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    });
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text.toLowerCase()).toContain("pong");
  } finally {
    server.stop();
    closeDb();
  }
});
