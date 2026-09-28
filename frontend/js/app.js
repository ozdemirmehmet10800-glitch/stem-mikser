// Yapıştırıcı: görünüm geçişleri, kitaplık, yükleme, durum yoklama ve
// oynatıcının bağlanması.

import { loadSettings, saveSettings, isConfigured } from "./settings.js";
import { Api, ApiError } from "./api.js";
import { Engine, STEM_ORDER, STEM_LABELS, gainToDb, isMobile, longSongThresholdSec } from "./engine.js";
import { Mixer } from "./mixer.js";
import { ChordStrip, formatTime } from "./chords.js";
import { MediaBridge } from "./media.js";
import { WakeLock } from "./wakelock.js";
import { StemCache } from "./stemcache.js";
import { Metronome, SUBDIVISIONS } from "./metronome.js";
import {
  measureLatency, estimateLatency, MIN_RATE, MAX_RATE, MAX_SEMITONES,
  STRETCHERS, stretcherInfo, supportsFormants,
} from "./stretch.js";
import { transposeKey } from "./tonality.js";

const POLL_MS = 3000;

const el = (id) => document.getElementById(id);

// Eksik bir öğeye olay bağlamak TÜM modül başlatmasını durduruyordu:
// bayat bir HTML (service worker cache'i) ile yeni JS eşleşmezse uygulama
// sessizce hiç açılmıyordu - boş liste, hata mesajı bile yok. Artık eksik
// öğe uyarı basıp geçiyor.
function on(id, event, handler) {
  const node = document.getElementById(id);
  if (!node) {
    console.warn(`[ui] "${id}" öğesi yok, "${event}" bağlanmadı (bayat HTML?)`);
    return null;
  }
  node.addEventListener(event, handler);
  return node;
}

const views = {
  library: el("view-library"),
  player: el("view-player"),
  settings: el("view-settings"),
};

let settings = loadSettings();
let api = new Api(settings);
const engine = new Engine();
let mixer = null;
let strip = null;
let pollTimer = null;
let rafHandle = 0;
let seeking = false;
let currentSong = null;
let media = null;
const wakeLock = new WakeLock();
const stemCache = new StemCache();
const metronome = new Metronome(engine);
let lastPositionSync = -1;

// --- hız / ton durumu ---
// tempoOffset'in birimi BPM (şarkının tempo'su biliniyorsa), bilinmiyorsa
// yüzde puanı. BPM cinsinden TAM SAYI sapma tutmanın sebebi: 0 sapma tam
// olarak 1.0 oranı demek. Kaydırıcıyı doğrudan BPM'de tutsak 127.12'lik bir
// tempo 127'ye yuvarlanır ve "orijinal" konum 0.999 oranına düşerdi - yani
// esnetici varsayılanda devre dışı KALMAZDI.
const RATE_SPAN = 0.5;        // ±%50; MIN_RATE/MAX_RATE ile uyumlu
let tempoOffset = 0;
let pitchSemis = 0;
let originalBpm = 0;          // 0 = bilinmiyor
let originalKey = null;
let appliedSemis = 0;
let stretchGen = 0;           // geciken ölçümün bayat sonucunu atmak için

// ---------------------------------------------------------------- yardımcı

function showView(name) {
  for (const [key, node] of Object.entries(views)) {
    node.hidden = key !== name;
  }
}

function showMessage(node, text, kind = "error") {
  node.hidden = false;
  node.className = `message ${kind}`;
  node.textContent = text;
}

function hideMessage(node) {
  node.hidden = true;
  node.textContent = "";
}

function describeError(error) {
  if (!(error instanceof ApiError)) {
    return `Beklenmeyen hata: ${error && error.message ? error.message : error}`;
  }
  switch (error.kind) {
    case "config":
      return "API adresi ve token ayarlı değil. Ayarlar ekranını aç.";
    case "auth":
      return `Token kabul edilmedi (401).\n${error.hint}`;
    case "network":
      return `${error.message}\n${error.hint}`;
    case "notfound":
      return "Şarkı bulunamadı. Liste yenilenmiş olabilir.";
    default:
      return error.message;
  }
}

