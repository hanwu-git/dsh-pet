const fs = require("fs");
const path = require("path");

// Embed pet.png as a base64 data URL into the client template. Paths are resolved relative to
// this script's directory so the build works from any checkout location.
const root = __dirname;
const png = fs.readFileSync(path.join(root, "pet.png"));
const dataUrl = "data:image/png;base64," + png.toString("base64");

let tpl = fs.readFileSync(path.join(root, ".client-template.js"), "utf8");
// The template holds '%PET_IMG%' inside single quotes; replace with the data URL.
// Guard against special replacement patterns ($ etc.) by using a function.
const out = tpl.replace("'%PET_IMG%'", () => "'" + dataUrl + "'");
fs.writeFileSync(path.join(root, "client.js"), out);
console.log("built:", fs.statSync(path.join(root, "client.js")).size, "bytes");
