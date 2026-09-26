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
    el("player-meta").textContent = chords
      ? `${chords.key || ""} · ${Math.round(chords.bpm || 0)} BPM`
      : "";
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

on("metro-toggle", "click", async (event) => {
  event.stopPropagation();
  // AudioContext hazır olmalı; bu bir kullanıcı hareketi.
  await engine.ensureContext();
  const açık = !metronome.enabled;
  metronome.setEnabled(açık);
  el("metro-toggle").setAttribute("aria-pressed", String(açık));
  el("metro-panel").hidden = !açık;
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
    const time = engine.currentTime;
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