function setOverlay(visible, text = "") {
  el("overlay").hidden = !visible;
  if (text) el("overlay-text").textContent = text;
  if (!visible) el("overlay-bars").innerHTML = "";
}

// ---------------------------------------------------------------- kitaplık

const stateLabels = {
  queued: "sırada",
  separating: "ayrıştırılıyor",
  analyzing: "analiz ediliyor",
  done: "hazır",
  error: "hata",
};

async function refreshLibrary() {
  hideMessage(el("library-message"));
  try {
    const songs = await api.listSongs();
    renderLibrary(songs);
    if (songs.some((song) => song.state !== "done" && song.state !== "error")) {
      schedulePoll();
    }
  } catch (error) {
    showMessage(el("library-message"), describeError(error));
  }
}

function renderLibrary(songs) {
  const list = el("song-list");
  list.innerHTML = "";
  if (!songs.length) {
    showMessage(el("library-message"), "Henüz şarkı yok. Yukarıdan bir tane ekle.", "warn");
    return;
  }
  for (const song of songs) {
    const item = document.createElement("li");
    item.className = "song-row";

    const busy = song.state !== "done" && song.state !== "error";
    const thumb = document.createElement("div");
    thumb.className = "song-thumb";
    thumb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

    const info = document.createElement("div");
    info.className = "song-info";
    const name = document.createElement("div");
    name.className = "song-name";
    name.textContent = song.title || song.id.slice(0, 12);
    const sub = document.createElement("div");
    sub.className = "song-sub" + (busy ? " busy" : song.state === "error" ? " error" : "");
    const duration = song.duration ? ` · ${formatTime(song.duration)}` : "";
    sub.textContent = (stateLabels[song.state] || song.state) + duration;
    info.append(name, sub);

    if (busy) {
      const progress = document.createElement("div");
      progress.className = "mini-progress";
      const fill = document.createElement("i");
      fill.style.width = `${Math.max(Number(song.progress) || 0, 3)}%`;
      progress.append(fill);
      info.append(progress);
    }

    item.append(thumb, info);
    if (song.state === "done") {
      item.addEventListener("click", () => openSong(song));
    } else if (song.state === "error") {
      item.addEventListener("click", () =>
        showMessage(el("library-message"), `${song.title || song.id}: işlenemedi.`)
      );
    }
    list.append(item);
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!views.library.hidden) await refreshLibrary();
  }, POLL_MS);
}

async function handleUpload(file) {
  const status = el("upload-status");
  status.hidden = false;
  status.textContent = `${file.name} yükleniyor… %0`;
  try {
    const result = await api.uploadSong(file, (ratio) => {
      status.textContent = `${file.name} yükleniyor… %${Math.round(ratio * 100)}`;
    });
    status.textContent = result.existing
      ? `${file.name} zaten işlenmiş, listede.`
      : `${file.name} alındı, işleniyor.`;
    await refreshLibrary();
    schedulePoll();
  } catch (error) {
    status.hidden = true;
    showMessage(el("library-message"), describeError(error));
  }
}

// ---------------------------------------------------------------- oynatıcı

function longSongWarning(song) {
  if (!isMobile()) return null;
  const limit = longSongThresholdSec();
  const duration = Number(song.duration) || 0;
  if (!Number.isFinite(limit) || duration <= limit) return null;
  const memory = navigator.deviceMemory;
  return (
    `Uzun şarkı (${formatTime(duration)}), telefonda bellek sorunu ` +
    `çıkabilir.
Cihaz belleği: ${memory ? memory + " GB" : "bilinmiyor"}, ` +
    `eşik: ${formatTime(limit)}.
Yine de açmayı deneyebilirsin.`
  );
}

