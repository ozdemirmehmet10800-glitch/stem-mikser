// şarkı söyleme antrenörü (Mikrofon paketi 9, 2. oturum)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { LatencyMonitor, MIN_SAMPLES, PlayWatch, SampleRing, TOTAL_DEFAULT, bestShift, clampTotal, decideAlign, latencyVerdict, songTimeAt, suggestTotalMs } from "../latency.js";
import { MelodyCache } from "../melodycache.js";
import { Mic } from "../mic.js";
import { NoteTrack, Scoreboard, decodeMelody, judge, segmentNotes } from "../melody.js";
import { PitchSmoother, midiToHz, nearestNote, noteName } from "../pitch.js";
import { RangeEaser, Trail } from "../roll.js";
import { SENSITIVITY_DEFAULT, VoiceGate, calibrateFloor, thresholdDb, validHz } from "../voicegate.js";
import { el } from "../dom.js";
import { vinylPitch } from "../vinyl.js";

let adoptDetail, currentRate, describeError, engine, isOffline, playHooks, refreshTrainerMixChips, requireOnline, stopTrainerMic, api, currentSong, pitchSemis, pollTimer, vinylMode;   // app.js'ten (bind)

// Mantık pitch.js (YIN), melody.js (hedef melodi + puanlama), mic.js (izin / aygıt / akış) içinde; burada yalnız bağlantı ve GEÇİCİ görünüm
// (piyano rulosu, söz satırları, satır başına isabet yüzdesi, canlı nota, seviye + eşik). KURALLAR:
//  - Mikrofon HER ZAMAN Bluetooth olmayan dahili aygıttır (deviceId); varsayılan aygıt yalnız ilk İZİN adımında, kısaca ve açıklamayla açılır.
//  - Mikrofon sesi hiçbir koşulda diske, loga ya da sunucuya gitmez: bu bölüm yalnız worklet'ten gelen SAYILARI ({t, hz, clarity, rmsDb}) görür.
//    Burada saklanan tek şey kullanıcı tercihleri (oktav, toplam gecikme, hassasiyet); ses, perde ya da puan DEPOLANMAZ.
//  - ZAMAN HİZASI (latency.js): şarkı zamanı = ham çalma konumu - (kare gecikmesi + TOPLAM gecikme) x hız, TEK düşüm; ctx.outputLatency formüle girmez
//    (Android Bluetooth gecikmesini tutarsız bildiriyor: aynı Q45'te 279 / 8 ms), yalnız ilk öneri ve uyarı için okunur.
//  - Ortam sesleri: açılışta 2 sn "sessiz kal" kalibrasyonu ortam tabanını ölçer (şarkı çalıyorsa sızan müzik de tabana girer); kapı eşiği =
//    taban + pay (+ Hassasiyet kaydırıcısı). Eşiğin altı / insan sesi aralığı dışı / kısa-titrek algılar rulo ve puana HİÇ girmez (voicegate.js).
//    noiseSuppression KAPALI kalır (perdeyi bozuyor).
// TRAINER-BAŞLANGIÇ
const TRAINER_PREFS_KEY = "stem-mikser.trainer";
export const melodyCache = new MelodyCache();
export const trainerMic = new Mic();
export const trainer = {
  songId: null, version: 0, notes: null, track: null, method: "", source: "",
  smoother: new PitchSmoother(), board: new Scoreboard(), gate: new VoiceGate(), trail: new Trail(),
  easer: new RangeEaser(), easerReady: false, rafId: 0, lastDraw: 0, lastText: 0, drawNow: 0, duckFrom: 1,
  latencyMs: TOTAL_DEFAULT, octave: true, latencyTouched: false,       // latencyMs = TOPLAM gecikme (çıkış + mikrofon + tepki), bkz. latency.js
  monitor: new LatencyMonitor(), samples: new SampleRing(), bluetooth: false, lastLatencyRead: 0,
  alignHistory: [], lastAutoMs: null, lastAutoConfidence: "",
  sensitivity: SENSITIVITY_DEFAULT, sensitivityTouched: false, floorDb: null, thresholdDb: thresholdDb(null, SENSITIVITY_DEFAULT), calib: null,
  collect: null, level: -120, lastPaint: 0, busy: false, pollTimer: 0, message: "", info: null,
};

