// Probe used by test/plugins.test.ts: imports the shipped plugins exactly as an
// agent host would (env first, then module) and reports what they did.
//
// The opencode plugin cannot inject a provider on this build (modules are
// evaluated, hooks are never called), so the provider block ships as config and
// the probe asserts that instead of a `config` hook.
import { existsSync } from "node:fs";
import { join } from "node:path";
import ompPlugin from "../../plugins/omp/src/index.ts";
import opencodePlugin from "../../plugins/opencode/plugins/warm2api.ts";

const root = join(import.meta.dir, "..", "..");
const example = (await Bun.file(join(root, "plugins/opencode/opencode.jsonc.example")).json()) as {
  provider: { warm: { options: { baseURL: string }; models: Record<string, unknown> } };
};

let provider: { name: string; config: { baseUrl?: string; models?: Array<{ id: string }> } } | undefined;
const commands: string[] = [];
const pi = {
  registerProvider(name: string, config: unknown) {
    provider = { name, config: config as { baseUrl?: string; models?: Array<{ id: string }> } };
  },
  registerCommand(name: string) {
    commands.push(name);
  },
  on() {},
};
await ompPlugin(pi as never);

const warm = example.provider.warm;

console.log(
  JSON.stringify({
    provider: provider?.name,
    baseUrl: provider?.config.baseUrl,
    ompModels: provider?.config.models?.map((model) => model.id) ?? [],
    ompCommands: commands,
    opencodeId: (opencodePlugin as { id?: string }).id,
    opencodeBaseUrl: warm.options.baseURL,
    opencodeModels: Object.keys(warm.models),
    pluginLog: existsSync(join(process.env.WARM2API_DATA ?? "", "plugin.log")),
  }),
);
