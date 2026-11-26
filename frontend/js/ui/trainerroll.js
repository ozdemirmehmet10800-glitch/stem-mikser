// rulo + söz satırları çizimi (rAF, panel açıkken ~30 kare/sn)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { ROLL_FUTURE, ROLL_PAST, drawRoll, targetRange } from "../roll.js";
import { beginTrainerCalibration, loadTrainerMelody, melodyStatus, onTrainerFrame, paintAutoMark, paintTrainerState, pollTrainerMelody, prepareTrainerMelody, refreshTrainerChip, refreshTrainerUi, restoreAutoLatency, saveTrainerPrefs, setTrainerThreshold, trainer, trainerAutoAlign, trainerMic, trainerPlayWatch, trainerShift, trainerText } from "../ui/trainerui.js";
import { el, on } from "../dom.js";
import { findLine, highlightTime } from "../lyrics.js";
import { isBluetoothLabel, leakVerdict } from "../mic.js";
import { songTimeAt, suggestTotalMs } from "../latency.js";

let engine, releasePlaybackWake, scheduleMixSave, startPlayback, stopPlayback, wakeLock, currentSong, lyricsDoc, mixer;   // app.js'ten (bind)

let rollCtx = null;
let rollCanvasKey = "";

function fitRollCanvas() {
  const canvas = el("tr-roll");
  const width = Math.round(canvas.clientWidth);
  const height = Math.round(canvas.clientHeight);
  if (width < 20 || height < 20) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const key = `${width}x${height}@${dpr}`;
  if (key !== rollCanvasKey) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    rollCtx = canvas.getContext("2d");
    rollCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rollCanvasKey = key;
  }
  return { width, height };
}

function paintLineScore(node, percent) {
  const text = percent === null ? "" : `%${percent}`;
  if (node.textContent !== text) node.textContent = text;
  node.className = percent === null ? "" : percent >= 70 ? "" : percent >= 40 ? "mid" : "low";
}

function trainerLyricsPaint(now) {
  const box = el("tr-lyrics");
  const lines = lyricsDoc() ? lyricsDoc().lines : null;
  box.hidden = !lines;
  if (!lines) return;
  const probe = highlightTime(now);
  const index = findLine(lines, probe);
  let doneIndex = -1;
  let nextIndex = -1;
  if (index >= 0) {
    doneIndex = index - 1;
    nextIndex = index + 1 < lines.length ? index + 1 : -1;
  } else {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].t <= probe) doneIndex = i; else { nextIndex = i; break; }
    }
  }
  const span = (line) => ({ t0: line.t, t1: line.e > line.t ? line.e : line.t + 3 });
  trainerText("tr-prev-text", doneIndex >= 0 ? lines[doneIndex].text : "");
  if (doneIndex >= 0) {
    const { t0, t1 } = span(lines[doneIndex]);
    paintLineScore(el("tr-prev-score"), trainer.board.range(t0, t1).percent);
  } else {
    paintLineScore(el("tr-prev-score"), null);
  }
  trainerText("tr-cur-text", index >= 0 ? lines[index].text : "…");
  if (index >= 0) {
    const { t0, t1 } = span(lines[index]);
    paintLineScore(el("tr-cur-score"), trainer.board.range(t0, Math.min(t1, now + 0.05)).percent);
  } else {
    paintLineScore(el("tr-cur-score"), null);
  }
  trainerText("tr-next-text", nextIndex >= 0 ? lines[nextIndex].text : "");
}