async function openSong(song) {
  showView("player");
  el("player-title").textContent = song.title || song.id.slice(0, 12);

  // Uyarı gösteriliyor ama AÇMAYA İZİN VERİLİYOR.
  const warning = longSongWarning(song);
  if (warning) showMessage(el("player-message"), warning, "warn");
  el("player-meta").textContent = "";
  el("play").disabled = true;
  if (el("tempo-toggle")) el("tempo-toggle").disabled = true;
  closeTunePanel();
  strip.clear();
  el("channels").innerHTML = "";

  setOverlay(true, "Şarkı bilgileri alınıyor…");
  try {
    const detail = await api.getSong(song.id);
    currentSong = { ...song, ...detail };
    const stems = (detail.status && detail.status.stems) || STEM_ORDER;

    // AudioContext'i ilk kullanıcı hareketinde kurmak gerekiyor; şarkıya
    // tıklamak bir hareket sayıldığı için burada güvenle açabiliriz.
    await engine.ensureContext();

    const bars = el("overlay-bars");
    bars.innerHTML = "";
    const fills = new Map();
    for (const name of stems) {
      const row = document.createElement("div");
      row.className = "overlay-bar";
      row.innerHTML =
        `<span class="bar-name">${STEM_LABELS[name] || name}</span>` +
        `<span class="bar-track"><i></i></span>`;
      bars.append(row);
      fills.set(name, row.querySelector("i"));
    }

    setOverlay(true, "Kanallar hazırlanıyor…");
    const entries = [];
    let fromCache = 0;
    for (const name of stems) {
      const fill = fills.get(name);
      // Önce cihazdaki kopya: ikinci açılışta ağa hiç çıkılmıyor.
      let arrayBuffer = await stemCache.get(song.id, name);
      if (arrayBuffer) {
        fromCache += 1;
        if (fill) fill.style.width = "100%";
      } else {
        arrayBuffer = await api.stemBuffer(song.id, name, (ratio) => {
          if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
        });
        if (fill) fill.style.width = "100%";
        // Kopyası saklanıyor; decodeAudioData ArrayBuffer'ı tükettiği için
        // ÖNCE yazıp sonra çözüyoruz.
        await stemCache.put(song.id, name, arrayBuffer.slice(0));
      }
      entries.push({ name, arrayBuffer });
    }
    console.info(`[stem] ${fromCache}/${stems.length} kanal cihazdan geldi`);

    setOverlay(true, "Ses çözülüyor…");
    const duration = await engine.setStems(entries);

    mixer.render(entries.map((entry) => entry.name));
    strip.build(detail.chords, duration);

    const chords = detail.chords;

    // Hız ve ton her şarkıda ORİJİNALE dönüyor: esnetici devre dışı, zincir
    // source -> gain -> master.
    originalBpm = chords && Number(chords.bpm) > 0 ? Number(chords.bpm) : 0;
    originalKey = (chords && chords.key) || null;
    tempoOffset = 0;
    pitchSemis = 0;
    appliedSemis = 0;
    stretchGen += 1;
    configureTuneRanges();
    await engine.resetTempoAndPitch();
    strip.setTranspose(0, originalKey);
    if (el("tempo-toggle")) el("tempo-toggle").disabled = false;
    refreshTuneUi();  // player-meta'yı da yazıyor

    el("seek").max = String(Math.max(Math.round(duration * 10), 1));
    el("seek").value = "0";
    el("time-current").textContent = "0:00";
    el("time-remaining").textContent = `-${formatTime(duration)}`;
    el("play").disabled = false;
    // Metronom ızgarası: beat_this vuruşları + downbeat'ler.
    metronome.setGrid(chords ? chords.beats : [], chords ? chords.downbeats : []);
    el("metro-toggle").disabled = !(chords && chords.beats && chords.beats.length);

    media.setMetadata({
      title: song.title || song.id.slice(0, 12),
      artist: chords ? `${chords.key || ""} · ${Math.round(chords.bpm || 0)} BPM` : "",
    });
    media.bindHandlers({ onPlay: startPlayback, onPause: stopPlayback });
    lastPositionSync = -1;
    setOverlay(false);
    startLoop();
  } catch (error) {
    setOverlay(false);
    showMessage(el("player-message"), describeError(error));
  }
}

