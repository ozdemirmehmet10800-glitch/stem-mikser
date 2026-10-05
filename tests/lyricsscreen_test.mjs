// Tam ekran sözler: yaşam döngüsü, satır konumu, nabız, görünürlükte durma ve "aç/kapa iz bırakmaz".
// Sahte DOM + SENTETİK satırlar (gerçek söz yok).
//
//     node tests\lyricsscreen_test.mjs

import { LyricsScreen, ROWS_DEFAULT, ROWS_MIN, ROWS_MAX, normalizeRows } from "../frontend/js/lyricsscreen.js";
import { pickBeats } from "../frontend/js/beatpulse.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

import { live, FakeEl, makeEnv } from "./fakedom.mjs";

function lines(n = 20) {
  return Array.from({ length: n }, (_, i) => ({ t: 5 + i * 4, e: 5 + i * 4 + 3, text: `Sentetik satir ${i + 1}`, w: [], ...(i === 7 ? { c: 0 } : {}) }));
}

function makeScreen(env, extra = {}) {
  const calls = { seek: [], toggle: 0, request: 0, closed: 0, wakeReq: 0, wakeRel: 0, settings: 0 };
  const wakeLock = { request() { calls.wakeReq += 1; }, release() { calls.wakeRel += 1; } };
  const screen = new LyricsScreen({
    ui: env.ui, createEl: (tag) => new FakeEl(tag), doc: env.doc, win: env.win, wakeLock,
    keepAwake: () => Boolean(extra.keepAwake), reducedMotion: () => Boolean(extra.reduced),
    onSeek: (i) => calls.seek.push(i), onTogglePlay: () => { calls.toggle += 1; },
    onRequestClose: () => { calls.request += 1; }, onClosed: () => { calls.closed += 1; },
    onSettings: () => { calls.settings += 1; },
  });
  // satır ölçüleri: her satır 50 px, ardışık
  const origOpen = screen.open.bind(screen);
  screen.open = (opts) => {
    origOpen(opts);
    env.ui.track.children.forEach((item, i) => { item.offsetTop = i * 50; item.offsetHeight = 50; });
    screen.tick(opts.time || 0, true);
  };
  return { screen, calls };
}

const baseListeners = () => live.listeners;

// --- açılış ve konum
let env = makeEnv();
let { screen, calls } = makeScreen(env);
const startListeners = baseListeners();
check("kalıcı dinleyiciler 7 (iz, oynat, kapat, ayar, wheel, touchmove, şimdiye dön)", startListeners === 7, String(startListeners));
screen.open({ lines: lines(), lang: "tr", title: "Sentetik", mode: "plain", time: 30, playing: true });
check("açılınca görünür, satırlar kurulur", env.ui.root.hidden === false && env.ui.track.children.length === 20);
check("başlık ve dil", env.ui.title.textContent === "Sentetik" && env.ui.track.lang === "tr");
check("wake lock istendi", calls.wakeReq === 1);
// 30 sn: highlightTime 30.25 -> satır i: 5+4i <= 30.25 -> i=6 (29)
const cur = env.ui.track.children.findIndex((c) => c.has("cur"));
check("o anki satır cur", cur === 6, `cur ${cur}`);
check("üstte ve altta 3'er satır: uzaklık --k = 1..3", [5, 7].every((i) => env.ui.track.children[i].has("dist") && env.ui.track.children[i].style["--k"] === "1")
  && [3, 9].every((i) => env.ui.track.children[i].has("dist") && env.ui.track.children[i].style["--k"] === "3")
  && env.ui.track.children[4].style["--k"] === "2" && env.ui.track.children[8].style["--k"] === "2");
