// Service worker `activate`: yalnız ESKİ KABUK cache'leri silinir (stem-mikser-v<sayı>); uygulamanın kendi cache'lerine
// (çevrimdışı stem'ler, paylaşılan dosya) dokunulmaz.
//
//     node tests\sw_activate_test.mjs

import { loadSw, fakeCaches } from "./sw_harness.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const version = (await import("node:fs")).readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8")
  .match(/const VERSION = "(v\d+)"/)[1];

const current = Number(version.slice(1));
const old = ["v1", `v${current - 2}`, `v${current - 1}`].map((v) => `stem-mikser-${v}`);
const caches = fakeCaches({
  [old[0]]: 1, [old[1]]: 1, [old[2]]: 1, [`stem-mikser-${version}`]: 1,
  "stem-mikser-stems-v1": 1, "stem-mikser-share-v1": 1, "baska-uygulama": 1,
});
const entry = await caches.open("stem-mikser-stems-v1");
await entry.put("https://example.test/stem-mikser/songs/x/stems/vocals.m4a", new Response("m4a"));

const sw = await loadSw({ caches });
await sw.fire("activate");
const left = await caches.keys();

check(`eski kabuk cache'leri silinir (${old.join(", ")})`, !left.some((key) => old.includes(key)));
check("güncel kabuk cache'i kalır", left.includes(`stem-mikser-${version}`));
check("ÇEVRİMDIŞI STEM cache'i silinmez (stem-mikser-stems-v1)", left.includes("stem-mikser-stems-v1"));
check("stem cache'inin içeriği duruyor", (await (await caches.open("stem-mikser-stems-v1")).keys()).length === 1);
check("paylaşım cache'i silinmez (stem-mikser-share-v1)", left.includes("stem-mikser-share-v1"));
check("başka adlı cache'e dokunulmaz", left.includes("baska-uygulama"));
check("clients.claim çağrıldı", sw.calls.claim === 1);

// Sürüm numarası artınca (v49 -> v50): bir önceki kabuk silinir, stem'ler yine kalır
const next = fakeCaches({ [`stem-mikser-${version}`]: 1, "stem-mikser-stems-v1": 1 });
const sw2 = await loadSw({ caches: next });
sw2.self.location = new URL("https://example.test/stem-mikser/sw.js");
await sw2.fire("activate");
check("güncel sürümle tekrar activate: stem cache'i yine kalır", (await next.keys()).includes("stem-mikser-stems-v1"));

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
