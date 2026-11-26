// js/ui/*.js (app.js'ten ayrılan bölümler) bağlantı denetimi. Kod çalıştırılmaz, kaynak taranır.
//
//     node tests\ui_modules_test.mjs
//
// Her bölüm: `bind` dışa aktarır, app.js onu BİR kez çağırır, app.js'te tanımlı olup modüle verilmeyen (tanımsız kalacak) ad yok,
// değişen değerler getter ile verilir (bind'e düz değer olarak giden ad app.js'te yeniden atanmaz), çevrimdışı kabukta.

import { readFileSync, readdirSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const js = new URL("../frontend/js/", import.meta.url);
const read = (url) => readFileSync(url, "utf8").split(String.fromCharCode(13)).join("");
const app = read(new URL("app.js", js));
const sw = read(new URL("../sw.js", js));
const strip = (text) => text
  .replace(/\.\.\./g, "   ")
  .replace(/\/\/[^\n]*/g, "")
  .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
const appDecl = new Map([...app.matchAll(/^(?:async )?(?:function\*? ([\w$]+)|(?:const|let|var|class) ([\w$]+))/gm)]
  .map((m) => [m[1] || m[2], m[0].startsWith("let ")]));
const reassigned = (name) => new RegExp(`(?<![\\w$.])${name}\\s*(?:=(?!=)|\\+\\+|--|\\+=|-=)`).test(strip(app).replace(new RegExp(`^let ${name}\\b`, "m"), ""));

const modules = readdirSync(new URL("ui/", js)).filter((f) => f.endsWith(".js")).sort();
check("en az bir bölüm ayrılmış", modules.length > 0, modules.join(", "));
check("ortak DOM yardımcıları dom.js'te (app.js'te ikinci tanım yok)", /from "\.\/dom\.js"/.test(app) && !/^function on\(/m.test(app) && !/^const el = /m.test(app));

for (const file of modules) {
  const src = read(new URL(`ui/${file}`, js));
  const imp = app.match(new RegExp(`^import \\{ bind as (\\w+)[^}]*\\} from "\\./ui/${file.replace(".", "\\.")}";`, "m"));
  check(`${file}: bind dışa aktarır ve app.js içe aktarır`, /^export function bind\(/m.test(src) && Boolean(imp));
  if (!imp) continue;
  const calls = [...app.matchAll(new RegExp(`^${imp[1]}\\((.*)\\);$`, "gm"))];
  check(`${file}: app.js bind'i bir kez çağırır`, calls.length === 1, String(calls.length));
  const known = new Set();
  for (const m of src.matchAll(/^import \{([^}]+)\}/gm)) for (const p of m[1].split(",")) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) known.add(n); }
  for (const m of src.matchAll(/(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) known.add(m[1]);
  const bound = (src.match(/^let ([^;]+);\s+\/\/ app\.js/m) || [, ""])[1].split(",").map((n) => n.trim()).filter(Boolean);
  for (const n of bound) known.add(n);
  const importedNames = new Set([...src.matchAll(/^import \{([^}]+)\}/gm)].flatMap((m) => m[1].split(",").map((p) => p.trim().split(/\s+as\s+/)[0])));
  const used = new Set(strip(src).match(/(?<![\w$.])[A-Za-z_$][\w$]*/g));
  const missing = [...used].filter((n) => appDecl.has(n) && !known.has(n) && !importedNames.has(n));
  check(`${file}: app.js'ten verilmeyen ad yok`, missing.length === 0, missing.join(", "));
  const args = calls.length ? calls[0][1] : "";
  const plain = [...args.matchAll(/(?:^\{|,)\s*([\w$]+)(?=\s*[,}])/g)].map((m) => m[1]);
  const stale = plain.filter((n) => appDecl.get(n) === true && reassigned(n));
  check(`${file}: değişen değerler getter ile (düz verilen ad sonradan değişmiyor)`, stale.length === 0, stale.join(", "));
  const lineOf = (index) => app.slice(0, index).split(String.fromCharCode(10)).length;
  const callLine = calls.length ? lineOf(calls[0].index) : 0;
  const declLine = (n) => { const m = new RegExp(`^(?:const|let|var|class) ${n}(?![\\w$])`, "m").exec(app); return m ? lineOf(m.index) : 0; };
  const early = plain.filter((n) => declLine(n) > callLine);
  check(`${file}: bind'e düz verilen ad bind'den ÖNCE tanımlı (yoksa açılışta 'before initialization')`, early.length === 0, early.join(", "));
  // getter olarak verilen ad modülde hep ÇAĞRILMALI (ad()); yalnız nesne anahtarı ({ ad: ... } ya da , ad: ...) istisna.
  const getters = [...args.matchAll(/([\w$]+): \(\) => /g)].map((m) => m[1]);
  const bare = [];
  strip(src).split(String.fromCharCode(10)).forEach((line, i) => {
    if (/^let .*;\s*$/.test(line) || /^\s*\(\{ .* \} = deps\);/.test(line)) return;
    for (const n of getters) {
      for (const m of line.matchAll(new RegExp(`(?<![\\w$.])${n}(?![\\w$(])`, "g"))) {
        const before = line.slice(0, m.index).trimEnd();
        const after = line.slice(m.index + n.length);
        if (/^\s*:/.test(after) && (before === "" || /[{,]$/.test(before))) continue;      // nesne anahtarı
        bare.push(`${i + 1}:${n}`);
      }
    }
  });
  check(`${file}: getter adları hep çağrılıyor (ad())`, bare.length === 0, bare.join(" "));
  // Taşıma aracı bir kez yazı içindeki adı da değiştirmişti ("settings-message" -> "settings()-message"): düz tırnaklı yazılarda getter çağrısı olmamalı.
  const leaked = [];
  for (const m of src.matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g)) {
    for (const n of getters) if (m[0].includes(`${n}()`)) leaked.push(m[0]);
  }
  check(`${file}: yazıların içine getter çağrısı karışmamış`, leaked.length === 0, leaked.join(" "));
  check(`${file}: bind'e verilen her ad modülde karşılanıyor`, plain.every((n) => bound.includes(n))
    && [...args.matchAll(/([\w$]+): \(\) => /g)].every((m) => bound.includes(m[1])));
  check(`${file}: çevrimdışı kabukta`, sw.includes(`"./js/ui/${file}"`));
  const relative = [...src.matchAll(/(?:import\(|fetch\(|addModule\(|new (?:Worker|URL)\()\s*["'`](\.\/[^"'`]+)/g)].map((m) => m[1]);
  check(`${file}: göreli yollar js/ui/'ye göre (./x.js değil ../x.js)`, relative.length === 0, relative.join(", "));
}

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