function buildSubdivisionButtons() {
  const host = el("metro-subs");
  if (!host) return;
  host.innerHTML = "";
  for (const [value, label] of SUBDIVISIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "metro-sub" + (value === metronome.subdivision ? " on" : "");
    button.textContent = label;
    button.addEventListener("click", () => {
      metronome.setSubdivision(value);
      [...host.children].forEach((node) => node.classList.remove("on"));
      button.classList.add("on");
    });
    host.append(button);
  }
}

// ------------------------------------------------------------- hız ve ton

function currentRate() {
  if (!tempoOffset) return 1;
  const raw = originalBpm
    ? (originalBpm + tempoOffset) / originalBpm
    : 1 + tempoOffset / 100;
  return Math.min(Math.max(raw, MIN_RATE), MAX_RATE);
}

function effectiveKey() {
  if (!originalKey) return null;
  if (!pitchSemis) return originalKey;
  return transposeKey(originalKey, pitchSemis) || originalKey;
}

function refreshMeta() {
  const parts = [];
  const key = effectiveKey();
  if (key) parts.push(key);
  if (originalBpm) parts.push(`${Math.round(originalBpm * currentRate())} BPM`);
  el("player-meta").textContent = parts.join(" · ");
}

// Kaydırıcı sınırları şarkıya göre: tempo biliniyorsa BPM, yoksa yüzde.
function configureTuneRanges() {
  const tempo = el("tempo-range");
  const span = originalBpm ? Math.max(1, Math.round(originalBpm * RATE_SPAN)) : 50;
  if (tempo) {
    tempo.min = String(-span);
    tempo.max = String(span);
    tempo.value = "0";
  }
  const pitch = el("pitch-range");
  if (pitch) {
    pitch.min = String(-MAX_SEMITONES);
    pitch.max = String(MAX_SEMITONES);
    pitch.value = "0";
  }
}

function signed(value) {
  return `${value > 0 ? "+" : ""}${value}`;
}

function refreshTuneUi() {
  const rate = currentRate();
  const percent = Math.round(rate * 100);

  if (el("tempo-value")) {
    el("tempo-value").textContent = originalBpm
      ? `${Math.round(originalBpm + tempoOffset)} BPM`
      : `%${percent}`;
  }
  if (el("tempo-sub")) {
    el("tempo-sub").textContent = originalBpm
      ? `%${percent} · orijinal ${Math.round(originalBpm)} BPM`
      : "şarkının temposu bilinmiyor";
  }

  if (el("pitch-value")) {
    if (originalKey) {
      el("pitch-value").textContent = pitchSemis
        ? `${originalKey} → ${effectiveKey()}`
        : originalKey;
    } else {
      el("pitch-value").textContent = pitchSemis
        ? `${signed(pitchSemis)} yarım ses`
        : "orijinal ton";
    }
  }
  if (el("pitch-sub")) {
    el("pitch-sub").textContent = pitchSemis
      ? `${signed(pitchSemis)} yarım ses`
      : "orijinal";
  }

  if (el("tempo-reset")) el("tempo-reset").disabled = tempoOffset === 0;
  if (el("pitch-reset")) el("pitch-reset").disabled = pitchSemis === 0;
  // Panel kapalıyken de esneticinin açık olduğu düğmeden görünsün.
  if (el("tempo-toggle")) {
    el("tempo-toggle").classList.toggle("changed", tempoOffset !== 0 || pitchSemis !== 0);
  }
  refreshMeta();
}

/**
 * Hız ve tonu motora uygular.
 *
 * measure=false (kaydırıcı SÜRÜKLENİRKEN): son bilinen gecikmeyle canlı
 * uygulanıyor, ölçüm yapılmıyor - her adımda ölçmek telefonda takılıyor.
 * measure=true (kaydırıcı BIRAKILINCA, -/+ ve sıfırlamada): taze ölçüm
 * alınıp yeniden çıpalanıyor, böylece metronom ve imleç tam oturuyor.
 */
