// Yapıştırıcı: görünüm geçişleri, kitaplık, yükleme, durum yoklama ve
// oynatıcının bağlanması.

import { loadSettings, saveSettings, isConfigured } from "./settings.js";
import { Api, ApiError } from "./api.js";
import { Engine, STEM_ORDER, STEM_LABELS, gainToDb } from "./engine.js";
import { Mixer } from "./mixer.js";
import { ChordStrip, formatTime } from "./chords.js";

const POLL_MS = 3000;

const el = (id) => document.getElementById(id);

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

async function openSong(song) {
  showView("player");
  hideMessage(el("player-message"));
  el("player-title").textContent = song.title || song.id.slice(0, 12);
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

    setOverlay(true, "Kanallar indiriliyor…");
    const entries = [];
    for (const name of stems) {
      const arrayBuffer = await api.stemBuffer(song.id, name, (ratio) => {
        const fill = fills.get(name);
        if (fill) fill.style.width = `${Math.round(ratio * 100)}%`;
      });
      const fill = fills.get(name);
      if (fill) fill.style.width = "100%";
      entries.push({ name, arrayBuffer });
    }

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
    setOverlay(false);
    startLoop();
  } catch (error) {
    setOverlay(false);
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
    if (engine.checkEnded()) setPlayIcon(false);
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

function stopLoop() {
  cancelAnimationFrame(rafHandle);
  rafHandle = 0;
}

// ---------------------------------------------------------------- olaylar

el("open-settings").addEventListener("click", () => {
  el("setting-url").value = settings.url;
  el("setting-token").value = settings.token;
  hideMessage(el("settings-message"));
  showView("settings");
});

el("close-settings").addEventListener("click", () => {
  showView("library");
  if (isConfigured(settings)) refreshLibrary();
});

el("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  settings = saveSettings({
    url: el("setting-url").value,
    token: el("setting-token").value,
  });
  api = new Api(settings);
  showMessage(el("settings-message"), "Kaydedildi.", "ok");
  refreshLibrary();
});

el("test-connection").addEventListener("click", async () => {
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

el("upload-input").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) handleUpload(file);
  event.target.value = "";
});

el("refresh-list").addEventListener("click", refreshLibrary);

el("back-to-library").addEventListener("click", () => {
  engine.pause();
  setPlayIcon(false);
  stopLoop();
  showView("library");
  refreshLibrary();
});

el("play").addEventListener("click", async () => {
  // Autoplay politikası: bu bir kullanıcı hareketi, context burada açılır.
  if (engine.playing) {
    engine.pause();
    setPlayIcon(false);
  } else {
    await engine.play();
    setPlayIcon(true);
  }
});

el("rewind").addEventListener("click", async () => {
  await engine.seek(0);
});

el("seek").addEventListener("input", () => {
  seeking = true;
  const time = Number(el("seek").value) / 10;
  el("time-current").textContent = formatTime(time);
  el("time-remaining").textContent = `-${formatTime(engine.duration - time)}`;
  strip.update(time);
});

el("seek").addEventListener("change", async () => {
  await engine.seek(Number(el("seek").value) / 10);
  seeking = false;
});

el("master").addEventListener("input", () => {
  const gain = Number(el("master").value) / 100;
  engine.setMaster(gain);
  el("master-value").textContent = `${gainToDb(gain)} dB`;
});

// ---------------------------------------------------------------- PWA

async function registerServiceWorker() {
  const state = el("sw-state");
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

el("clear-cache").addEventListener("click", async () => {
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

mixer = new Mixer(el("channels"), engine, null);
strip = new ChordStrip(
  el("chordstrip"),
  el("chordstrip-track"),
  el("chordstrip-empty"),
  (time) => engine.seek(time)
);

registerServiceWorker();

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