check("kademe ayardan: --lf-span = satır - 1", env.ui.root.style["--lf-span"] === String(ROWS_DEFAULT - 1));
check("pencere dışı satırda sınıf yok", [0, 1, 2, 10, 11, 19].every((i) => ![...env.ui.track.children[i]._classes].some((c) => ["cur", "dist", "next"].includes(c))));
check("düşük güvenli satır işaretli (low)", env.ui.track.children[7].has("low") && !env.ui.track.children[6].has("low"));
check("satır sahnenin ortasına kaydırıldı (scrollTo: merkez - sahne merkezi)", env.ui.stage.scrollTop === 25, String(env.ui.stage.scrollTop));
check("açılışta anında (auto), sonra yumuşak", env.ui.stage.scrolls[0].behavior === "auto");
env.win.flushFrames();
check("ilk/son satır ortalanabilsin diye iz dolgusu", env.ui.track.style.paddingTop === "300px" && env.ui.track.style.paddingBottom === "300px");

// satır değişimi
screen.tick(34, false);
check("satır değişince cur taşınır", env.ui.track.children[7].has("cur") && !env.ui.track.children[6].has("cur") && env.ui.track.children[6].has("dist"));
check("eski pencerenin dışına düşen satırın sınıfı temizlenir", ["cur", "dist", "next"].every((c) => !env.ui.track.children[1].has(c)));
check("bir satır kayar, yumuşak", env.ui.stage.scrollTop === 75 && env.ui.stage.scrolls.at(-1).behavior === "smooth", String(env.ui.stage.scrollTop));

// aynı satırda DOM'a dokunulmaz
let ops = 0;
const probe = env.ui.track.children[7];
const addOrig = probe.classList.add;
probe.classList.add = (...a) => { ops += 1; return addOrig(...a); };
const scrollsBefore = env.ui.stage.scrolls.length;
for (let t = 34; t < 35.5; t += 0.016) screen.tick(t, false);
check("aynı satırda kare başı DOM/kaydırma işi yok", ops === 0 && env.ui.stage.scrolls.length === scrollsBefore);
probe.classList.add = addOrig;

// ara müzik: son satırdan sonra 3+ sn
screen.tick(5 + 19 * 4 + 3 + 3.5, false);
check("ara müzik/son: cur yok, ortada sıradaki/son satır 'next'", !env.ui.track.children.some((c) => c.has("cur")) && env.ui.track.children[19].has("next"));
screen.tick(1, false);
check("ilk satırdan önce: ilk satır 'next'", env.ui.track.children[0].has("next") && !env.ui.track.children.some((c) => c.has("cur")));

// kullanıcı kaydırması
screen.tick(34, false);
const scrollsA = env.ui.stage.scrolls.length;
env.ui.stage.fire("scroll");
check("scroll olayı kullanıcı sayılmaz (yalnız touch/wheel)", env.ui.followBtn.hidden === true && !env.ui.root.has("browsing"));
env.ui.stage.fire("touchmove");
check("touchmove: takip durur, 'Şimdiye dön' çıkar, gezinme kipi", env.ui.followBtn.hidden === false && env.ui.root.has("browsing"));
screen.tick(38.1, false);
check("kaydırırken vurgu satırı güncellenir ama sahne KAYDIRILMAZ", env.ui.track.children[8].has("cur") && env.ui.stage.scrolls.length === scrollsA);
env.ui.stage.fire("wheel");
check("wheel de aynı (ikinci kez bir şey değişmez)", env.ui.followBtn.hidden === false);
env.ui.followBtn.fire("click");
check("'Şimdiye dön': takip yeniden, düğme gizli, o anki satıra kaydırıldı",
  env.ui.followBtn.hidden === true && !env.ui.root.has("browsing") && env.ui.stage.scrollTop === 125,
  String(env.ui.stage.scrollTop));
env.ui.stage.fire("touchmove");
env.ui.track.fire("click", { target: env.ui.track.children[9] });
check("kaydırma sonrası satıra dokununca takip yeniden başlar", env.ui.followBtn.hidden === true && !env.ui.root.has("browsing"));
calls.seek.length = 0;

