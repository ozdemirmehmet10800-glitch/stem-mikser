// Görünüm tercihi (js/look.js): ?klasik=1 kurtarma yolu, varsayılan YENİ, kayıt okunamazsa yeni, yeni görünüm tercihi diğer ayarlara
// dokunmaz.   node tests\look_test.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const require = createRequire(import.meta.url);
const look = require("../frontend/js/look.js");

function memStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}
function fakeDoc() {
  const classes = new Set();
  return { classes, documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } } };
}

// varsayılan: yeni
check("kayıt yok -> yeni", look.resolve("", memStorage()).look === "new");
check("parametresiz tercih 'classic' -> klasik", look.resolve("", memStorage({ [look.KEY]: "classic" })).look === "classic");
check("bozuk kayıt -> yeni", look.resolve("", memStorage({ [look.KEY]: "??" })).look === "new");
check("storage yok (null) -> yeni", look.resolve("", null).look === "new");
check("storage atıyor -> yeni", look.resolve("", { getItem() { throw new Error("blok"); } }).look === "new");

// ?klasik=1 kurtarma yolu: klasik + KALICI
const s1 = memStorage();
const r1 = look.resolve("?klasik=1", s1);
check("?klasik=1 -> klasik", r1.look === "classic" && r1.fromUrl);
check("?klasik=1 tercihi kaydeder (yeniden açınca da klasik)", s1.data[look.KEY] === "classic" && look.resolve("", s1).look === "classic");
check("?klasik=1 başka parametrelerle", look.resolve("?x=2&klasik=1&paylasim=1", memStorage()).look === "classic");
const s2 = memStorage({ [look.KEY]: "classic" });
check("?klasik=0 yeniye döndürür ve kaydeder", look.resolve("?klasik=0", s2).look === "new" && s2.data[look.KEY] === "new");
check("?klasik=2 (geçersiz) yok sayılır", look.resolve("?klasik=2", memStorage()).look === "new");
check("?xklasik=1 yanlış eşleşmez", look.resolve("?xklasik=1", memStorage()).look === "new");
const broken = { getItem() { return null; }, setItem() { throw new Error("kota"); } };
const r3 = look.resolve("?klasik=1", broken);
check("kayıt yazılamazsa o oturum yine klasik, persisted=false", r3.look === "classic" && r3.persisted === false);

// uygulama
const doc = fakeDoc();
look.apply("new", doc);
check("apply(new) html'e ui-new ekler", doc.classes.has("ui-new") && look.current(doc) === "new");
look.apply("classic", doc);
check("apply(classic) ui-new'i kaldırır", !doc.classes.has("ui-new") && look.current(doc) === "classic");
const s4 = memStorage({ "stem-mikser.settings": "{\"url\":\"x\"}", "stem-mikser.collection": "{}" });
look.set("classic", s4, doc);
check("set() yalnız kendi anahtarını yazar (ayarlar / collection dokunulmaz)",
  s4.data["stem-mikser.settings"] === "{\"url\":\"x\"}" && s4.data["stem-mikser.collection"] === "{}" && s4.data[look.KEY] === "classic");

// tema (koyu / sahne siyahı / aydınlık)
check("tema: varsayılan dark, geçersiz/bozuk -> dark", look.readTheme(memStorage()) === "dark" && look.readTheme(memStorage({ [look.THEME_KEY]: "??" })) === "dark" && look.readTheme(null) === "dark");
check("tema: yaz/oku (black, light)", (() => { const s = memStorage(); look.setTheme("black", s, fakeDocTheme()); return look.readTheme(s) === "black"; })());
const themeDoc = fakeDocTheme();
look.applyTheme("light", themeDoc);
check("applyTheme: data-theme ve theme-color meta güncellenir", themeDoc.attrs["data-theme"] === "light" && themeDoc.meta.content === "#f4f6fa");
look.applyTheme("yok", themeDoc);
check("applyTheme: geçersiz tema dark'a düşer", themeDoc.attrs["data-theme"] === "dark" && themeDoc.meta.content === "#07090d");
const st = memStorage({ "stem-mikser.settings": "{}", "stem-mikser.collection": "{}" });
look.setTheme("light", st, fakeDocTheme());
check("setTheme yalnız kendi anahtarını yazar", st.data["stem-mikser.settings"] === "{}" && st.data["stem-mikser.collection"] === "{}" && st.data[look.THEME_KEY] === "light");
function fakeDocTheme() {
  const attrs = {};
  const meta = { content: "", setAttribute(k, v) { if (k === "content") this.content = v; } };
  return { attrs, meta, documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add() {}, remove() {}, contains() { return false; } } }, querySelector: () => meta };
}

// index.html: betik ve stil yüklü, betik <head>'de ve stil dosyasından ÖNCE (yanıp sönme olmasın)
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
const head = html.slice(0, html.indexOf("</head>"));
check("index.html <head> içinde look.js var", /<script src="js\/look\.js"><\/script>/.test(head));
check("look.js, modern.css'ten önce (boyamadan önce sınıf konur)", head.indexOf("js/look.js") > -1 && head.indexOf("js/look.js") < head.indexOf("css/modern.css"));
check("modern.css, styles.css'ten SONRA (üstüne biner)", head.indexOf("css/styles.css") < head.indexOf("css/modern.css"));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
