import { boot } from "../test/harness.ts";
const h = await boot({ accounts: 1 });
const { recordRequest } = await import("../src/track.ts");
// A heavily cached request: 1000 uncached + 9000 cached prompt tokens.
recordRequest({ accountId: null, surface: "openai", model: "m", status: 200, inputTokens: 1000, outputTokens: 50, cacheReadTokens: 9000, ms: 5 });
const state = await (await fetch(`${h.server.url}/api/state`, { headers: { authorization: "Bearer test-local-key" } })).json() as any;
const r = state.requests;
console.log(`tokens_in=${r.tokens_in} cached=${r.tokens_cached} pct=${r.cache_hit_pct} (expect 90)`);
await h.close();