// dokunma
env.ui.track.fire("click", { target: env.ui.track.children[9] });
check("iz tıklaması -> onSeek(9)", calls.seek.join() === "9");
env.ui.track.fire("click", { target: env.ui.track });
check("boşluğa dokunma işlem yapmaz", calls.seek.length === 1);
env.ui.playBtn.fire("click");
env.ui.closeBtn.fire("click");
env.ui.settingsBtn.fire("click");
check("oynat / kapat isteği / ayar düğmeleri", calls.toggle === 1 && calls.request === 1 && calls.settings === 1);
check("kapat düğmesi ekranı kendisi kapatmaz (geri tuşu yolu app'te)", screen.isOpen === true && calls.closed === 0);

screen.close();
check("kapanınca gizli, satırlar silinir, onClosed çağrılır", env.ui.root.hidden && env.ui.track.children.length === 0 && calls.closed === 1);
check("kapanınca wake lock bırakılır (çalma yok)", calls.wakeRel === 1);
check("kapanınca document/window dinleyicisi kalmaz", live.listeners === startListeners, String(live.listeners));

// --- tek satırlı / boş
env = makeEnv();
({ screen, calls } = makeScreen(env));
screen.open({ lines: [{ t: 2, e: 4, text: "tek" }], mode: "plain", time: 0 });
check("tek satır: patlamaz, ilk satır next", env.ui.track.children[0].has("next"));
screen.setLines([], null);
check("sözler boşalırsa ekran kapanır", screen.isOpen === false && calls.closed === 1);
screen.close();

// --- nabız
env = makeEnv();
({ screen, calls } = makeScreen(env));
const beats = pickBeats({ kicks: Array.from({ length: 40 }, (_, i) => 10 + i * 0.5) });
screen.open({ lines: lines(), mode: "pulse", beats, playing: true, time: 9.9 });
env.win.flushFrames();
check("nabız kipinde pulse öğesi görünür, akış gizli", env.ui.pulse.hidden === false && env.ui.flow.hidden === true);
let fired = 0;
for (let t = 9.9; t < 12.0; t += 0.016) { screen.tick(t, false); }
fired = (env.ui.pulse.allAnims || []).length;
check("vuruş başına bir nabız (2.1 sn ~ 4-5 vuruş)", fired >= 4 && fired <= 5, `nabız ${fired}`);
check("animasyon yalnız transform + opacity", (env.ui.pulse.allAnims || []).every((a) => a.frames.every((f) => Object.keys(f).every((k) => ["opacity", "transform"].includes(k)))));
screen.tick(40, false);                   // büyük atlama: ateşleme yok
const afterJump = env.ui.pulse.allAnims.length;
check("atlamada nabız ateşlenmez", afterJump === fired);
screen.setPlaying(false);
check("duraklatınca canlı nabız iptal", live.anims === 0);
const beforePause = env.ui.pulse.allAnims.length;
for (let t = 10; t < 11; t += 0.016) screen.tick(t, false);
check("çalmıyorsa nabız yok", env.ui.pulse.allAnims.length === beforePause);
screen.setPlaying(true);
for (let t = 20; t < 20.7; t += 0.016) screen.tick(t, false);
env.doc.visibilityState = "hidden";
env.doc.fire("visibilitychange");
check("uygulama arka plana gidince canlı animasyon iptal, paused sınıfı", live.anims === 0 && env.ui.root.has("paused"));
const hiddenCount = env.ui.pulse.allAnims.length;
for (let t = 20.7; t < 22; t += 0.016) screen.tick(t, false);
check("gizliyken tick hiçbir şey yapmaz", env.ui.pulse.allAnims.length === hiddenCount);
env.doc.visibilityState = "visible";
env.doc.fire("visibilitychange");
check("geri gelince paused kalkar", !env.ui.root.has("paused"));
screen.close();
check("kapanınca animasyon yok", live.anims === 0);

