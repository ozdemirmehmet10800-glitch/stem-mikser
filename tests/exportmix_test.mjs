// Dışa aktarma arayüzü mantığı (saf, DOM/ağ yok). Sentetik kanallar.
//
//     node tests\exportmix_test.mjs

import {
  leafGains, presetLabel, buildRequest, summarize, tempoNote, regionNote, formatBytes, formatElapsed,
  errorMessage, runExport, ExportFailure, mimeFor, shareSupported, waitHint, MISC_LABEL,
} from "../frontend/js/exportmix.js";
import { ApiError } from "../frontend/js/api.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const LABELS = {
  vocals: "Vokal", drums: "Davul", bass: "Bas", guitar: "Gitar", piano: "Piyano", other: "Diğer",
  lead: "Ana vokal", backing: "Arka vokal", kick: "Kick", snare: "Snare", toms: "Tom", hihat: "Hi-hat", cymbals: "Zil",
};
const base = () => new Map(["vocals", "drums", "bass", "guitar", "piano", "other"].map((n) => [
  n, { fader: 1, mute: false, solo: false, children: null, parent: null }]));
function mix(over = {}, expandVocals = false) {
  const channels = base();
  if (expandVocals) {
    channels.get("vocals").children = ["lead", "backing"];
    channels.set("lead", { fader: 1, mute: false, solo: false, parent: "vocals" });
    channels.set("backing", { fader: 1, mute: false, solo: false, parent: "vocals" });
  }
  for (const [name, patch] of Object.entries(over)) Object.assign(channels.get(name), patch);
  return channels;
}

// --- kazançlar
let g = leafGains(mix());
check("hepsi açık: 6 kanal, kazanç 1", Object.keys(g).length === 6 && g.vocals === 1);
g = leafGains(mix({ vocals: { mute: true } }));
check("susturulan kanal gitmez", !("vocals" in g) && Object.keys(g).length === 5);
g = leafGains(mix({ drums: { solo: true } }));
check("solo: yalnız solo kanal", Object.keys(g).join() === "drums");
g = leafGains(mix({ bass: { fader: 0.5 } }));
check("fader kazanca yansır", g.bass === 0.5);
g = leafGains(mix({ lead: { fader: 1.5 }, vocals: { fader: 1.5 } }, true));
check("açık grup: ana kanal GİTMEZ, alt parçalar gider", !("vocals" in g) && "lead" in g && "backing" in g);
check("alt parça kazancı = kendi x grup fader'ı (2.25 -> sınır 2)", g.lead === 2);
g = leafGains(mix({ vocals: { mute: true } }, true));
check("ana vokal susturulunca alt parçalar da susar", !("lead" in g) && !("backing" in g));
g = leafGains(mix({ lead: { mute: true } }, true));
check("yalnız ana vokal kapalı: arka vokal kalır", !("lead" in g) && g.backing === 1 && !("vocals" in g));

// --- ön ayar adı
check("varsayılan mikser: Miks", presetLabel(mix()) === MISC_LABEL);
check("Karaoke", presetLabel(mix({ vocals: { mute: true } })) === "Karaoke");
check("Karaoke (arka vokal kalsın)", presetLabel(mix({ lead: { mute: true } }, true)) === "Karaoke (arka vokal kalsın)");
check("Davulu ben çalıyorum", presetLabel(mix({ drums: { mute: true } })) === "Davulu ben çalıyorum");
check("Yalnız vokal", presetLabel(mix({ vocals: { solo: true } })) === "Yalnız vokal");
check("ön ayar + fader oynandı -> Miks", presetLabel(mix({ vocals: { mute: true }, bass: { fader: 0.7 } })) === "Miks");
check("iki kanal kapalı -> Miks", presetLabel(mix({ vocals: { mute: true }, drums: { mute: true } })) === "Miks");
check("alt parça açık, ön ayar yok -> Miks", presetLabel(mix({}, true)) === "Miks");