export function saveTrainerPrefs() {
  try {
    localStorage.setItem(TRAINER_PREFS_KEY, JSON.stringify({ octave: trainer.octave, latencyTotalMs: trainer.latencyTouched ? trainer.latencyMs : undefined, sensitivity: trainer.sensitivityTouched ? trainer.sensitivity : undefined }));
  } catch { /* tercih bu oturumda kalır */ }
}

// Antrenör deneysel ve varsayılan KAPALI (Ayarlar > "Şarkı söyleme antrenörü"): kapalıyken söyle düğmesi görünmez, mikrofon / kalibrasyon /
// panel kodu hiç çalışmaz. Tek bayrak: localStorage "stem-mikser.trainer-on" = "1".
export function trainerEnabled() {
  try {
    return localStorage.getItem("stem-mikser.trainer-on") === "1";
  } catch {
    return false;
  }
}

function trainerSupported() {
  return trainerEnabled() && trainerMic.supported && typeof AudioWorkletNode !== "undefined";
}

export function trainerMicActive() {
  return trainerMic.active;
}

export function melodyStatus() {
  return currentSong() && currentSong().status ? currentSong().status.melody : undefined;
}

// Ton kayması: bağımsız kipte kaydırıcı, "Plak gibi"de oranın TAM (kesirli) perdesi: kullanıcı duyduğu detune'lu müzikle söylüyor.
export function trainerShift() {
  return vinylMode() ? vinylPitch(currentRate()) : pitchSemis();
}

export function trainerText(id, text) {
  const node = el(id);
  if (node && node.textContent !== text) node.textContent = text;
}

export function refreshTrainerChip() {
  const chip = el("trainer-open");
  if (!chip) return;
  const melody = melodyStatus();
  const noVocals = Boolean(melody && melody.state === "no_vocals");
  chip.hidden = !(trainerSupported() && currentSong());
  chip.disabled = noVocals;
  chip.title = noVocals ? "Bu şarkıda vokal yok" : "Şarkıyla birlikte söyle: canlı perden ve hedef melodi";
}