async function applyStretch(measure) {
  const rate = currentRate();
  const semis = pitchSemis;
  refreshTuneUi();
  if (semis !== appliedSemis) {
    appliedSemis = semis;
    strip.setTranspose(semis, originalKey);
  }

  const ctx = engine.ctx;
  if (!ctx) return;  // şarkı açılmadan buraya gelinmiyor, yine de korunalı

  const gen = ++stretchGen;
  const guess = estimateLatency(ctx.sampleRate, rate, semis);
  await engine.setTempoAndPitch(rate, semis, guess);
  media.updatePosition();
  if (!measure) return;

  const measured = await measureLatency(ctx.sampleRate, rate, semis);
  // Kullanıcı ölçüm sürerken başka bir değere geçtiyse bu sonuç bayat.
  if (gen !== stretchGen) return;
  if (Math.abs(measured - guess) < 0.002) return;
  await engine.setTempoAndPitch(rate, semis, measured);
  media.updatePosition();
}

function clampRange(id, value) {
  const node = el(id);
  if (!node) return Math.round(value);
  return Math.min(Math.max(Math.round(value), Number(node.min)), Number(node.max));
}

function setTempoOffset(value, measure) {
  const next = clampRange("tempo-range", value);
  if (next === tempoOffset && !measure) return undefined;
  tempoOffset = next;
  if (el("tempo-range")) el("tempo-range").value = String(next);
  return applyStretch(measure);
}

function setPitchSemis(value, measure) {
  const next = clampRange("pitch-range", value);
  if (next === pitchSemis && !measure) return undefined;
  pitchSemis = next;
  if (el("pitch-range")) el("pitch-range").value = String(next);
  return applyStretch(measure);
}

function closeTunePanel() {
  if (!el("tempo-panel")) return;
  el("tempo-panel").hidden = true;
  el("tempo-toggle").setAttribute("aria-pressed", "false");
}

on("tempo-toggle", "click", async (event) => {
  event.stopPropagation();
  // AudioContext hazır olmalı; bu bir kullanıcı hareketi.
  await engine.ensureContext();
  const open = el("tempo-panel").hidden;
  el("tempo-panel").hidden = !open;
  el("tempo-toggle").setAttribute("aria-pressed", String(open));
  if (open && el("metro-panel")) el("metro-panel").hidden = true;
});

// input = sürükleme (ölçüm yok), change = bırakma (ölçüm var).
on("tempo-range", "input", () => setTempoOffset(Number(el("tempo-range").value), false));
on("tempo-range", "change", () => setTempoOffset(Number(el("tempo-range").value), true));
on("tempo-minus", "click", () => setTempoOffset(tempoOffset - 1, true));
on("tempo-plus", "click", () => setTempoOffset(tempoOffset + 1, true));
on("tempo-reset", "click", () => setTempoOffset(0, true));

on("pitch-range", "input", () => setPitchSemis(Number(el("pitch-range").value), false));
on("pitch-range", "change", () => setPitchSemis(Number(el("pitch-range").value), true));
on("pitch-minus", "click", () => setPitchSemis(pitchSemis - 1, true));
on("pitch-plus", "click", () => setPitchSemis(pitchSemis + 1, true));
on("pitch-reset", "click", () => setPitchSemis(0, true));

on("metro-toggle", "click", async (event) => {
  event.stopPropagation();
  // AudioContext hazır olmalı; bu bir kullanıcı hareketi.
  await engine.ensureContext();
  const açık = !metronome.enabled;
  metronome.setEnabled(açık);
  el("metro-toggle").setAttribute("aria-pressed", String(açık));
  el("metro-panel").hidden = !açık;
  if (açık) closeTunePanel();
});

on("metro-volume", "input", () => {
  metronome.setVolume(Number(el("metro-volume").value) / 100);
});
on("metro-pan", "input", () => {
  metronome.setPan(Number(el("metro-pan").value) / 100);
});