// --- istek gövdesi
let r = buildRequest({ channels: mix({ lead: { mute: true } }, true), masterPercent: 100, options: { format: "m4a" } });
check("istek: etiket ön ayar adı", r.ok && r.body.label === "Karaoke (arka vokal kalsın)");
check("istek: ana kanal yok, alt parçalar var", r.ok && !("vocals" in r.body.gains) && r.body.gains.backing === 1 && !("lead" in r.body.gains));
check("istek: varsayılan hız/ton/bölge alanı YOK", r.ok && !("rate" in r.body) && !("semitones" in r.body) && !("region" in r.body));
check("istek: ana ses 1", r.ok && r.body.master === 1 && r.body.format === "m4a");
r = buildRequest({ channels: mix(), masterPercent: 80, rate: 0.8, semitones: 2, loop: { a: 80, b: 105 },
  options: { format: "wav", useTempo: true, useRegion: true } });
check("istek: hız ton bölge, wav, ana ses 0.8", r.ok && r.body.rate === 0.8 && r.body.semitones === 2
  && r.body.region.a === 80 && r.body.region.b === 105 && r.body.format === "wav" && r.body.master === 0.8);
r = buildRequest({ channels: mix(), masterPercent: 100, rate: 0.8, semitones: 2, loop: { a: 80, b: 105 }, options: {} });
check("istek: kutular kapalıysa hız/ton/bölge gitmez", r.ok && !("rate" in r.body) && !("semitones" in r.body) && !("region" in r.body));
r = buildRequest({ channels: mix(), masterPercent: 100, rate: 1, semitones: 0, loop: { a: 90, b: 20 }, options: { useRegion: true, useTempo: true } });
check("istek: bozuk döngü (b<a) bölge göndermez", r.ok && !("region" in r.body));
r = buildRequest({ channels: mix({ vocals: { mute: true }, drums: { mute: true }, bass: { mute: true },
  guitar: { mute: true }, piano: { mute: true }, other: { mute: true } }), masterPercent: 100 });
check("istek: hiçbir kanal duyulmuyorsa reddedilir", !r.ok && /kanal/.test(r.problem));
r = buildRequest({ channels: mix(), masterPercent: 0 });
check("istek: ana ses 0 reddedilir", !r.ok && /Ana ses/.test(r.problem));
r = buildRequest({ channels: mix(), masterPercent: 150, options: {} });
check("istek: ana ses %150 sınırı", r.ok && r.body.master === 1.5);
r = buildRequest({ channels: mix(), masterPercent: 100, rate: 0.83333333, options: { useTempo: true } });
check("istek: hız 4 basamağa yuvarlanır", r.ok && r.body.rate === 0.8333);

// --- plak gibi
r = buildRequest({ channels: mix(), masterPercent: 100, rate: 0.85, semitones: 3, vinyl: true, options: { useTempo: true } });
check("plak gibi: istekte vinyl + oran, ton GİTMEZ", r.ok && r.body.vinyl === true && r.body.rate === 0.85 && !("semitones" in r.body));
r = buildRequest({ channels: mix(), masterPercent: 100, rate: 1, vinyl: true, options: { useTempo: true } });
check("plak gibi + oran 1: vinyl alanı yok", r.ok && !("vinyl" in r.body) && !("rate" in r.body));
r = buildRequest({ channels: mix(), masterPercent: 100, rate: 0.85, vinyl: true, options: {} });
check("hız/ton kutusu kapalıysa vinyl de gitmez", r.ok && !("vinyl" in r.body) && !("rate" in r.body));
check("özet/not: '0,85x plak gibi'", /0,85x plak gibi/.test(summarize({ channels: mix(), labels: LABELS, rate: 0.85, vinyl: true, options: { useTempo: true } }))
  && tempoNote(0.85, 0, true) === "0,85x plak gibi" && tempoNote(0.85, -3, false) === "0,85x, -3 yarım ton");

// --- özet
const sum = (over, extra = {}) => summarize({ channels: mix(over, extra.expand), labels: LABELS, ...extra });
check("özet: örnek cümle", summarize({ channels: mix({ lead: { mute: true } }, true), labels: LABELS, rate: 0.8,
  options: { useTempo: true } }) === "Ana vokal kapalı, arka vokal açık, 0,8x");