export async function refreshTrainerUi() {
  const panel = el("trainer");
  if (!panel || panel.hidden) return;
  const melody = melodyStatus();
  const line = el("trainer-melody");
  const prepare = el("trainer-prepare");
  prepare.hidden = true;
  let melodyInfo = "";                      // hazırsa uzun durum satırı "Ayrıntılar"a gider (rulo ve sözler öne çıksın)
  if (!melody) {
    line.textContent = "Hedef melodi: henüz hazırlanmadı.";
    prepare.hidden = false;
  } else if (melody.state === "running") {
    line.textContent = "Hedef melodi hazırlanıyor… (bu ekranda kalabilirsin)";
  } else if (melody.state === "no_vocals") {
    line.textContent = "Bu şarkıda vokal yok: hedef melodi çıkarılamaz.";
  } else if (melody.state === "error") {
    line.textContent = `Hedef melodi hazırlanamadı (${melody.message || "hata"}).`;
    prepare.hidden = false;
  } else if (melody.state === "done") {
    const stale = melody.parent_stems_version !== currentSong().status.stems_version;
    const source = melody.source === "lead" ? "ana vokal" : "vokal stem'i";
    if (trainer.notes) {
      melodyInfo = `Hedef melodi: ${trainer.notes.length} nota · ${melody.method || trainer.method} · ${source}`;
      line.textContent = stale ? "Şarkı sonradan yeniden işlendi: hedef melodi eski olabilir." : "";
    } else {
      line.textContent = "Hedef melodi indiriliyor…";
    }
    if (stale) {
      prepare.hidden = false;
      prepare.textContent = "Hedef melodiyi yenile";
    }
  }
  line.hidden = !line.textContent;
  const active = trainerMic.active;
  trainerText("trainer-mic", active ? "Mikrofonu kapat" : "Mikrofonu aç");
  el("trainer-leak").disabled = !active || Boolean(trainer.calib);
  el("trainer-calibrate").disabled = !active || trainer.busy;
  el("trainer-readout").hidden = !active;
  el("tr-roll-wrap").hidden = !trainer.track;
  refreshTrainerMixChips();
  paintTrainerPlay(engine.playing);
  const permission = await trainerMic.permissionState();
  const permissionText = { granted: "verildi", prompt: "sorulacak", denied: "reddedildi (Chrome > site ayarları > mikrofon)" }[permission] || "bilinmiyor";
  const mic = trainerMic.info;
  const parts = [];
  if (melodyInfo) parts.push(melodyInfo);
  parts.push(`Mikrofon izni: ${permissionText}`);
  if (mic) {
    const off = mic.echoCancellation === false && mic.noiseSuppression === false && mic.autoGainControl === false;
    parts.push(`${mic.label || "dahili"} · ${mic.sampleRate || "?"} Hz · yankı/gürültü/kazanç kapalı ${off ? "✓" : "UYGULANMADI ✗"}`);
  }
  trainerText("trainer-info", parts.join(" · "));
  const note = el("trainer-msg");                       // önemli kısa mesaj (ölçüm, otomatik ayar, hata) rulonun üstünde görünür
  note.hidden = !trainer.message;
  trainerText("trainer-msg", trainer.message);
  el("tr-sens").value = String(trainer.sensitivity);
  trainerText("tr-sens-val", String(trainer.sensitivity));
  paintTrainerGate();
  el("trainer-align").disabled = !active || trainer.busy;
  paintLatencyInfo();
  paintAutoMark();
  el("tr-latency").value = String(trainer.latencyMs);
  trainerText("tr-latency-val", `${trainer.latencyMs} ms`);
  el("tr-octave").checked = trainer.octave;
}

export async function loadTrainerMelody() {
  const melody = melodyStatus();
  if (!currentSong() || !melody || melody.state !== "done") return;
  const id = currentSong().id;
  if (trainer.songId === id && trainer.version === melody.version && trainer.notes) return;
  let buffer = await melodyCache.get(id, melody.version);
  if (!buffer) {
    try {
      buffer = await api().getMelody(id);
    } catch (error) {
      trainer.message = isOffline() ? "Hedef melodi cihazda yok ve internet yok." : `Hedef melodi indirilemedi: ${describeError(error)}`;
      refreshTrainerUi();
      return;
    }
    melodyCache.put(id, melody.version, buffer.slice(0));
  }
  if (!currentSong() || currentSong().id !== id) return;
  const decoded = decodeMelody(buffer);
  if (!decoded) {
    trainer.message = "Hedef melodi dosyası bozuk; yeniden hazırlamayı dene.";
    refreshTrainerUi();
    return;
  }
  trainer.songId = id;
  trainer.version = melody.version;
  trainer.notes = segmentNotes(decoded);
  trainer.track = new NoteTrack(trainer.notes);
  trainer.method = decoded.method;
  trainer.source = decoded.source;
  trainer.message = "";
  trainer.board.reset();
  trainer.trail.clear();
  trainer.easerReady = false;
  refreshTrainerUi();
}

export async function prepareTrainerMelody() {
  if (!currentSong() || trainer.busy) return;
  if (!requireOnline(el("player-message"), "Hedef melodiyi hazırlamak")) return;
  const id = currentSong().id;
  const stale = Boolean(melodyStatus() && melodyStatus().state === "done");
  trainer.busy = true;
  try {
    await api().startMelody(id, { replace: stale || (melodyStatus() && melodyStatus().state === "error") });
    adoptDetail(await api().getSong(id));
  } catch (error) {
    trainer.message = describeError(error);
  } finally {
    trainer.busy = false;
  }
  refreshTrainerUi();
  pollTrainerMelody(id);
}

