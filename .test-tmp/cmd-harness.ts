// Drive the plugin's command handlers with a mock host, the way pi calls them.
const notes: string[] = [];
const commands = new Map<string, any>();
const pi = {
  on() {},
  registerProvider(_n: string, cfg: any) { (pi as any).provider = cfg; },
  registerCommand(name: string, opts: any) { commands.set(name, opts); },
};
const mod = await import("../plugins/omp/src/index.ts");
await mod.default(pi as any);

const ctx = { ui: { notify: (m: string, level?: string) => notes.push(`[${level ?? "info"}] ${m}`) } };
for (const cmd of ["warm-quota", "warm", "warm accounts"]) {
  notes.length = 0;
  const [name, ...rest] = cmd.split(" ");
  try {
    await commands.get(name).handler(rest.join(" "), ctx);
    console.log(`\n=== ${cmd} ===\n${notes.join("\n") || "(no output)"}`);
  } catch (err) {
    console.log(`\n=== ${cmd} === THREW: ${String(err)}`);
  }
}
console.log("\n=== provider ===");
console.log("baseUrl:", (pi as any).provider.baseUrl, "| apiKey set:", Boolean((pi as any).provider.apiKey), "| models:", (pi as any).provider.models.length);