// --- azaltılmış hareket
env = makeEnv();
({ screen, calls } = makeScreen(env, { reduced: true }));
screen.open({ lines: lines(), mode: "both", beats, playing: true, time: 9.9 });
for (let t = 9.9; t < 11; t += 0.016) screen.tick(t, false);
check("prefers-reduced-motion: nabız animasyonu yok", (env.ui.pulse.allAnims || []).length === 0);
screen.close();

// --- ızgara kaynağı: ölçü başı güçlü
env = makeEnv();
({ screen, calls } = makeScreen(env));
const grid = pickBeats({ grid: { beats: Array.from({ length: 20 }, (_, i) => 10 + i * 0.5), downbeats: [10, 12, 14] } });
screen.open({ lines: lines(), mode: "both", beats: grid, playing: true, time: 9.9 });
check("akış + nabız birlikte", !env.ui.flow.hidden && !env.ui.pulse.hidden);
for (let t = 9.9; t < 10.1; t += 0.016) screen.tick(t, false);
check("ölçü başı daha güçlü nabız", env.ui.pulse.allAnims[0].frames[0].opacity > 0.5);
screen.close();

// --- medya
env = makeEnv("visible");
({ screen, calls } = makeScreen(env));
let revoked = 0;
screen.open({ lines: lines(), mode: "custom", media: { kind: "video", url: "blob:x", revoke: () => { revoked += 1; } }, time: 0 });
const video = env.ui.media.children[0];
check("video: sessiz, döngü, satır içi, otomatik başlar", video.tagName === "VIDEO" && video.muted === true && video.loop === true && video.playsInline === true && video.played === 1);
check("özel arka planda has-media sınıfı (koyu perde)", env.ui.root.has("has-media"));
env.doc.visibilityState = "hidden"; env.doc.fire("visibilitychange");
check("gizlenince video durur", video.paused >= 1);
env.doc.visibilityState = "visible"; env.doc.fire("visibilitychange");
check("görünür olunca video devam", video.played === 2);
screen.close();
check("kapanınca video bırakılır ve URL iptal edilir", video.attrs.has("src") === false && revoked === 1 && env.ui.media.children.length === 0 && !env.ui.root.has("has-media"));
screen.open({ lines: lines(), mode: "custom", media: { kind: "image", url: "blob:y", revoke: () => { revoked += 1; } }, time: 0 });
check("resim: img öğesi", env.ui.media.children[0].tagName === "IMG" && env.ui.media.children[0].src === "blob:y");
screen.setMedia(null);
check("ortam kaldırılınca URL iptal", revoked === 2 && !env.ui.root.has("has-media"));
screen.close();

// --- gizliyken açılırsa duraklı başlar
env = makeEnv("hidden");
({ screen, calls } = makeScreen(env));
screen.open({ lines: lines(), mode: "pulse", beats, playing: true, time: 9.9 });
check("arka plandayken açılırsa paused başlar", env.ui.root.has("paused"));
screen.close();

// --- çalarken kapatınca wake lock korunur
env = makeEnv();
({ screen, calls } = makeScreen(env, { keepAwake: true }));
screen.open({ lines: lines(), mode: "plain", time: 0 });
screen.close();
check("çalarken kapatınca ekran kilidi BIRAKILMAZ (oynatıcı tutuyor)", calls.wakeReq === 1 && calls.wakeRel === 0);