async function downloadStem(name, format) {
  if (!currentSong) return;
  const label = `${STEM_LABELS[name] || name} · ${format.toUpperCase()}`;
  showMessage(el("player-message"), `${label} hazırlanıyor…`, "warn");
  try {
    const link = await api.downloadLink(currentSong.id, name, format);
    // <a download> BAŞKA ORIGIN'de yok sayılıyor; indirmeyi sunucunun
    // Content-Disposition: attachment başlığı zorluyor. İmzalı URL token
    // istemiyor, o yüzden düz gezinti yeterli.
    const anchor = document.createElement("a");
    anchor.href = link.url;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    showMessage(el("player-message"), `${label} indiriliyor.`, "ok");
    setTimeout(() => hideMessage(el("player-message")), 4000);
  } catch (error) {
    showMessage(el("player-message"), describeError(error));
  }
}

function setPlayIcon(playing) {
  el("play-icon").innerHTML = playing
    ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';
  el("play").setAttribute("aria-label", playing ? "Duraklat" : "Oynat");
}

function startLoop() {
  cancelAnimationFrame(rafHandle);
  const tick = () => {
    // visualTime: KULAĞA GİDEN konum. currentTime esneticiden çıkanı
    // gösteriyor, ona ctx.outputLatency daha eklenecek - Bluetooth
    // kulaklıkta 200 ms'yi buluyor ve imleç sesin önüne geçiyor.
    const time = engine.visualTime;
    strip.update(time);
    if (!seeking) {
      el("seek").value = String(Math.round(time * 10));
      el("time-current").textContent = formatTime(time);
      el("time-remaining").textContent = `-${formatTime(engine.duration - time)}`;
    }
    if (engine.checkEnded()) {
      setPlayIcon(false);
      media.stopKeeper();
      media.setPlaybackState(false);
      metronome.stop();
      wakeLock.release();
    }
    // Kilit ekranı konumu: saniyede bir yeter, her karede değil.
    if (time - lastPositionSync > 1 || time < lastPositionSync) {
      lastPositionSync = time;
      media.updatePosition();
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopLoop() {
  cancelAnimationFrame(rafHandle);
  rafHandle = 0;
}

// ---------------------------------------------------------------- olaylar

on("open-settings", "click", () => {
  refreshStemCacheState();
  el("setting-url").value = settings.url;
  el("setting-token").value = settings.token;
  el("setting-stretcher").value = settings.stretcher;
  refreshStretcherUi();
  hideMessage(el("settings-message"));
  showView("settings");
});

on("close-settings", "click", () => {
  showView("library");
  if (isConfigured(settings)) refreshLibrary();
});

on("settings-form", "submit", (event) => {
  event.preventDefault();
  settings = saveSettings({
    url: el("setting-url").value,
    token: el("setting-token").value,
  });
  api = new Api(settings);
  showMessage(el("settings-message"), "Kaydedildi.", "ok");
  refreshLibrary();
});

on("test-connection", "click", async () => {
  const probe = new Api({
    url: el("setting-url").value,
    token: el("setting-token").value,
  });
  showMessage(el("settings-message"), "Sınanıyor…", "warn");
  try {
    const health = await probe.health();
    showMessage(
      el("settings-message"),
      `Bağlantı tamam.\nİzin verilen adresler: ${(health.allowed_origins || []).join(", ")}\n` +
        `Bu sayfanın adresi: ${location.origin}`,
      "ok"
    );
  } catch (error) {
    showMessage(el("settings-message"), describeError(error));
  }
});

on("upload-input", "change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) handleUpload(file);
  event.target.value = "";
});

on("refresh-list", "click", refreshLibrary);

on("back-to-library", "click", () => {
  stopPlayback();
  stopLoop();
  showView("library");
  refreshLibrary();
});

async function startPlayback() {
  // Autoplay politikası: bu bir kullanıcı hareketi, context burada açılır.
  // Sessiz elementi ÖNCE ve await'siz başlat: kullanıcı hareketi içinde
  // kalsın, yoksa Chrome reddediyor ve kilit ekranı kontrolleri çıkmıyor.
  media.startKeeper();
  media.setPlaybackState(true);
  await engine.play();
  metronome.resync();
  metronome.start();
  setPlayIcon(true);
  media.setPlaybackState(true);
  media.updatePosition();
  wakeLock.request();
}

function stopPlayback() {
  engine.pause();
  metronome.stop();
  setPlayIcon(false);
  media.stopKeeper();
  media.setPlaybackState(false);
  media.updatePosition();
  wakeLock.release();
}

on("play", "click", async () => {
  if (engine.playing) stopPlayback();
  else await startPlayback();
});

on("rewind", "click", async () => {
  await engine.seek(0);
});

on("seek", "input", () => {
  seeking = true;
  const time = Number(el("seek").value) / 10;
  el("time-current").textContent = formatTime(time);
  el("time-remaining").textContent = `-${formatTime(engine.duration - time)}`;
  strip.update(time);
});

on("seek", "change", async () => {
  await engine.seek(Number(el("seek").value) / 10);
  metronome.resync();
  seeking = false;
});

on("master", "input", () => {
  const gain = Number(el("master").value) / 100;
  engine.setMaster(gain);
  el("master-value").textContent = `${gainToDb(gain)} dB`;
});

// --------------------------------------------------------- esnetici seçimi

function refreshStretcherUi() {
  const select = el("setting-stretcher");
  const check = el("setting-formants");
  if (!select || !check) return;
  const info = stretcherInfo(settings.stretcher);
  const able = supportsFormants(settings.stretcher);
  el("stretcher-note").textContent =
    `${info.label} (${info.license}). Değişiklik çalarken de uygulanıyor; ` +
    `hız 1.0 ve ton 0 iken hiçbir esnetici kurulmuyor.`;
  check.disabled = !able;
  check.checked = able && Boolean(settings.formants);
  el("formant-note").textContent = able
    ? "Ton kaydırırken formantları yerinde tutmayı dener. Kaynağın hız " +
      "kaydırması ayrıca geri çevriliyor, yoksa formantlar tempoyla birlikte " +
      "düşüyor (ölçüldü). Kulakla dene."
    : `${info.label} formant telafisi sunmuyor.`;
}

function applyStretcherSettings() {
  engine.setStretcher(settings.stretcher);
  engine.setFormants(settings.formants);
}

on("setting-stretcher", "change", () => {
  settings = saveSettings({ stretcher: el("setting-stretcher").value });
  refreshStretcherUi();
  applyStretcherSettings();
});

on("setting-formants", "change", () => {
  settings = saveSettings({ formants: el("setting-formants").checked });
  refreshStretcherUi();
  applyStretcherSettings();
});

function buildStretcherOptions() {
  const select = el("setting-stretcher");
  if (!select) return;
  select.innerHTML = "";
  for (const item of STRETCHERS) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.label} (${item.license})`;
    select.append(option);
  }
}

// ------------------------------------------------------------- hiza testi

// aligncheck.js YALNIZCA test çalıştırılınca yükleniyor: normal açılışta
// ne modül ne de worklet indiriliyor.
function renderAlignment(rows) {
  const host = el("align-results");
  if (!host) return;
  host.innerHTML = "";
  const table = document.createElement("table");
  table.className = "align-table";
  table.innerHTML =
    "<thead><tr><th>Ölçüm</th><th>Değer</th><th></th><th>Not</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const item of rows) {
    const tr = document.createElement("tr");
    const verdict =
      item.passed === null
        ? '<span class="align-verdict info">bilgi</span>'
        : item.passed
        ? '<span class="align-verdict ok">geçti</span>'
        : '<span class="align-verdict fail">kaldı</span>';
    tr.innerHTML =
      `<td>${item.name}</td>` +
      `<td class="value">${item.measurement}</td>` +
      `<td>${verdict}</td>` +
      `<td class="note">${item.note || ""}</td>`;
    body.append(tr);
  }
  table.append(body);
  host.append(table);
  const legend = document.createElement("small");
  legend.className = "align-legend";
  legend.textContent =
    "Hiza farkı = metronom − stem. Artı: metronom GEÇ, eksi: metronom ERKEN. " +
    "Karar yalnız MEDYANA bakıyor; saçılma WSOLA'nın doğası, geçti/kaldıya girmiyor.";
  host.append(legend);
}

on("align-run", "click", async () => {
  const button = el("align-run");
  const state = el("align-state");
  const results = el("align-results");
  button.disabled = true;
  results.innerHTML = "";
  state.hidden = false;
  state.textContent = "Hazırlanıyor…";
  try {
    // Oynatıcı çalıyorsa durdur: iki AudioContext aynı anda ses vermesin.
    if (engine.playing) stopPlayback();
    const { runAlignmentCheck, PASS_MS } = await import("./aligncheck.js");
    const rows = await runAlignmentCheck(
      (text) => { state.textContent = text; },
      { stretcher: settings.stretcher, formants: settings.formants }
    );
    renderAlignment(rows);
    const failed = rows.filter((item) => item.passed === false).length;
    state.textContent = failed
      ? `${failed} ölçüm kaldı (eşik ±${PASS_MS} ms).`
      : `Hepsi geçti (eşik ±${PASS_MS} ms).`;
  } catch (error) {
    state.textContent = `Test çalıştırılamadı: ${error && error.message ? error.message : error}`;
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- PWA

async function registerServiceWorker() {
  const state = el("sw-state") || { set textContent(value) { console.info("[sw]", value); } };
  if (!("serviceWorker" in navigator)) {
    state.textContent = "Bu tarayıcı service worker desteklemiyor.";
    return;
  }
  // file:// ile açıldığında kayıt zaten başarısız olur; kullanıcıya anlamlı
  // bir şey söylemek, konsolda sessizce patlamasından iyi.
  if (location.protocol === "file:") {
    state.textContent = "Dosyadan açıldı; service worker yalnızca http(s) ile çalışır.";
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("sw.js");
    state.textContent = `Service worker etkin (kapsam: ${registration.scope}).`;
  } catch (error) {
    state.textContent = `Service worker kaydedilemedi: ${error.message}`;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function refreshStemCacheState() {
  const node = el("stem-cache-state");
  if (!node) return;
  if (!stemCache.available) {
    node.textContent = "Bu tarayıcı çevrimdışı kopyaları desteklemiyor.";
    return;
  }
  const usage = await stemCache.usage();
  const persisted = stemCache.persisted;
  const kalici = persisted === true ? "kalıcı" : persisted === false ? "geçici" : "bilinmiyor";
  node.textContent =
    `Çevrimdışı kopyalar: ${usage.songs} şarkı, ${usage.files} kanal, ` +
    `${formatBytes(usage.bytes)} / ${formatBytes(usage.limit)} (depolama: ${kalici}).`;
}

on("clear-stems", "click", async () => {
  const node = el("stem-cache-state");
  node.textContent = "Siliniyor…";
  await stemCache.clear();
  await refreshStemCacheState();
});

on("clear-cache", "click", async () => {
  const state = el("sw-state");
  state.textContent = "Temizleniyor…";
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    state.textContent = "Önbellek temizlendi, service worker kaldırıldı. Sayfayı yenile.";
  } catch (error) {
    state.textContent = `Temizlenemedi: ${error.message}`;
  }
});

// ---------------------------------------------------------------- başlangıç

mixer = new Mixer(el("channels"), engine, null, downloadStem);
strip = new ChordStrip(
  el("chordstrip"),
  el("chordstrip-track"),
  el("chordstrip-empty"),
  async (time) => { await engine.seek(time); metronome.resync(); }
);

media = new MediaBridge(engine, { onSeek: (time) => engine.seek(time) });

buildSubdivisionButtons();
buildStretcherOptions();
el("setting-stretcher").value = settings.stretcher;
refreshStretcherUi();
applyStretcherSettings();
registerServiceWorker();
stemCache.requestPersistence();

if (isConfigured(settings)) {
  showView("library");
  refreshLibrary();
} else {
  el("setting-url").value = settings.url;
  el("setting-token").value = settings.token;
  showView("settings");
  showMessage(
    el("settings-message"),
    "Başlamak için API adresini ve token'ı gir.",
    "warn"
  );
}
