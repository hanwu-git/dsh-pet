// Validate market-index.example.json with the OFFICIAL validator from the DSH install,
// so the published index is proven correct rather than merely plausible.
const fs = require("fs");
const path = require("path");

const modPath = "D:\\Program Files\\DHS\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-plugin-market-index\\lib\\index.js";

(async () => {
  const mod = await import("file:///" + modPath.replace(/\\/g, "/"));
  const raw = fs.readFileSync("D:\\obj\\dsh-pet\\market-index.example.json", "utf8");
  const value = JSON.parse(raw);
  const indexUrl = "https://raw.githubusercontent.com/REPLACE_ME/market/main/index.json";

  try {
    const parsed = mod.parseMarketIndex(value, indexUrl);
    console.log("VALID: index parsed successfully");
    console.log("  format:", parsed.format);
    console.log("  plugins:", parsed.plugins.length);
    for (const p of parsed.plugins) {
      console.log("  -", p.name, "versions:", p.versions.map(v => v.version).join(", "));
      console.log("    icon:", p.icon ? p.icon.slice(0, 60) + "..." : "(none)");
      console.log("    title.zh:", p.title && p.title.zh);
    }
    // Prove the install target the market will hand to pnpm:
    const v0 = parsed.plugins[0].versions[0];
    console.log("  install target:", JSON.stringify(mod.marketInstallTarget(p0name(parsed), v0)));
  } catch (e) {
    console.log("INVALID:", e.constructor && e.constructor.name);
    console.log("  path:", e.path);
    console.log("  reason:", e.reason || e.message);
  }

  function p0name(parsed) { return parsed.plugins[0].name; }
})();