function trainerDrawFrame(timestamp) {
  trainer.rafId = 0;
  const panel = el("trainer");
  if (!panel || panel.hidden || document.hidden) return;
  trainer.rafId = requestAnimationFrame(trainerDrawFrame);
  if (timestamp - trainer.lastDraw < 30) return;
  const dt = Math.min((timestamp - trainer.lastDraw) / 1000, 0.25);
  trainer.lastDraw = timestamp;
  const now = songTimeAt({ raw: engine.rawTime, lagSec: 0, totalMs: trainer.latencyMs, rate: engine.rate, loop: engine.loop, duration: engine.duration, playing: engine.playing });
  // Sarma / atlama: iz zaman ekseninde tutarsız kalır -> temizle
  if (now < trainer.drawNow - 0.05 || now > trainer.drawNow + 1.5) trainer.trail.clear();
  trainer.drawNow = now;
  trainer.trail.prune(now);
  const size = trainer.track ? fitRollCanvas() : null;
  if (size && rollCtx) {
    const shift = trainerShift();
    const visible = trainer.track.between(now - ROLL_PAST, now + ROLL_FUTURE);
    const center = (trainer.easer.lo + trainer.easer.hi) / 2;
    const windowTrail = [];
    for (const point of trainer.trail.items) if (point.t >= now - ROLL_PAST && point.t <= now + ROLL_FUTURE) windowTrail.push(point.midi);
    const target = targetRange(visible, shift, trainer.easerReady ? center : 60, windowTrail);
    if (!trainer.easerReady && visible.length) {
      trainer.easer.snap(target);
      trainer.easerReady = true;
    }
    const range = visible.length ? trainer.easer.step(target, dt) : { lo: trainer.easer.lo, hi: trainer.easer.hi };
    drawRoll(rollCtx, {
      width: size.width, height: size.height, now, notes: visible, shift, lo: range.lo, hi: range.hi, trail: trainer.trail.items,
      noteScore: (note) => trainer.board.range(note.t0, note.t1).percent,
    });
  }
  if (timestamp - trainer.lastText >= 100) {
    trainer.lastText = timestamp;
    trainerLyricsPaint(now);
    paintTrainerState();
  }
}

function startTrainerDraw() {
  if (!trainer.rafId) trainer.rafId = requestAnimationFrame(trainerDrawFrame);
}

function stopTrainerDraw() {
  if (trainer.rafId) cancelAnimationFrame(trainer.rafId);
  trainer.rafId = 0;
}

// Karışım kısayolları: mevcut "Karaoke" ön ayarı ve vokal kısma (mikser kaydına normal yoldan yazılır).
const VOCAL_DUCK = 0.3;

export function refreshTrainerMixChips() {
  const vocals = engine.channels.get("vocals");
  const karaoke = el("tr-karaoke");
  const duck = el("tr-duck");
  if (!karaoke || !duck) return;
  karaoke.disabled = !vocals;
  duck.disabled = !vocals;
  karaoke.setAttribute("aria-pressed", String(Boolean(vocals && vocals.mute)));
  duck.setAttribute("aria-pressed", String(Boolean(vocals && !vocals.mute && Math.abs(vocals.fader - VOCAL_DUCK) < 0.011)));
}

function trainerKaraoke() {
  const preset = document.querySelector('#mix-presets [data-preset="karaoke"]');
  if (preset && !preset.disabled) preset.click();
  setTimeout(refreshTrainerMixChips, 50);
}

function trainerDuck() {
  const vocals = engine.channels.get("vocals");
  if (!vocals) return;
  const ducked = Math.abs(vocals.fader - VOCAL_DUCK) < 0.011;
  if (!ducked) trainer.duckFrom = vocals.fader;
  vocals.mute = false;
  engine.setFader("vocals", ducked ? (trainer.duckFrom || 1) : VOCAL_DUCK);
  mixer().syncFromEngine();
  scheduleMixSave();
  refreshTrainerMixChips();
}

