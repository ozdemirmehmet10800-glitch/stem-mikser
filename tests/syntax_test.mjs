// Tüm arayüz modülleri (frontend/js/*.js, js/ui/*.js ve sw.js) sözdizimi olarak geçerli mi? Bir modülde sözdizimi hatası ya da aynı adın iki kez
// tanımlanması uygulamayı BOŞ açar; diğer testler app.js'i yüklemediği için bunu yakalamıyordu. Ağ/DOM yok, kod ÇALIŞTIRILMAZ (yalnız ayrıştırılır).
//
//     node tests\syntax_test.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../frontend/", import.meta.url));
const child = `
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
const root = ${JSON.stringify(root)};
const files = readdirSync(root + "js").filter((f) => f.endsWith(".js")).map((f) => "js/" + f)
  .concat(readdirSync(root + "js/ui").filter((f) => f.endsWith(".js")).map((f) => "js/ui/" + f));
let bad = 0;
for (const file of files) {
  const source = readFileSync(root + file, "utf8");
  try {
    if (/^\\s*(import|export)\\s/m.test(source)) new vm.SourceTextModule(source, { identifier: file });
    else new vm.Script(source, { filename: file });
    console.log("ok   " + file);
  } catch (error) {
    bad += 1;
    console.log("FAIL " + file + "  " + error.message);
  }
}
try { new vm.Script(readFileSync(root + "sw.js", "utf8"), { filename: "sw.js" }); console.log("ok   sw.js"); }
catch (error) { bad += 1; console.log("FAIL sw.js  " + error.message); }
console.log(bad ? "\\n" + bad + " dosya BOZUK" : "\\n" + (files.length + 1) + " dosyanın hepsi ayrıştı");
process.exit(bad ? 1 : 0);
`;
const run = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", child], { encoding: "utf8" });
process.stdout.write(run.stdout || "");
process.stderr.write(run.stderr || "");
process.exit(run.status === 0 ? 0 : 1);