export function pollTrainerMelody(id) {
  clearInterval(trainer.pollTimer);
  const started = Date.now();
  trainer.pollTimer = setInterval(async () => {
    if (!currentSong() || currentSong().id !== id || Date.now() - started > 15 * 60 * 1000) {
      clearInterval(trainer.pollTimer);
      return;
    }
    const state = melodyStatus() && melodyStatus().state;
    if (state !== "running") {
      clearInterval(trainer.pollTimer);
      await loadTrainerMelody();
      refreshTrainerUi();
      refreshTrainerChip();
      return;
    }
    try {
      adoptDetail(await api().getSong(id));
    } catch { /* geçici ağ hatası: bir sonraki turda tekrar */ }
  }, 3000);
}

// Panel içi oynat / duraklat (söylerken aşağı kaydırmak gerekmesin) ve durum şeridi (ölçüm sürüyor / bitti).
function paintTrainerPlay(playing) {
  const button = el("tr-play");
  if (!button) return;
  trainerText("tr-play", playing ? "⏸ Duraklat" : "▶ Çal");
  button.setAttribute("aria-label", playing ? "Duraklat" : "Oynat");
  paintTrainerState();
}

export function paintTrainerState() {
  const box = el("tr-state");
  if (!box) return;
  let text = "";
  let kind = "";
  if (trainerMic.active) {
    if (trainer.calib) {
      const left = Math.max(0, Math.ceil((CALIBRATION_MS - (performance.now() - trainer.calib.started)) / 1000));
      text = `Ortam ölçülüyor… ${left} sn sessiz kal`;
      kind = "measuring";
    } else if (trainer.floorDb === null) {
      text = "Ölçüm yapılamadı: varsayılan eşik kullanılıyor (Kalibre et)";
    } else if (engine.playing) {
      text = "Ölçüm bitti ✓ · söyle!";
      kind = "ready";
    } else {
      text = "Ölçüm bitti ✓ · şarkıyı başlat (▶ Çal) ve söyle";
      kind = "ready";
    }
  }
  box.hidden = !text;
  trainerText("tr-state", text);
  if (box.className !== `tr-state ${kind}`.trim()) box.className = `tr-state ${kind}`.trim();
}

// Çalma düğmesine basılıp 2,5 sn içinde başlamadıysa (mikrofon açıkken) nedeni söyler. Çalma zamanında başlarsa ya da kullanıcı durdurursa
// uyarı ÇIKMAZ; ses motoru yavaşsa (ilk esnetici kurulumu) "başlamadı" değil "hazırlanıyor" der.
export const trainerPlayWatch = new PlayWatch({
  onSlow() {
    const state = engine.ctx ? engine.ctx.state : "yok";
    trainer.message = state === "running"
      ? "Çalma hazırlanıyor… ses motoru yavaş yanıt veriyor, bekle (ses bağlamı: running)."
      : `Çalma başlamadı (ses bağlamı: ${state}). Mikrofonu kapatıp çalmayı başlat, sonra mikrofonu yeniden aç.`;
    refreshTrainerUi();
  },
});

// Çıkış gecikmesi okuması: yalnız bilgi / uyarı (hizayı belirlemez). Çalarken ~1 sn'de bir okunur.
function paintLatencyInfo() {
  const verdict = latencyVerdict({ medianMs: trainer.monitor.median, spreadMs: trainer.monitor.spread, bluetooth: trainer.bluetooth });
  const node = el("tr-latency-info");
  trainerText("tr-latency-info", verdict.text);
  node.style.color = verdict.suspicious ? "var(--warn)" : "";
  trainerText("tr-details-sum", verdict.suspicious ? "Ayrıntılar ve ayarlar ⚠ gecikme uyarısı" : "Ayrıntılar ve ayarlar");
}

