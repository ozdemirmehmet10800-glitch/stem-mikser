// service worker kabuğu (sw.js SHELL): listedeki her dosya diskte VAR ve index.html'in yüklediği / app.js'in import ettiği her dosya listede.
// Çevrimdışı açılışta eksik bir modül "uygulama hiç açılmıyor" demek (bayat/eksik kabuk), bu yüzden yeni dosya eklenince listeye girmesi şart.
//   node tests\sw_shell_files_test.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const root = fileURLToPath(new URL("../frontend/", import.meta.url));
const sw = readFileSync(path.join(root, "sw.js"), "utf8");
const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
check("SHELL listesi bulundu", Boolean(block));
const shell = [...block[1].replace(/\/\/.*$/gm, "").matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);

const missingOnDisk = shell.filter((file) => !existsSync(path.join(root, file)));
check("SHELL'deki her dosya diskte var", missingOnDisk.length === 0, missingOnDisk.join(", "));

// app.js'in (ve onun import ettiklerinin) statik import zinciri
const seen = new Set();
const queue = ["js/app.js"];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = readFileSync(path.join(root, file), "utf8");
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"(\.[^"]+)"/g)) {
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    queue.push(next);
  }
}
const notListed = [...seen].filter((file) => !shell.includes(file));
check("app.js import zincirindeki her modül SHELL'de", notListed.length === 0, notListed.join(", "));

const html = readFileSync(path.join(root, "index.html"), "utf8");
const links = [...html.matchAll(/(?:href|src)="((?:css|js|icons)\/[^"]+)"/g)].map((m) => m[1]);
const linksMissing = links.filter((file) => !shell.includes(file));
check("index.html'in yüklediği css/js/ikon dosyaları SHELL'de", linksMissing.length === 0, linksMissing.join(", "));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