check("özet: hepsi açık", sum({}) === "Tüm kanallar açık");
check("özet: karaoke", sum({ vocals: { mute: true } }) === "Vokal kapalı");
check("özet: iki kapalı", sum({ vocals: { mute: true }, drums: { mute: true } }) === "Vokal kapalı, davul kapalı");
check("özet: solo -> diğerleri kapalı", /Vokal kapalı/.test(sum({ drums: { solo: true } })) && /piyano kapalı/.test(sum({ drums: { solo: true } })));
check("özet: seviye notu", /farklı seviyede/.test(sum({ bass: { fader: 0.5 } })));
check("özet: ana ses", /ana ses %80/.test(sum({}, { masterPercent: 80 })));
check("özet: hız+ton yalnız kutu açıksa", /1,25x, \+2 yarım ton/.test(sum({}, { rate: 1.25, semitones: 2, options: { useTempo: true } }))
  && !/yarım ton/.test(sum({}, { rate: 1.25, semitones: 2, options: {} })));
check("özet: bölge", /yalnız 1:20–1:45/.test(sum({}, { loop: { a: 80, b: 105 }, options: { useRegion: true } })));
check("not: orijinal", tempoNote(1, 0) === "şu an orijinal hız ve ton" && tempoNote(0.8, -2) === "0,8x, -2 yarım ton");
check("not: bölge", regionNote({ a: 80, b: 105 }) === "1:20 – 1:45" && regionNote(null) === "");
check("bayt ve süre biçimi", formatBytes(4_840_000) === "4,6 MB" && formatBytes(0) === "" && formatElapsed(12_400) === "12 sn" && formatElapsed(75_000) === "1 dk 15 sn");
check("bekleme ipucu sayı içerir", /\d+ saniye/.test(waitHint(158)) && /saniye/.test(waitHint(0)));

// --- hata mesajları
const E = (message, opts) => new ApiError(message, opts);
check("hata: çevrimdışı", /İnternet yok/.test(errorMessage(E("x", { kind: "offline" }))));
check("hata: ağ", /ulaşılamadı/.test(errorMessage(E("x", { kind: "network" }))));
check("hata: token", /Token/.test(errorMessage(E("x", { kind: "auth", status: 401 }))));
check("hata: 404 süre doldu", /24 saat/.test(errorMessage(E("x", { kind: "notfound", status: 404 }))));
check("hata: 409 başka dışa aktarma", /Başka bir dışa aktarma sürüyor/.test(errorMessage(E("Baska bir disa aktarma suruyor", { status: 409 }))));
check("hata: 409 şarkı hazır değil", /henüz hazır değil/.test(errorMessage(E("Sarki henuz hazir degil", { status: 409 }))));
check("hata: 409 bilinmeyen", /Biraz sonra/.test(errorMessage(E("baska", { status: 409 }))));
check("hata: 400 kanal yok", /En az bir kanalı aç/.test(errorMessage(E("Hicbir kanal duyulmuyor", { status: 400 }))));
check("hata: 400 alt parça çakışması", /alt parçaları/.test(errorMessage(E("vocals ile alt parcasi (lead) birlikte karistirilamaz", { status: 400 }))));
check("hata: 400 bilinmeyen kanal", /yeniden açıp/.test(errorMessage(E("Bilinmeyen ya da kullanilamayan kanal: lead", { status: 400 }))));
check("hata: 400 bölge", /A-B/.test(errorMessage(E("bolge en az 0.1 sn olmali", { status: 400 }))));
check("hata: 500", /Sunucu hatası/.test(errorMessage(E("x", { status: 502 }))));
check("hata: iş mesajı olduğu gibi", errorMessage(new ExportFailure("Dışa aktarma başarısız: x")) === "Dışa aktarma başarısız: x");
check("hata mesajı ham ASCII detayı sızdırmıyor (409)", !/suruyor/.test(errorMessage(E("Baska bir disa aktarma suruyor", { status: 409 }))));

// --- iş akışı (sahte api, sahte saat)
function fakeApi(script) {
  const calls = { start: 0, poll: 0, bodies: [] };
  return {
    calls,
    startExport: async (id, body) => { calls.start += 1; calls.bodies.push(body); return script.start(calls); },
    getExport: async () => { calls.poll += 1; return script.poll(calls); },
  };
}
let clock = 0;
const opts = { sleep: async (ms) => { clock += ms; }, now: () => clock };