function sampleOutputLatency() {
  if (!engine.playing || !engine.ctx || !Number.isFinite(engine.ctx.outputLatency)) return;
  trainer.monitor.add(engine.ctx.outputLatency * 1000);
  if (!trainer.latencyTouched && trainer.monitor.values.length === 3) {
    trainer.latencyMs = suggestTotalMs({ outputMs: trainer.monitor.median, micMs: trainerMic.info ? trainerMic.info.latencyMs : null, bluetooth: trainer.bluetooth });
    el("tr-latency").value = String(trainer.latencyMs);
    trainerText("tr-latency-val", `${trainer.latencyMs} ms`);
  }
  paintLatencyInfo();
}

// Otomatik hizalama: son ~15 sn'de kabul edilen perdelerle hedef arasında en çok isabet veren TOPLAM gecikme; tek dokunuşla uygulanır.
export function trainerAutoAlign() {
  if (!trainerMic.active || !trainer.track) {
    trainer.message = "Otomatik ayar için mikrofon açık ve hedef melodi hazır olmalı.";
    refreshTrainerUi();
    return;
  }
  const found = bestShift(trainer.samples.items, trainer.track, {
    shift: trainerShift(), octave: trainer.octave, loop: engine.loop, duration: engine.duration, currentMs: trainer.latencyMs,
  });
  const decision = decideAlign(found, { currentMs: trainer.latencyMs, history: trainer.alignHistory });
  trainer.alignHistory = decision.history;
  const current = trainer.latencyMs;
  if (decision.apply) {
    trainer.latencyMs = decision.totalMs;
    trainer.latencyTouched = true;
    trainer.lastAutoMs = decision.totalMs;
    trainer.lastAutoConfidence = decision.confidence;
    trainer.trail.clear();
    trainer.samples.clear();
    saveTrainerPrefs();
    trainer.message = `Gecikme ${decision.totalMs} ms (güven: ${decision.confidence}; isabet ${found.currentHits} → ${found.hits} kare). Yeniden söyleyip kontrol et.`;
  } else {
    trainer.message = {
      few: `Otomatik ayar için şarkıyla birlikte en az ~10 sn söyle (şu an ${trainer.samples.items.length} / ${MIN_SAMPLES} kare).`,
      nomatch: "Söylediğin perde hedef melodiyle eşleşmedi; şarkıyla birlikte söyleyip tekrar dene.",
      lowconf: `Emin olamadım (güven: düşük); mevcut değer korunuyor (${current} ms). Şarkıyla birlikte daha net söyleyip tekrar dene.`,
      nogain: `Mevcut değer (${current} ms) zaten uygun; değişmedi.`,
      jump: `Büyük değişiklik (${current} → ${decision.candidateMs} ms): bir kez daha ölç; tutarlıysa uygularım. Mevcut değer korunuyor.`,
    }[decision.reason] || "Otomatik ayar yapılamadı; mevcut değer korunuyor.";
  }
  refreshTrainerUi();
}

// Kaydırıcıda son başarılı otomatik değer işaretli (datalist çentiği) + "Buna dön".
export function paintAutoMark() {
  const list = el("tr-latency-ticks");
  const row = el("tr-auto-last");
  if (!list || !row) return;
  list.textContent = "";
  if (trainer.lastAutoMs === null) {
    row.hidden = true;
    return;
  }
  const option = document.createElement("option");
  option.value = String(trainer.lastAutoMs);
  list.append(option);
  row.hidden = false;
  trainerText("tr-auto-last-text", `Son otomatik değer: ${trainer.lastAutoMs} ms (güven: ${trainer.lastAutoConfidence})${trainer.lastAutoMs === trainer.latencyMs ? " · şu an bu" : ""}`);
  el("tr-auto-restore").hidden = trainer.lastAutoMs === trainer.latencyMs;
}

export function restoreAutoLatency() {
  if (trainer.lastAutoMs === null) return;
  trainer.latencyMs = trainer.lastAutoMs;
  trainer.latencyTouched = true;
  trainer.trail.clear();
  saveTrainerPrefs();
  refreshTrainerUi();
}