async function startTrainerMic() {
  if (trainerMic.active || trainer.busy || !currentSong()) return;
  trainer.busy = true;
  trainer.message = "";
  try {
    const prepared = await trainerMic.prepare();
    if (prepared.status === "unsupported") {
      trainer.message = "Bu tarayıcı mikrofonu / AudioWorklet'i desteklemiyor.";
    } else if (prepared.status === "denied") {
      trainer.message = "Mikrofon izni reddedilmiş. Chrome adres çubuğundaki kilit > İzinler > Mikrofon: İzin ver.";
    } else if (prepared.status === "needs-permission") {
      el("trainer-perm").hidden = false;            // önce AÇIKLAMA; izin adımı kullanıcının dokunuşuyla
      return;
    } else if (prepared.status === "no-internal") {
      const list = prepared.candidates && prepared.candidates.length ? ` Görünen mikrofonlar: ${prepared.candidates.join(", ")}.` : "";
      trainer.message = `Telefonun kendi mikrofonu bulunamadı; Bluetooth kulaklık mikrofonu müziği bozduğu için AÇILMADI.${list}`;
    } else {
      el("trainer-perm").hidden = true;
      await engine.ensureContext();
      const info = await trainerMic.start(engine.ctx, onTrainerFrame, prepared.device);
      trainer.smoother.reset();
      trainer.gate.reset();
      trainer.board.reset();
      trainer.trail.clear();
      trainer.bluetooth = (prepared.devices || []).some((device) => isBluetoothLabel(device.label));
      trainer.monitor.reset();
      trainer.samples.clear();
      if (!trainer.latencyTouched) {
        trainer.latencyMs = suggestTotalMs({ outputMs: engine.ctx.outputLatency * 1000, micMs: info.latencyMs, bluetooth: trainer.bluetooth });
      }
      wakeLock.request();
      beginTrainerCalibration();
    }
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    trainer.message = reason === "mic-bluetooth" || reason === "mic-unexpected-device"
      ? "Beklenmeyen (Bluetooth) mikrofon açıldı; hemen kapatıldı. Kulaklığı ayırıp yeniden bağlaman gerekebilir."
      : `Mikrofon açılamadı (${reason}).`;
  } finally {
    trainer.busy = false;
  }
  refreshTrainerUi();
}

// Mikrofon kapanınca Android bazen ses çıkışını "iletişim" rotasında bırakıyor (bir kullanıcıda mikrofondan sonra uygulama sesi bir süre gitmişti).
// Çalmıyorsak ses bağlamı askıya alınır: çıkış akışı bırakılır, bir sonraki çalma (engine.play zaten resume eder) çıkışı normal rotada yeniden kurar.
// ÇALARKEN dokunulmaz (askı sesi keserdi). Yalnız mikrofon GERÇEKTEN açıkken kapatılınca çalışır; antrenör kapalıyken hiç devreye girmez.
function settleOutputAfterMic() {
  setTimeout(async () => {
    try {
      const ctx = engine.ctx;
      if (!ctx || ctx.state !== "running" || engine.playing || trainerMic.active) return;
      await ctx.suspend();
    } catch { /* çalmayı hiçbir koşulda etkilemez */ }
  }, 800);
}

export function stopTrainerMic(reason = "") {
  trainer.collect = null;
  trainer.calib = null;
  trainer.alignHistory = [];
  trainerPlayWatch.cancel();
  if (trainerMic.active) {
    trainerMic.stop();
    settleOutputAfterMic();
  }
  trainer.smoother.reset();
  trainer.gate.reset();
  if (reason) trainer.message = reason;
  releasePlaybackWake();
  refreshTrainerUi();
}

export function trainerReset() {
  stopTrainerMic();
  clearInterval(trainer.pollTimer);
  trainer.songId = null;
  trainer.version = 0;
  trainer.notes = null;
  trainer.track = null;
  trainer.board.reset();
  trainer.trail.clear();
  trainer.easerReady = false;
  trainer.floorDb = null;
  trainer.duckFrom = 1;
  trainer.lastAutoMs = null;
  trainer.alignHistory = [];
  setTrainerThreshold();
  trainer.message = "";
  stopTrainerDraw();
  const panel = el("trainer");
  if (panel) panel.hidden = true;
  el("view-player").classList.remove("trainer-on");
}

function openTrainer() {
  el("trainer").hidden = false;
  el("view-player").classList.add("trainer-on");
  startTrainerDraw();
  refreshTrainerUi();
  loadTrainerMelody().then(() => refreshTrainerUi());
  if (melodyStatus() && melodyStatus().state === "running") pollTrainerMelody(currentSong().id);
}

function closeTrainer() {
  stopTrainerMic();
  stopTrainerDraw();
  el("trainer").hidden = true;
  el("view-player").classList.remove("trainer-on");
}