clock = 0;
let api = fakeApi({ start: () => ({ hash: "h1", state: "running" }),
  poll: (c) => (c.poll < 3 ? { state: "running" } : { state: "done", filename: "Zeus - Karaoke.m4a", format: "m4a", bytes: 4840000, duration: 158.3 }) });
const updates = [];
let res = await runExport({ api, songId: "s", body: { format: "m4a" }, onUpdate: (u) => updates.push(u), ...opts });
check("akış: yoklayıp tamamlar", res.filename === "Zeus - Karaoke.m4a" && res.hash === "h1" && api.calls.poll === 3 && !res.existing);
check("akış: ilerleme güncellemeleri", updates[0].phase === "starting" && updates.some((u) => u.phase === "rendering" && u.elapsedMs > 0));

api = fakeApi({ start: () => ({ hash: "h2", state: "done", existing: true, filename: "a.m4a", bytes: 10, duration: 5 }), poll: () => { throw new Error("yoklanmamalı"); } });
res = await runExport({ api, songId: "s", body: { format: "wav" }, ...opts });
check("akış: önbellek isabeti yoklamaz", res.existing && res.filename === "a.m4a" && res.format === "wav" && api.calls.poll === 0);

api = fakeApi({ start: () => ({ hash: "h3", state: "running" }), poll: () => ({ state: "error", message: "ffmpeg" }) });
let caught = null;
try { await runExport({ api, songId: "s", body: {}, ...opts }); } catch (error) { caught = error; }
check("akış: iş hatası ExportFailure", caught instanceof ExportFailure && /ffmpeg/.test(caught.message));

clock = 0;
api = fakeApi({ start: () => ({ hash: "h4", state: "running" }), poll: () => ({ state: "running" }) });
caught = null;
try { await runExport({ api, songId: "s", body: {}, giveUpMs: 10_000, ...opts }); } catch (error) { caught = error; }
check("akış: zaman aşımı mesajı", caught instanceof ExportFailure && /uzun sürdü/.test(caught.message) && api.calls.poll < 10);

api = fakeApi({ start: () => ({ hash: "h5", state: "running" }),
  poll: (c) => { if (c.poll <= 2) throw new ApiError("x", { kind: "network" }); return { state: "done", filename: "f.m4a", bytes: 1, duration: 1 }; } });
res = await runExport({ api, songId: "s", body: { format: "m4a" }, ...opts });
check("akış: geçici ağ hatası işi öldürmez", res.filename === "f.m4a" && api.calls.poll === 3);

api = fakeApi({ start: () => ({ hash: "h6", state: "running" }), poll: () => { throw new ApiError("x", { kind: "network" }); } });
caught = null;
try { await runExport({ api, songId: "s", body: {}, ...opts }); } catch (error) { caught = error; }
check("akış: ardışık ağ hatası sonunda atar", caught instanceof ApiError && api.calls.poll === 3);

api = fakeApi({ start: () => ({ hash: "h7", state: "running" }), poll: () => { throw new ApiError("Bulunamadı.", { kind: "notfound", status: 404 }); } });
caught = null;
try { await runExport({ api, songId: "s", body: {}, ...opts }); } catch (error) { caught = error; }
check("akış: 404 hemen atar (yeniden denenmez)", caught instanceof ApiError && api.calls.poll === 1);

api = fakeApi({ start: () => { throw new ApiError("Baska bir disa aktarma suruyor", { kind: "http", status: 409 }); }, poll: () => ({}) });
caught = null;
try { await runExport({ api, songId: "s", body: {}, ...opts }); } catch (error) { caught = error; }
check("akış: 409 başlangıçta atar, mesaj anlaşılır", caught && /Başka bir dışa aktarma/.test(errorMessage(caught)) && api.calls.poll === 0);

let cancelled = false;
api = fakeApi({ start: () => ({ hash: "h8", state: "running" }), poll: () => ({ state: "running" }) });
res = await runExport({ api, songId: "s", body: {}, isCancelled: () => cancelled, ...opts,
  sleep: async () => { cancelled = true; } });
check("akış: iptal edilince {cancelled}", res.cancelled === true);

check("mime ve paylaşım desteği", mimeFor("m4a") === "audio/mp4" && mimeFor("wav") === "audio/wav"
  && shareSupported({ canShare() {}, share() {} }) === true && shareSupported({ share() {} }) === false && shareSupported(null) === false);

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