// Seviye çubuğu + eşik çizgisi (dBFS -70..0 -> %0..100) ve eşik yazısı.
const levelFraction = (db) => Math.min(Math.max((db + 70) / 70, 0), 1);

function paintTrainerGate() {
  const marker = el("tr-thr");
  if (marker) marker.style.left = `${Math.round(levelFraction(trainer.thresholdDb) * 100)}%`;
  const floor = trainer.floorDb === null ? "ölçülmedi (varsayılan)" : `${Math.round(trainer.floorDb)} dB`;
  trainerText("tr-gate", trainer.calib
    ? "Ortam sesi ölçülüyor: 2 sn sessiz kal…"
    : `Ortam tabanı: ${floor} · eşik: ${Math.round(trainer.thresholdDb)} dB`);
}

export function setTrainerThreshold() {
  trainer.thresholdDb = thresholdDb(trainer.floorDb, trainer.sensitivity);
  paintTrainerGate();
}

function trainerPaint(midi, result) {
  const now = performance.now();
  if (now - trainer.lastPaint < 40) return;
  trainer.lastPaint = now;
  trainerText("tr-note", midi === null ? "—" : noteName(Math.round(midi)));
  const dot = el("tr-cents-dot");
  if (midi === null) {
    trainerText("tr-hz", "");
    dot.classList.remove("on");
    dot.style.left = "50%";
  } else {
    const { cents } = nearestNote(midi);
    trainerText("tr-hz", `${Math.round(midiToHz(midi))} Hz · ${cents >= 0 ? "+" : ""}${Math.round(cents)} cent`);
    dot.classList.add("on");
    dot.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
  }
  const diff = el("tr-diff");
  if (!result || result.target === null) {
    trainerText("tr-target", trainer.notes ? "Hedef: şu an nota yok" : "Hedef: melodi hazır değil");
    trainerText("tr-diff", "");
    diff.className = "tr-diff";
  } else {
    trainerText("tr-target", `Hedef: ${noteName(Math.round(result.target))}`);
    if (result.diffCents === null) {
      trainerText("tr-diff", "söyle!");
      diff.className = "tr-diff miss";
    } else {
      const folded = result.folded ? " (oktav)" : "";
      trainerText("tr-diff", `${result.diffCents >= 0 ? "+" : ""}${Math.round(result.diffCents)} cent${folded}`);
      diff.className = `tr-diff ${result.hit ? "hit" : "miss"}`;
    }
  }
  const total = trainer.board.all();
  trainerText("tr-score", total.total ? `İsabet: %${total.percent} (${total.total} kare)` : "İsabet: —");
  el("tr-level").style.width = `${Math.round(levelFraction(trainer.level) * 100)}%`;
  el("tr-level").parentElement.classList.toggle("gated", trainer.level < trainer.thresholdDb);
}

// Kalibrasyon: ~2 sn boyunca KARE SEVİYELERİ (dBFS sayıları) toplanır; yalnız bu sayıların %90'lık dilimi saklanır, ses değil.
const CALIBRATION_MS = 2000;

export function beginTrainerCalibration() {
  if (!trainerMic.active) return;
  trainer.calib = { values: [], started: performance.now() };
  trainer.gate.reset();
  trainer.smoother.reset();
  trainer.message = engine.playing ? "Müzik çalıyor: sızan müzik de tabana girer. Sessiz kal." : "";
  paintTrainerState();
  refreshTrainerUi();
}

function finishTrainerCalibration() {
  const floor = calibrateFloor(trainer.calib.values);
  trainer.calib = null;
  if (floor === null) {
    trainer.message = "Ortam ölçülemedi (ses akışı yetersiz); varsayılan taban kullanılıyor. Yeniden Kalibre et.";
  } else {
    trainer.floorDb = floor;
    trainer.message = "";
  }
  setTrainerThreshold();
  paintTrainerState();
  refreshTrainerUi();
}

