// Ayrıştırma yöntemi: kitaplık rozeti, şarkı bilgisi satırı, yükselt düğmesi ve onay metni (frontend/js/quality.js).
//
//     node tests\quality_test.mjs

import { methodOf, badgeOf, upgradeOf, describeMethod, upgradeConfirmText, formatDate } from "../frontend/js/quality.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const v2 = { state: "done", quality: "hifi", pipeline: "hifi_v2" };
const v1 = { state: "done", quality: "hifi" };                       // pipeline alanı yok = hifi_v1
const v1explicit = { state: "done", quality: "hifi", pipeline: "hifi_v1" };
const std = { state: "done", quality: "standard", pipeline: "standard" };
const stdOld = { state: "done", quality: "standard" };               // pipeline yok
const legacy = { state: "done" };                                    // Aşama 9 öncesi: ikisi de yok

// --- rozet
check("v2: 'Hi-Fi v2'", badgeOf(v2).text === "Hi-Fi v2" && badgeOf(v2).cls === "hifi");
check("v1 (pipeline yok): 'Hi-Fi', v1 sınıfı", badgeOf(v1).text === "Hi-Fi" && badgeOf(v1).cls === "hifi v1");
check("v1 (pipeline açıkça hifi_v1): aynı", badgeOf(v1explicit).text === "Hi-Fi" && badgeOf(v1explicit).cls === "hifi v1");
check("standard (pipeline standard): 'Standart'", badgeOf(std).text === "Standart" && badgeOf(std).cls === "standard");
check("standard (pipeline yok): 'Standart'", badgeOf(stdOld).text === "Standart");
check("hiç alan yok (eski şarkı): 'Standart'", badgeOf(legacy).text === "Standart");
check("gelecek sürüm hifi_v3: 'Hi-Fi v3', yükseltme yok", badgeOf({ ...v2, pipeline: "hifi_v3" }).text === "Hi-Fi v3" && upgradeOf({ ...v2, pipeline: "hifi_v3" }) === null);
check("tanınmayan boru hattı: rozet yok (yanlış etiket vermez)", badgeOf({ state: "done", quality: "hifi", pipeline: "tuhaf" }) === null);

// --- ayrıştırma sürerken / hata: rozet yok (quality hemen yazılır, pipeline bitince gelir; yoksa yeni yükleme 'v1' görünürdü)
check("separating (quality=hifi, pipeline henüz yok): rozet YOK", badgeOf({ state: "separating", quality: "hifi" }) === null);
check("analyzing / error: rozet yok", badgeOf({ state: "analyzing", quality: "hifi" }) === null && badgeOf({ state: "error", quality: "hifi" }) === null);
check("state verilmemişse (oynatıcı status'u) bitmiş sayılır", methodOf({ quality: "hifi", pipeline: "hifi_v2" }).kind === "v2");
check("null / boş girdi patlamaz", badgeOf(null) === null && badgeOf(undefined) === null && upgradeOf(null) === null && describeMethod(null) === "");

// --- yükselt düğmesi
check("standart -> 'Hi-Fi'a yükselt'", upgradeOf(std).label === "Hi-Fi'a yükselt" && upgradeOf(std).kind === "hifi" && upgradeOf(legacy).kind === "hifi");
check("v1 -> 'v2'ye yükselt'", upgradeOf(v1).label === "v2'ye yükselt" && upgradeOf(v1).kind === "v2" && upgradeOf(v1explicit).kind === "v2");
check("v2 -> düğme yok", upgradeOf(v2) === null);
check("işleniyorken düğme yok", upgradeOf({ state: "separating", quality: "hifi" }) === null);

// --- tarih (UTC, sabit): 2026-10-01T12:00:00Z
const stamp = Date.UTC(2026, 9, 1, 12) / 1000;
check("tarih Türkçe: '1 Ekim 2026'", formatDate(stamp) === "1 Ekim 2026");
check("geçersiz tarih boş", formatDate(0) === "" && formatDate(undefined) === "" && formatDate("x") === "");

// --- bilgi satırı
check("v2 satırı: model + tarih", describeMethod({ ...v2, stems_version: stamp })
  === "Hi-Fi v2 · vokal, piyano, davul: BS-RoFormer SW · bas, gitar, diğer: htdemucs_6s · 1 Ekim 2026");
check("v1 satırı", describeMethod({ ...v1, stems_version: stamp }) === "Hi-Fi (v1) · vokal: BS-RoFormer SW · kalanı: htdemucs_6s · 1 Ekim 2026");
check("standart satırı; stems_version yoksa tarih eklenmez", describeMethod(legacy) === "Standart · htdemucs_6s");
check("işlenen şarkıda satır boş", describeMethod({ state: "separating", quality: "hifi" }) === "");

// --- onay metni
const text = upgradeConfirmText(upgradeOf(v1));
check("onay: alt parçaların SİLİNECEĞİ açık yazıyor (ana/arka vokal, davul parçaları)", /Alt parçalar \(ana\/arka vokal, davul parçaları\) SİLİNİR/.test(text));
check("onay: v2 hedefi anılıyor, korunanlar sayılıyor", text.includes("Hi-Fi v2") && text.includes("Akor, vuruş, mikser ayarı ve A-B noktaları korunur"));
check("onay: sözler uyarısı", text.includes("eski ayrıştırmadan"));
check("onay: Hi-Fi yükseltmesinde de alt parça uyarısı, hedef 'Hi-Fi'", upgradeConfirmText(upgradeOf(std)).includes("SİLİNİR") && !upgradeConfirmText(upgradeOf(std)).includes("Hi-Fi v2"));
check("onay: ayrılmış alt parça varsa ayrıca belirtilir", upgradeConfirmText(upgradeOf(v1), { hasSubs: true }).includes("ayrılmış alt parça var")
  && !upgradeConfirmText(upgradeOf(v1)).includes("ayrılmış alt parça var"));
check("yükseltme yoksa onay metni boş", upgradeConfirmText(null) === "");

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
