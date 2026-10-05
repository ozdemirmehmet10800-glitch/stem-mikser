// Ayarlar'daki "Sürüm: SW vNN" satırı (frontend/js/swversion.js) ve sw.js'in "surum" yanıtı.
//
//     node tests\swversion_test.mjs

import { readFileSync } from "node:fs";
import { shellVersionFromKeys, askWorker, versionLabel } from "../frontend/js/swversion.js";
import { loadSw } from "./sw_harness.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

// sahte MessageChannel: port2'ye gelen yanıt port1.onmessage'e gider
function fakeChannel() {
  const channel = { port1: { onmessage: null }, port2: {} };
  channel.port2.postMessage = (data) => queueMicrotask(() => channel.port1.onmessage && channel.port1.onmessage({ data }));
  return channel;
}
const answering = (version) => ({ postMessage(message, ports) { if (message === "surum") ports[0].postMessage(version); } });
const silent = { postMessage() {} };

// --- cache adlarından sürüm
check("kabuk cache'i: en yüksek sürüm", shellVersionFromKeys(["stem-mikser-v9", "stem-mikser-v54", "stem-mikser-v10"]) === "v54");
check("uygulama cache'leri (stems-v1, share-v1) ve yabancılar sayılmaz", shellVersionFromKeys(["stem-mikser-stems-v1", "stem-mikser-share-v1", "baska-v3"]) === null);
check("boş / geçersiz girdi", shellVersionFromKeys([]) === null && shellVersionFromKeys(null) === null && shellVersionFromKeys(["stem-mikser-v"]) === null);

// --- worker'a sorma
check("worker yanıtlar: v54", await askWorker(answering("v54"), { makeChannel: fakeChannel }) === "v54");
check("yanıt gelmezse (eski worker) null, takılmaz", await askWorker(silent, { timeoutMs: 30, makeChannel: fakeChannel }) === null);
check("saçma yanıt reddedilir", await askWorker(answering("<b>x</b>"), { makeChannel: fakeChannel }) === null);
check("worker yok / postMessage patlar: null", await askWorker(null) === null
  && await askWorker({ postMessage() { throw new Error("x"); } }, { makeChannel: fakeChannel }) === null);

// --- ayar satırı
const keys = async () => ["stem-mikser-v54", "stem-mikser-stems-v1"];
check("çalışan worker: 'Sürüm: SW v54'", await versionLabel({ controller: answering("v54"), cacheKeys: keys, makeChannel: fakeChannel }) === "Sürüm: SW v54");
check("worker yanıtsız: cache adından, '(önbellekten)' notuyla", await versionLabel({ controller: silent, cacheKeys: keys, timeoutMs: 30, makeChannel: fakeChannel }) === "Sürüm: SW v54 (önbellekten)");
check("worker da cache de yok: bilinmiyor", (await versionLabel({ controller: null, cacheKeys: async () => [] })).startsWith("Sürüm: SW bilinmiyor"));
check("caches.keys patlarsa yine satır döner", (await versionLabel({ controller: null, cacheKeys: async () => { throw new Error("x"); } })).startsWith("Sürüm: SW bilinmiyor"));

// --- gerçek sw.js: "surum" mesajına kendi VERSION'ıyla yanıt verir; "temizle" davranışı bozulmaz
const version = readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8").match(/const VERSION = "(v\d+)"/)[1];
const sw = await loadSw();
const replies = [];
await sw.fire("message", { data: "surum", ports: [{ postMessage: (value) => replies.push(value) }] });
check(`sw.js 'surum' isteğine ${version} yanıtlar`, replies.length === 1 && replies[0] === version);
await sw.fire("message", { data: "surum", ports: [] });
await sw.fire("message", { data: "baska" });
check("portsuz / bilinmeyen mesaj patlamaz, yanıt yok", replies.length === 1);
await sw.fire("message", { data: "temizle" });
check("'temizle' hâlâ çalışır (unregister)", sw.calls.unregister === 1);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
