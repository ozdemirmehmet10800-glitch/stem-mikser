// Yeni görünümün kabuğu (js/shell.js): sekme eşlemesi, kök katman sayımı, sekme planı, küçük oynatıcı modeli, çalmanın sürme kuralı.
//   node tests\shell_test.mjs

import { readFileSync } from "node:fs";
import { tabForView, dockVisible, layersToRoot, tabPlan, clock, miniModel, keepPlayingOnLeave, needsMiniLoop, MINI_TICK_MS } from "../frontend/js/shell.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

check("sekme: kitaplık/listeler/liste/ayarlar", tabForView("library") === "library" && tabForView("lists") === "lists" && tabForView("list") === "lists" && tabForView("settings") === "settings");
check("Eklenecekler ekranı Listeler sekmesine bağlı; [lists, wishes] iki geri", tabForView("wishes") === "lists" && layersToRoot(["lists", "wishes"]) === 2 && tabPlan("wishes", "library", ["lists", "wishes"]).pops === 2);
check("oynatıcıda sekme yok, dock gizli", tabForView("player") === null && !dockVisible("player") && dockVisible("library"));
check("bilinmeyen ekran -> sekme yok", tabForView("x") === null && tabForView(undefined) === null);

check("kök katman sayımı: boş yığın 0", layersToRoot([]) === 0);
check("[lists, list] -> 2", layersToRoot(["lists", "list"]) === 2);
check("[view] (ayarlar) -> 1", layersToRoot(["view"]) === 1);
check("[select] -> 1", layersToRoot(["select"]) === 1);
check("üstte başka katman varsa dokunma (menu)", layersToRoot(["lists", "menu"]) === 0);
check("üstten ardışık sayar, aradaki yabancıda durur", layersToRoot(["lists", "panel", "list"]) === 1);

check("aynı sekme: pops 0, same", JSON.stringify(tabPlan("library", "library", [])) === JSON.stringify({ pops: 0, open: null, same: true }));
check("listeden kitaplığa: 2 geri, açılacak yok", JSON.stringify(tabPlan("list", "library", ["lists", "list"])) === JSON.stringify({ pops: 2, open: null, same: false }));
check("ayarlardan listelere: 1 geri sonra lists aç", JSON.stringify(tabPlan("settings", "lists", ["view"])) === JSON.stringify({ pops: 1, open: "lists", same: false }));
check("kitaplıktan ayarlara: 0 geri sonra settings aç", JSON.stringify(tabPlan("library", "settings", [])) === JSON.stringify({ pops: 0, open: "settings", same: false }));
check("liste ayrıntısındayken Listeler sekmesi aynı sekme", tabPlan("list", "lists", ["lists", "list"]).same === true);
check("geçersiz hedef -> null", tabPlan("library", "x", []) === null);

check("clock", clock(0) === "0:00" && clock(65) === "1:05" && clock(3725) === "1:02:05" && clock(-3) === "0:00" && clock(NaN) === "0:00");

const song = { id: "a".repeat(64), title: "Deneme Şarkısı" };
const m1 = miniModel({ song, loaded: true, playing: true, view: "library", position: 65, duration: 200 });
check("mini: görünür, çalıyor, ilerleme", m1.visible && m1.playing && Math.abs(m1.progress - 0.325) < 1e-9 && m1.sub === "Çalıyor · 1:05 / 3:20" && m1.title === "Deneme Şarkısı", JSON.stringify(m1));
const m2 = miniModel({ song, loaded: true, playing: false, view: "settings", position: 0, duration: 0 });
check("mini: süre bilinmiyorsa yalnız durum, ilerleme 0", m2.visible && m2.sub === "Duraklatıldı" && m2.progress === 0);
check("mini: oynatıcı ekranında görünmez", !miniModel({ song, loaded: true, playing: true, view: "player", position: 1, duration: 9 }).visible);
check("mini: şarkı yoksa ya da ses bellekte değilse görünmez", !miniModel({ song: null, loaded: true, playing: false, view: "library" }).visible && !miniModel({ song, loaded: false, playing: false, view: "library" }).visible);
check("mini: başlık yoksa kimlik başı", miniModel({ song: { id: "abcdef0123456789ff", title: "  " }, loaded: true, playing: false, view: "library" }).title === "abcdef012345");
check("mini: konum süreyi aşarsa ilerleme 1'i geçmez", miniModel({ song, loaded: true, playing: true, view: "library", position: 999, duration: 100 }).progress === 1);

const base = { newLook: true, playing: true, hasSong: true, inPlaylist: false, micActive: false, trainerOpen: false };
check("çalma sürer: yeni görünüm + çalıyor", keepPlayingOnLeave(base));
check("klasik görünümde durur (eski davranış)", !keepPlayingOnLeave({ ...base, newLook: false }));
check("çalmıyorsa 'sürsün' yok", !keepPlayingOnLeave({ ...base, playing: false }));
check("silinen/yok şarkıda durur", !keepPlayingOnLeave({ ...base, hasSong: false }));
check("çalma listesi modunda durur", !keepPlayingOnLeave({ ...base, inPlaylist: true }));
check("mikrofon açıkken durur", !keepPlayingOnLeave({ ...base, micActive: true }));
check("antrenör paneli açıkken durur", !keepPlayingOnLeave({ ...base, trainerOpen: true }));

check("mini döngü: yalnız çalarken ve oynatıcı dışında", needsMiniLoop({ newLook: true, playing: true, view: "library", hasSong: true })
  && !needsMiniLoop({ newLook: true, playing: true, view: "player", hasSong: true })
  && !needsMiniLoop({ newLook: true, playing: false, view: "library", hasSong: true })
  && !needsMiniLoop({ newLook: false, playing: true, view: "library", hasSong: true }));
check("mini yoklama aralığı 500 ms (CPU bütçesi: saniyede 2)", MINI_TICK_MS === 500);

// CSS: `html.ui-new .X { display: ... }` özgüllüğü (0,2,1) düz `.X[hidden]` kuralını (0,2,0) EZER; gizlenebilen kabuk öğeleri kapsamlı [hidden] kuralı taşımalı.
const modern = readFileSync(new URL("../frontend/css/modern.css", import.meta.url), "utf8");
check("modern.css: dock ve mini için kapsamlı [hidden] kuralı var",
  /html\.ui-new \.dock\[hidden\]\s*\{\s*display:\s*none/.test(modern) && /html\.ui-new \.mini\[hidden\]\s*\{\s*display:\s*none/.test(modern));
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
check("index.html: dock ve mini hidden başlıyor, sekme düğmeleri 3 adet",
  /id="dock" hidden/.test(html) && /id="mini" hidden/.test(html) && (html.match(/class="tab"/g) || []).length === 3);

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