const medianDb = (values) => {
  if (!values.length) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Sızıntı testi: kullanıcı SESSİZ kalır; müzik çalarken ve çalmazken mikrofon SEVİYESİ (dBFS sayıları) karşılaştırılır.
async function trainerLeakTest() {
  if (!trainerMic.active || trainer.busy) return;
  trainer.busy = true;
  el("trainer-leak").disabled = true;
  const wasPlaying = engine.playing;
  const measure = (ms) => new Promise((resolve) => {
    trainer.collect = [];
    setTimeout(() => {
      const values = trainer.collect || [];
      trainer.collect = null;
      resolve(medianDb(values));
    }, ms);
  });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    trainer.message = "Sızıntı testi: sessiz kal…";
    refreshTrainerUi();
    let quiet;
    let music;
    if (wasPlaying) {
      music = await measure(2000);
      stopPlayback();
      await wait(500);
      quiet = await measure(1500);
      await startPlayback();
    } else {
      quiet = await measure(1500);
      await startPlayback();
      await wait(600);
      music = await measure(2000);
      stopPlayback();
    }
    trainer.message = leakVerdict(quiet, music).text;
  } catch (error) {
    trainer.message = `Sızıntı testi yapılamadı (${error && error.message ? error.message : error}).`;
  } finally {
    trainer.collect = null;
    trainer.busy = false;
    refreshTrainerUi();
  }
}

export function bind(deps) {
  ({ engine, releasePlaybackWake, scheduleMixSave, startPlayback, stopPlayback, wakeLock, currentSong, lyricsDoc, mixer } = deps);

  on("trainer-open", "click", openTrainer);
  on("setting-trainer", "change", () => {
    try {
      if (el("setting-trainer").checked) localStorage.setItem("stem-mikser.trainer-on", "1");
      else localStorage.removeItem("stem-mikser.trainer-on");
    } catch { /* bayrak yazılamadı: bu oturumda eski değer */ }
    if (!el("setting-trainer").checked) closeTrainer();
    refreshTrainerChip();
  });
  on("trainer-close", "click", closeTrainer);
  on("trainer-prepare", "click", prepareTrainerMelody);
  on("trainer-mic", "click", () => (trainerMic.active ? stopTrainerMic() : startTrainerMic()));
  on("trainer-leak", "click", trainerLeakTest);
  on("trainer-calibrate", "click", beginTrainerCalibration);
  on("trainer-align", "click", trainerAutoAlign);
  on("tr-auto-restore", "click", restoreAutoLatency);
  on("tr-karaoke", "click", trainerKaraoke);
  on("tr-duck", "click", trainerDuck);
  on("tr-sens", "input", () => {
    trainer.sensitivity = Number(el("tr-sens").value);
    trainer.sensitivityTouched = true;
    trainerText("tr-sens-val", String(trainer.sensitivity));
    setTrainerThreshold();
    saveTrainerPrefs();
  });
  on("trainer-perm-go", "click", async () => {
    if (trainer.busy) return;
    trainer.busy = true;
    const result = await trainerMic.requestPermission();
    trainer.busy = false;
    el("trainer-perm").hidden = true;
    if (!result.ok) {
      trainer.message = result.error === "NotAllowedError" ? "Mikrofon izni verilmedi." : `İzin alınamadı (${result.error}).`;
      refreshTrainerUi();
      return;
    }
    startTrainerMic();                       // izin tamam: şimdi YALNIZ dahili mikrofon
  });
  on("tr-latency", "input", () => {
    trainer.latencyMs = Number(el("tr-latency").value);
    trainer.latencyTouched = true;
    paintAutoMark();
    trainerText("tr-latency-val", `${trainer.latencyMs} ms`);
    saveTrainerPrefs();
  });
  on("tr-octave", "change", () => {
    trainer.octave = el("tr-octave").checked;
    saveTrainerPrefs();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && trainerMic.active) stopTrainerMic("sayfa gizlendi: mikrofon kapatıldı");
    if (document.hidden) stopTrainerDraw();
    else if (!el("trainer").hidden) startTrainerDraw();
  });
}

// TRAINER-BİTİŞ