// Süzgeçten çıkan olay: kabul edilen perde değerlendirilir, rulo izine ve puana girer; reddedilen kare yalnız "sessiz" sayılır
// (hedef nota varken sessizlik = kaçırdı; eşiğin altındaki ses hiçbir zaman hit ya da iz üretmez).
function handleGateEvent(event) {
  const { songTime, playing, rawT, rate } = event.meta;
  const midi = event.accepted ? event.midi : null;
  if (midi !== null && playing) trainer.samples.push(rawT, rate, midi);
  const result = trainer.track ? judge(midi, trainer.track, songTime, { shift: trainerShift(), octave: trainer.octave }) : null;
  if (playing && result) trainer.board.add(songTime, result.hit);
  if (midi !== null) {
    const plotted = result && result.target !== null && result.diffCents !== null ? result.target + result.diffCents / 100 : midi;
    trainer.trail.push(songTime, plotted, result ? result.hit : null);
  }
  return { midi, result };
}

// Worklet'ten gelen SAYILAR (t, hz, clarity, rmsDb). Ses örneği burada hiç yok.
export function onTrainerFrame(frame) {
  if (trainerMic.ctx !== engine.ctx) {
    stopTrainerMic("ses bağlamı değişti");
    return;
  }
  trainer.level = frame.rmsDb;
  if (trainer.collect) trainer.collect.push(frame.rmsDb);
  const clock = performance.now();
  if (clock - trainer.lastLatencyRead >= 1000) {          // çıkış gecikmesi okuması ~1 sn'de bir (çizim döngüsüne bağlı değil)
    trainer.lastLatencyRead = clock;
    sampleOutputLatency();
  }
  if (trainer.calib) {
    if (Number.isFinite(frame.rmsDb)) trainer.calib.values.push(frame.rmsDb);
    if (performance.now() - trainer.calib.started >= CALIBRATION_MS) finishTrainerCalibration();
    else paintTrainerState();
    trainerPaint(null, null);
    return;
  }
  const midi = trainer.smoother.push(validHz(frame, trainer.thresholdDb));
  const lag = Math.max(engine.ctx.currentTime - frame.t, 0);
  const rate = engine.rate;
  const raw = engine.rawTime;
  const songTime = songTimeAt({ raw, lagSec: lag, totalMs: trainer.latencyMs, rate, loop: engine.loop, duration: engine.duration, playing: engine.playing });
  let last = { midi: null, result: null };
  for (const event of trainer.gate.push(midi, { songTime, playing: engine.playing, rawT: raw - lag * rate, rate })) last = handleGateEvent(event);
  trainerPaint(last.midi, last.result);
}

export function bind(deps) {
  ({ adoptDetail, currentRate, describeError, engine, isOffline, playHooks, refreshTrainerMixChips, requireOnline, stopTrainerMic, api, currentSong, pitchSemis, pollTimer, vinylMode } = deps);
  (function readTrainerPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(TRAINER_PREFS_KEY) || "{}");
      if (typeof saved.octave === "boolean") trainer.octave = saved.octave;
      if (Number.isFinite(saved.sensitivity)) {
        trainer.sensitivity = Math.min(Math.max(Math.round(saved.sensitivity), 0), 100);
        trainer.sensitivityTouched = true;
        trainer.thresholdDb = thresholdDb(null, trainer.sensitivity);
      }
      if (Number.isFinite(saved.latencyTotalMs)) {
        trainer.latencyMs = clampTotal(saved.latencyTotalMs);
        trainer.latencyTouched = true;
      }
    } catch { /* tercihler bu oturumda varsayılan kalır */ }
  }());

  playHooks.begin = () => { if (trainerMicActive()) trainerPlayWatch.begin(); };
  playHooks.end = () => {
    if (trainerPlayWatch.end()) {          // "hazırlanıyor" uyarısı çıkmıştı, çalma sonunda başladı: uyarıyı sil
      trainer.message = "";
      refreshTrainerUi();
    }
  };
  playHooks.stop = () => trainerPlayWatch.cancel();
  playHooks.icon = (playing) => paintTrainerPlay(playing);
}
