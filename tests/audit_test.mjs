// Denetimde bulunan sorunların korumaları (2026-11-26): ayar kaydı hafıza dolunca çökmez; klasik görünümde telefon genişliğinde
// oynatıcı yana taşmaz; tema/vurgu rengi klasik görünümde etkisizken seçilebilir görünmez; HTML'de çift kimlik ve olay bağlanıp
// sayfada olmayan öğe yok.   node tests\audit_test.mjs

import { readFileSync } from "node:fs";
import { saveSettings } from "../frontend/js/settings.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").split(String.fromCharCode(13)).join("");

// ------------------------------------------------------------------ ayar kaydı: kota dolu
{
  const full = { setItem() { throw new Error("QuotaExceededError"); } };
  let threw = false;
  let result = null;
  try {
    result = saveSettings({ url: "https://ornek.modal.run/", token: " abc " }, full);
  } catch {
    threw = true;
  }
  check("hafıza doluyken ayar kaydı ATMAZ", !threw);
  check("ayar bu oturumda geçerli (temizlenmiş değerler döner)", result && result.url === "https://ornek.modal.run" && result.token === "abc");
  check("kaydedilemediği işaretlenir, JSON'a girmez", result && result.unsaved === true && !JSON.stringify(result).includes("unsaved"));
  const mem = new Map();
  const ok = saveSettings({ url: "https://x.modal.run" }, { setItem: (k, v) => mem.set(k, v) });
  check("normal kayıtta işaret yok, değer yazılır", ok.unsaved === undefined && mem.size === 1);
  const app = read("../frontend/js/app.js");
  check("Ayarlar > Kaydet: kaydedilemezse kullanıcı uyarılır", /if \(settings\.unsaved\) showMessage\(el\("settings-message"\)/.test(app));
}

// ------------------------------------------------------------------ klasik görünüm, telefon genişliği
{
  const app = read("../frontend/js/app.js");
  const css = read("../frontend/css/styles.css");
  check("dar ekranda 'Hi-Fi'a yükselt' üst satıra taşınır (her iki görünümde)",
    /const target = isNewLook\(\) \|\| narrowScreen\(\) \? row : right;/.test(app) && /matchMedia\("\(max-width: 720px\)"\)\.addEventListener\("change", \(\) => placeReprocess\(\)\)/.test(app));
  check("dar ekran kontrolü açılışta erken çağrılsa da güvenli (fonksiyon, sabit değil)", /function narrowScreen\(\) \{/.test(app) && !/const narrowScreen =/.test(app));
  const narrow = css.slice(css.indexOf("@media (max-width: 720px) {"), css.indexOf("/* ---------- hız ve ton ---------- */"));
  check("klasik alt çubuk sütunları daralabilir (sayfa yana taşmaz)", /\.transport-row \{ grid-template-columns: auto minmax\(0, 1fr\) auto minmax\(0, 1fr\);/.test(narrow) && /\.master input \{ min-width: 0; width: 100%; \}/.test(narrow));
  check("görünüm değişince düğme yeniden yerleşir", /refreshLookOnlySettings\(\);\s*placeReprocess\(\);/.test(app));
}

// ------------------------------------------------------------------ yalnız yeni görünümde çalışan ayarlar
{
  const app = read("../frontend/js/app.js");
  const html = read("../frontend/index.html");
  check("tema ve kapaktan vurgu rengi klasik görünümde pasif + not", /for \(const id of \["setting-theme", "setting-songtheme"\]\) if \(el\(id\)\) el\(id\)\.disabled = !on;/.test(app)
    && /id="look-only-note" hidden/.test(html));
  check("Ayarlar açılırken durum güncellenir", /el\("setting-spin"\)\.checked = applySpinSetting\(\);\s*refreshLookOnlySettings\(\);/.test(app));
}

// ------------------------------------------------------------------ HTML / JS kimlik tutarlılığı
{
  const html = read("../frontend/index.html");
  const app = read("../frontend/js/app.js");
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  check("HTML'de çift kimlik yok (getElementById hep ilkini bulur, ikincisi sessizce çalışmaz)", dupes.length === 0, dupes.join(", "));
  const known = new Set(ids);
  const bound = [...app.matchAll(/\bon\("([a-z0-9-]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(bound)].filter((id) => !known.has(id));
  check("olay bağlanan her öğe sayfada var (yoksa düğme sessizce çalışmaz)", missing.length === 0, missing.join(", "));
}

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