// --- aç/kapa iz bırakmaz
env = makeEnv();
({ screen, calls } = makeScreen(env));
const persistent = live.listeners;
let revokedAll = 0;
let madeMedia = 0;
for (let i = 0; i < 60; i += 1) {
  const mode = ["plain", "flow", "pulse", "both", "custom"][i % 5];
  const media = mode === "custom" ? (madeMedia += 1, { kind: i % 2 ? "video" : "image", url: `blob:${i}`, revoke: () => { revokedAll += 1; } }) : null;
  screen.open({ lines: lines(), mode, beats, media, playing: true, time: 9.9 });
  for (let t = 9.9; t < 10.6; t += 0.016) screen.tick(t, false);
  if (i % 7 === 0) { env.doc.visibilityState = "hidden"; env.doc.fire("visibilitychange"); env.doc.visibilityState = "visible"; env.doc.fire("visibilitychange"); }
  if (i % 3 === 0) screen.close(); // bazı turlar kapatmadan yeniden aç
}
screen.close();
env.win.flushFrames();
check("60 aç/kapa sonrası dinleyici sayısı başa döndü", live.listeners === persistent, `${live.listeners} / ${persistent}`);
check("canlı animasyon 0", live.anims === 0, String(live.anims));
check("bekleyen requestAnimationFrame 0", live.frames.size === 0, String(live.frames.size));
check("her özel ortamın URL'i iptal edildi", revokedAll === madeMedia, `${revokedAll}/${madeMedia}`);
check("satır ve ortam düğümleri kalmadı", env.ui.track.children.length === 0 && env.ui.media.children.length === 0);
check("wake lock istek/bırakma dengeli (son durum: bırakılmış)", calls.wakeRel >= 1 && calls.wakeReq >= calls.wakeRel);
check("varsayılan 3, aralık 1-5", ROWS_DEFAULT === 3 && ROWS_MIN === 1 && ROWS_MAX === 5);

// --- "Görünen satır" ayarı
check("normalizeRows: 1-5 kalır, dışı/bozuk varsayılan", [1, 2, 3, 4, 5].every((n) => normalizeRows(n) === n && normalizeRows(String(n)) === n)
  && [0, 6, -1, NaN, null, undefined, "x", 2.6].map(normalizeRows).join() === "3,3,3,3,3,3,3,3");
env = makeEnv();
({ screen, calls } = makeScreen(env));
screen.open({ lines: lines(), mode: "plain", time: 30, rows: 3 });
const items = () => env.ui.track.children;
const distCount = () => items().filter((c) => c.has("dist")).length;
check("3 satır: üstte 3 + altta 3 'dist', ortada tek cur", distCount() === 6 && items().filter((c) => c.has("cur")).length === 1);
screen.setRows(1);
check("ekran AÇIKKEN 1'e düşürme hemen uygulanır: yalnız 1+1 satır", distCount() === 2 && items()[5].has("dist") && items()[7].has("dist")
  && items()[4].has("dist") === false && env.ui.root.style["--lf-span"] === "1");
check("1 satır: --k 1 (en yakın = 0,5 opaklık, kademe bölünmesi 1'e sabit)", items()[5].style["--k"] === "1" && items()[7].style["--k"] === "1");
check("o anki satır ve konumu değişmedi", items()[6].has("cur") && env.ui.stage.scrollTop === 25);
screen.setRows(5);
check("5'e çıkarma hemen uygulanır: 5+5 satır, span 4", distCount() === 10 && items()[1].style["--k"] === "5" && items()[11].style["--k"] === "5"
  && items()[0].has("dist") === false && env.ui.root.style["--lf-span"] === "4");
screen.setRows(2);
check("5'ten 2'ye: artan dış satırların sınıfı temizlenir", distCount() === 4 && ["cur", "dist", "next"].every((c) => !items()[2].has(c) && !items()[10].has(c)));
screen.setRows(99);
check("geçersiz değer varsayılana (3) döner", distCount() === 6);
const scrollsBeforeRows = env.ui.stage.scrolls.length;
screen.setRows(3);
check("aynı değer: iş yok", env.ui.stage.scrolls.length === scrollsBeforeRows && distCount() === 6);
screen.close();
screen.setRows(4);
check("kapalıyken setRows patlamaz, sonraki açılış yeni değeri kullanır", (screen.open({ lines: lines(), mode: "plain", time: 30 }), distCount()) === 8);
screen.close();
env = makeEnv();
const custom = new LyricsScreen({ ui: env.ui, createEl: (tag) => new FakeEl(tag), doc: env.doc, win: env.win, rows: 5 });
check("kurucu rows ayarı", env.ui.root.style["--lf-span"] === "4" && custom.rows === 5);
env.win.flushFrames();

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
