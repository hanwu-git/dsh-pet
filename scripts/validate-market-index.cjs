// Validate a DSH market index with the OFFICIAL validator shipped inside DSH,
// so the published index is proven correct rather than merely plausible.
//
// Usage (must run with ELECTRON_RUN_AS_NODE=1 via DeepSeek Harness.exe, because the
// validator lives inside the app.asar virtual filesystem):
//   ELECTRON_RUN_AS_NODE=1 DeepSeek Harness.exe scripts/validate-market-index.cjs [index.json] [indexUrl]
const fs = require("fs");

const modPath = "D:\\Program Files\\DHS\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-plugin-market-index\\lib\\index.js";

(async () => {
  const indexFile = process.argv[2] || "D:\\obj\\dsh-pet\\market-index.json";
  const indexUrl = process.argv[3] || "https://raw.githubusercontent.com/hanwu-git/dsh-pet/main/market-index.json";

  const mod = await import("file:///" + modPath.replace(/\\/g, "/"));
  const value = JSON.parse(fs.readFileSync(indexFile, "utf8"));

  console.log("index file:", indexFile);
  console.log("index url: ", indexUrl);
  try {
    const parsed = mod.parseMarketIndex(value, indexUrl);
    console.log("VALID: index parsed successfully");
    console.log("  format:", parsed.format);
    console.log("  plugins:", parsed.plugins.length);
    for (const p of parsed.plugins) {
      console.log("  -", p.name, "versions:", p.versions.map(v => v.version).join(", "));
      console.log("    icon:", p.icon || "(none)");
      console.log("    title.zh:", p.title && p.title.zh);
      for (const v of p.versions) {
        console.log("    install target:", JSON.stringify(mod.marketInstallTarget(p.name, v)));
      }
    }
  } catch (e) {
    console.log("INVALID:", e.constructor && e.constructor.name);
    console.log("  path:", e.path);
    console.log("  reason:", e.reason || e.message);
    process.exitCode = 1;
  }
})();
