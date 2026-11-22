const fs = require("fs");

// Embed pet.png as a base64 data URL into the client template.
const png = fs.readFileSync("D:/obj/dsh-pet/pet.png");
const dataUrl = "data:image/png;base64," + png.toString("base64");

let tpl = fs.readFileSync("D:/obj/dsh-pet/.client-template.js", "utf8");
// The template holds '%PET_IMG%' inside single quotes; replace with the data URL.
// Guard against special replacement patterns ($ etc.) by using a function.
const out = tpl.replace("'%PET_IMG%'", () => "'" + dataUrl + "'");
fs.writeFileSync("D:/obj/dsh-pet/client.js", out);
console.log("built:", fs.statSync("D:/obj/dsh-pet/client.js").size, "bytes");
