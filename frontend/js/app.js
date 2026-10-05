// Yapıştırıcı: görünüm geçişleri, kitaplık, yükleme, durum yoklama ve
// oynatıcının bağlanması.

import {
  loadSettings, saveSettings, isConfigured, DECODE_PARALLEL, normalizeParallel,
} from "./settings.js";
import { Api, ApiError, isDefinitelyOffline } from "./api.js";
import {
  Engine, STEM_ORDER, STEM_LABELS, gainToDb, isMobile, longSongThresholdSec,
  nativeSampleRate,
} from "./engine.js";
import { Mixer } from "./mixer.js";
import {
  snapPoint, barLoop, hasBars, BAR_CHOICES, minLoopLength, dragPoint, normalizeLoop,
} from "./loop.js";
import {
  PRESETS, applyPreset, cleanStates, snapshot, planRestore, readMix, writeMix,
  removeMix, writeLoop, isDefaultMix,
} from "./mixmemory.js";
import { ChordStrip, formatTime } from "./chords.js";
import {
  SUB_GROUPS, GROUP_ORDER, SUB_LABELS, subNames, subOf, subView, subVersion, isRunning, groupThresholdSec,
} from "./sub.js";
import {
  buildRequest as buildExportRequest, summarize as summarizeExport, presetLabel, tempoNote, regionNote,
  formatBytes as formatExportBytes, formatElapsed, waitHint, runExport, errorMessage as exportErrorMessage, mimeFor, shareSupported,
} from "./exportmix.js";
import {
  LANG_CHOICES, lyricsOf, sectionView, findLine, highlightTime, scrollTarget, lineLoop, linesToText,
  checkText as checkLyricsText, normalizeDoc as normalizeLyricsDoc, isRunning as lyricsIsRunning,
  mapManual, fixTime, applyChanged,
  readCache as readLyricsCache, writeCache as writeLyricsCache, dropCache as dropLyricsCache,
} from "./lyrics.js";
import { LyricsScreen, ROWS_MIN, ROWS_MAX, normalizeRows } from "./lyricsscreen.js";
import * as TR from "./translation.js";
import { vinylPitch, nearestSemitone, keyShift, formatPitch } from "./vinyl.js";
import {
  normalizeFx, neutralFx, DEFAULT_ROOM, ROOM_PRESETS, normalizeRoom, roomPresetId,
  DECAY_MIN, DECAY_MAX,
} from "./fx.js";
import {
  BG_MODES, BG_LABELS, normalizeBg, wantsPulse, onsetsFromBuffer, pickBeats, readKicks, writeKicks, dropKicks,
  classifyBackground,
} from "./beatpulse.js";
import { getBackground, putBackground, clearBackground } from "./bgstore.js";
import { MediaBridge } from "./media.js";
import { WakeLock } from "./wakelock.js";
import { StemCache, cacheTag } from "./stemcache.js";
import { Metronome, SUBDIVISIONS } from "./metronome.js";
import {
  measureLatency, estimateLatency, MIN_RATE, MAX_RATE, MAX_SEMITONES,
  STRETCHERS, stretcherInfo, supportsFormants, normalizeStretcher,
} from "./stretch.js";
import { transposeKey } from "./tonality.js";
import { NavStack, CLOSE, BLOCKED } from "./navstack.js";
import { diag, summarize, eventsText } from "./diag.js";
import {
  SHARE_PARAM, MESSAGES as SHARE_MESSAGES, launchKind, readPending, clearPending, classify, formatSize,
  formatDuration, durationWarning,
} from "./share.js";

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
let lyricsScreen = null;       // tam ekran sözler (Aşama 13); aşağıda kurulur
// Söz çevirisi durumu (Aşama 14): işlevler aşağıda (refreshLyricSubs vb.)
let trMap = null;                 // Map normKey -> {tr, ro?} ya da null
let trVersion = 0;                // eldeki çevirinin sunucu sürümü
let trShow = TR.defaultShow();    // {tr, ro}: açık/kapalı, TÜM şarkılar için tek, cihazda
let trStarting = false;
let trPollTimer = 0;
let trLoadGen = 0;
let trNote = "";

try { trShow = TR.readShow(localStorage); } catch { /* varsayılan */ }
const subsInputs = [];
let media = null;
const wakeLock = new WakeLock();
const stemCache = new StemCache();
const metronome = new Metronome(engine);
let lastPositionSync = -1;
// AAC priming ölçümü (aşağıda, openSong içinde) - Ayarlar ekranında gösteriliyor.
let lastAacDelta = "";

// --- hız / ton durumu ---
// tempoOffset'in birimi BPM (şarkının tempo'su biliniyorsa), bilinmiyorsa
// yüzde puanı. BPM cinsinden TAM SAYI sapma tutmanın sebebi: 0 sapma tam
// olarak 1.0 oranı demek. Kaydırıcıyı doğrudan BPM'de tutsak 127.12'lik bir
// tempo 127'ye yuvarlanır ve "orijinal" konum 0.999 oranına düşerdi - yani
// esnetici varsayılanda devre dışı KALMAZDI.
const RATE_SPAN = 0.5;        // ±%50; MIN_RATE/MAX_RATE ile uyumlu
let tempoOffset = 0;
let pitchSemis = 0;
let vinylMode = false;     // "Plak gibi": tempo ve ton bağlı, esnetici yok (vinyl.js)
let roomState = normalizeRoom(null);   // ortak yankı odası {size, decay, level} (şarkı başına kayıtlı)
let fxMode = "channel";               // kanal ayarı sayfası: "channel" | "room"
let fxChannel = null;                 // sayfada düzenlenen kanal
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
    case "offline":
      return `${error.message} ${error.hint}`;
    case "network":
      return `${error.message}\n${error.hint}`;
    case "notfound":
      return "Şarkı bulunamadı. Liste yenilenmiş olabilir.";
    default:
      return error.message;
  }
}

function setOverlay(visible, text = "") {
  // Yükleme sürerken geri hiçbir şey yapmıyor: yarıda kesmek indirilmiş
  // tamponları çöpe atar, üstelik iptal edilecek bir şey de yok.
  if (visible) nav.block("overlay");
  else nav.unblock("overlay");
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

// --- seçim modu (silme) ---
// Uzun basınca açılıyor. Yoklama (POLL_MS) listeyi yeniden çizdiği için
// seçim SATIRLARDA değil burada tutuluyor; çizim bunu okuyor.
const LONG_PRESS_MS = 500;
let selectMode = false;
const selectedIds = new Set();
let librarySongs = [];
// Uzun basıştan sonra parmak kalkarken gelen click şarkıyı açmasın.
let suppressClick = false;

// Açılıştan sonra bir yerden gelen "bunu kullanıcıya söyle" notu. refreshLibrary
// ilk iş mesajı temizlediği için, oynatıcıdan dönerken yazılan hata yoksa
// oluyordu; artık tazeleme bittikten SONRA yazılıyor.
let pendingLibraryNote = "";
let libraryRefresh = null;

async function refreshLibrary() {
  // Aynı anda iki tazeleme yok: oynatıcı katmanı kapanırken kapatıcı da
  // çağırıyor, çevrimdışıyken her biri zaman aşımı kadar bekletirdi.
  if (libraryRefresh) return libraryRefresh;
  libraryRefresh = (async () => {
    // Bekleyen not varsa HEMEN göster: oynatıcıdan bir hatayla dönüldüyse
    // sebebi öğrenmek için tazelemenin bitmesini (çevrimdışıyken saniyeler)
    // beklemek gerekmesin. finally'de bir kez daha yazılıyor, çünkü arada
    // gelen sonuç mesajı değiştirmiş olabilir.
    if (pendingLibraryNote) {
      showMessage(el("library-message"), pendingLibraryNote, "warn");
    } else {
      hideMessage(el("library-message"));
    }
    try {
      const songs = await api.listSongs();
      markOnlineState(true);
      writeLibraryCache(songs);       // çevrimdışı açılış için cihazda dursun
      renderLibrary(songs);
      // Biten ayrıştırmaları / Hi-Fi yükseltmelerini yakala ve sesi önceden
      // indirmeye başla.
      noteSongsForPrefetch(songs);
      if (songs.some((song) => song.state !== "done" && song.state !== "error")) {
        schedulePoll();
      }
    } catch (error) {
      if (error instanceof ApiError
          && (error.kind === "offline" || error.kind === "network")) {
        markOnlineState(false);
      }
      // Cihazdaki liste duruyorsa onu göstermeye DEVAM et: çevrimdışıyken
      // kitaplığın boşalması en can sıkıcı kusurdu.
      const cached = readLibraryCache();
      if (cached && cached.length) {
        renderLibrary(cached);
        showMessage(el("library-message"),
                    `${describeError(error)}
Liste cihazdaki kopyadan gösteriliyor.`,
                    "warn");
      } else {
        showMessage(el("library-message"), describeError(error));
      }
    } finally {
      if (pendingLibraryNote) {
        showMessage(el("library-message"), pendingLibraryNote, "warn");
        pendingLibraryNote = "";
      }
      libraryRefresh = null;
    }
  })();
  return libraryRefresh;
}

// Uzun basış. Kaydırmayı bozmamak için 10 px'den fazla hareket iptal ediyor;
// sağ tık masaüstünde aynı kapıyı açıyor. `handler` TOGGLE DEĞİL "seç" olmak
// zorunda: Android'de uzun basışta hem zamanlayıcı hem `contextmenu`
// tetiklenebiliyor, toggle olsa seçim anında geri alınırdı.
function bindLongPress(node, handler) {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  node.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Her yeni dokunuşta temizleniyor: uzun basıştan sonra click gelmeyen
    // platformlarda (Android'de contextmenu iptal edilince olabiliyor) bayrak
    // asılı kalır ve BİR SONRAKİ dokunuşu yutardı.
    suppressClick = false;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = 0;
      suppressClick = true;
      handler();
    }, LONG_PRESS_MS);
  });
  node.addEventListener("pointermove", (event) => {
    if (!timer) return;
    if (Math.abs(event.clientX - startX) > 10
        || Math.abs(event.clientY - startY) > 10) cancel();
  });
  for (const name of ["pointerup", "pointercancel", "pointerleave"]) {
    node.addEventListener(name, cancel);
  }
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    handler();
  });
}

function enterSelectMode(songId) {
  selectMode = true;
  if (songId) selectedIds.add(songId);
  renderLibrary(librarySongs);
  pushLayer("select");
}

// SAF DOM kapatıcı: history'ye dokunmuyor, geri tuşu bunu çağırıyor.
function closeSelectModeDom() {
  if (!selectMode) return false;
  selectMode = false;
  selectedIds.clear();
  renderLibrary(librarySongs);
  return true;
}

// UI'dan çıkış (X düğmesi, silme sonrası): yol history'den geçiyor.
function exitSelectMode() {
  if (!selectMode) return false;
  requestBack("select");
  return true;
}

function toggleSelect(songId) {
  if (selectedIds.has(songId)) selectedIds.delete(songId);
  else selectedIds.add(songId);
  renderLibrary(librarySongs);
}

function syncSelectBar() {
  const bar = el("select-bar");
  if (!bar) return;
  bar.hidden = !selectMode;
  const count = selectedIds.size;
  if (el("select-count")) {
    el("select-count").textContent = `${count} seçili`;
  }
  const button = el("select-delete");
  if (button) {
    button.textContent = `Sil (${count})`;
    button.disabled = count === 0;
  }
  const all = el("select-all");
  if (all) {
    const every = librarySongs.length > 0 && count === librarySongs.length;
    all.textContent = every ? "Seçimi bırak" : "Tümünü seç";
  }
}

// ---------------------------------------------------------------- geri tuşu
//
// Katman yığını (navstack.js) history yığınıyla BİREBİR eşleşiyor: her açık
// katman = bir history girdisi. Geri tuşu (ve Android'in kenar jesti) girdiyi
// düşürüyor, popstate en üstteki katmanı kapatıyor. Taban girdide katman
// kalmadığında geri = uygulamadan çıkış, ki kütüphanede istediğimiz tam bu.
//
// URL'e DOKUNULMUYOR: katman yalnızca history.state içinde. URL'e "#player"
// gibi bir şey yazsaydık paylaşılan/yer imine eklenen adres uygulamayı yarı
// açık bir duruma sokardı, ayrıca service worker yönlendirmesiyle uğraşmak
// gerekirdi.
//
// KAPATMANIN TEK YOLU history.back(). UI düğmeleri de oradan geçiyor, yoksa
// iki yığın ayrışır ve geri tuşu "zaten kapalı" bir katmanı kapatmaya
// çalışıp uygulamayı kapatırdı.

const nav = new NavStack();

// Katman adı -> o katmanı kapatan SAF DOM işlevi. Bunlar history'ye
// DOKUNMUYOR; yoksa popstate -> kapat -> history.back() -> popstate döngüsü
// olurdu.
const layerClosers = {
  "lyrics-editor": () => closeLyricsEditorDom(),
  menu: () => {
    if (mixer) mixer.closeMenu();
  },
  panel: closePanelsDom,
  export: () => closeExportDom(),
  fx: () => closeFxDom(),
  "lyrics-full": () => { if (lyricsScreen) lyricsScreen.close(); },
  select: closeSelectModeDom,
  view: () => {
    // Ayarlar mı oynatıcı mı açık, DOM söylüyor.
    if (!views.settings.hidden) {
      showView("library");
      if (isConfigured(settings)) refreshLibrary();
      return;
    }
    stopPlayback();
    stopLoop();
    showView("library");
    refreshLibrary();
  },
};

function pushLayer(name) {
  if (!nav.push(name)) return;
  try {
    // Üçüncü parametre YOK: URL değişmiyor.
    history.pushState({ layer: name, depth: nav.depth }, "");
  } catch {
    /* history yoksa katman yine kapanabilir, sadece geri tuşu çalışmaz */
  }
}

/** UI'dan kapatma. Katman yığındaysa yol history'den geçiyor. */
function requestBack(name) {
  if (nav.peek() === name) {
    history.back();
    return;
  }
  const close = layerClosers[name];
  if (close) close();
}

window.addEventListener("popstate", () => {
  const result = nav.back();
  if (result.action === BLOCKED) {
    // Geri İPTAL EDİLEMİYOR; tarayıcı girdiyi zaten düşürdü, yerine yenisini
    // koyuyoruz ki derinlik eşleşmesi bozulmasın.
    try {
      history.pushState({ layer: nav.peek(), depth: nav.depth }, "");
    } catch {
      /* yok say */
    }
    return;
  }
  if (result.action === CLOSE) {
    const close = layerClosers[result.layer];
    if (close) close();
  }
  // EXIT: hiçbir şey yapmıyoruz; taban girdideyiz, tarayıcı uygulamayı kapatır.
});

// Taban girdi. Sayfa yenilendiğinde de buradan geçiliyor: eski history
// girdileri kalmış olabilir ama katman yığını sıfırdan kuruluyor, ikisini
// yeniden hizalayan şey bu satır.
try {
  history.replaceState({ layer: null, depth: 0, root: true }, "");
} catch {
  /* yok say */
}

function handleBack() {
  if (nav.depth === 0) return false;
  history.back();
  return true;
}

function renderLibrary(songs) {
  const list = el("song-list");
  librarySongs = songs;
  // Silinen ya da listeden düşen kimlikler seçimde kalmasın.
  const present = new Set(songs.map((song) => song.id));
  for (const id of [...selectedIds]) {
    if (!present.has(id)) selectedIds.delete(id);
  }
  if (selectMode && !songs.length) {
    // Liste boşaldıysa seçim modunun anlamı kalmadı. Katmanı da düşür,
    // yoksa geri tuşuna bir kez boşuna basılırdı.
    selectMode = false;
    if (nav.peek() === "select") history.back();
  }
  list.classList.toggle("select-mode", selectMode);
  syncSelectBar();

  // Çevrimdışı işareti ÇEVRİMİÇİYKEN HİÇ HESAPLANMIYOR: online'ken her şarkı
  // açılabilir, satır başına indeks okumaya gerek yok. Çevrimdışıyken de
  // indeks tek seferde alınıp bütün satırlarda kullanılıyor.
  const offlineNow = isOffline();
  const cacheIndex = offlineNow ? stemCache.indexSnapshot() : null;

  list.innerHTML = "";
  if (!songs.length) {
    showMessage(el("library-message"), "Henüz şarkı yok. Yukarıdan bir tane ekle.", "warn");
    return;
  }
  for (const song of songs) {
    const item = document.createElement("li");
    item.className = "song-row";
    item.dataset.id = song.id;
    const picked = selectedIds.has(song.id);
    item.classList.toggle("selected", picked);
    if (selectMode) {
      item.setAttribute("role", "checkbox");
      item.setAttribute("aria-checked", picked ? "true" : "false");
    }

    const box = document.createElement("span");
    box.className = "song-check";
    box.setAttribute("aria-hidden", "true");
    box.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9.6 16.2 5.4 12 4 13.4l5.6 5.6L20 8.6 18.6 7.2z"/></svg>';
    item.append(box);

    const busy = song.state !== "done" && song.state !== "error";
    const thumb = document.createElement("div");
    thumb.className = "song-thumb";
    thumb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';

    const info = document.createElement("div");
    info.className = "song-info";
    const name = document.createElement("div");
    name.className = "song-name";
    name.textContent = song.title || song.id.slice(0, 12);
    // Hi-Fi mi Standart mı, kitaplıkta görünsün.
    if (song.quality) {
      const tag = document.createElement("span");
      tag.className = `quality-tag ${song.quality === "hifi" ? "hifi" : "standard"}`;
      tag.textContent = song.quality === "hifi" ? "Hi-Fi" : "Standart";
      name.append(tag);
    }

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

    // Çevrimdışıyken: cihazda sesi olan şarkı normal, olmayan SOLUK.
    const offline = offlineNow;
    const ready = !offline
      || (song.state === "done" && isOfflineReady(song, cacheIndex));
    item.classList.toggle("offline-missing", offline && !ready);
    if (offline && !ready) {
      item.title = "İnternet yok, bu şarkı telefonda kayıtlı değil";
    }

    // Tek click işleyici: seçim modunda seçer, dışında açar.
    item.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (selectMode) {
        toggleSelect(song.id);
        return;
      }
      if (offline && !ready) {
        // Mikser AÇILMIYOR: boş mikserde bırakmaktansa tek cümle söylemek iyi.
        showMessage(el("library-message"),
                    "İnternet yok, bu şarkı telefonda kayıtlı değil.", "warn");
        return;
      }
      if (song.state === "done") {
        openSong(song);
      } else if (song.state === "error") {
        showMessage(el("library-message"), `${song.title || song.id}: işlenemedi.`);
      }
    });
    // İşlenmekte olan şarkı da seçilebiliyor: sunucu 409 dönüp anlaşılır bir
    // mesaj veriyor, seçimi burada engellemek kullanıcıya "neden seçemiyorum"
    // diye sormaktan iyi değil.
    bindLongPress(item, () => enterSelectMode(song.id));

    list.append(item);
    if (prefetchProgress.has(song.id)) updatePrefetchRow(song.id);
  }
}

// Açık şarkı silindiyse: çalmayı durdur, kütüphaneye dön.
function closeCurrentSong() {
  currentSong = null;
  exportReset();
  refreshExportAvailability();
  stopSubPolling();
  // Oynatıcı hâlâ açıksa katmanı düzgün kapat, yoksa (kütüphanedeyiz)
  // yalnızca çalmayı durdur: yığında olmayan bir katmanı geri almaya
  // çalışmak uygulamadan çıkarırdı.
  if (nav.peek() === "view" && !views.player.hidden) {
    requestBack("view");
    return;
  }
  stopPlayback();
  stopLoop();
  showView("library");
}

async function deleteSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  // Silme SUNUCUDA oluyor; çevrimdışı "sildim" demek yalan olurdu.
  if (!requireOnline(el("library-message"), "şarkı silmek")) return;

  const titles = librarySongs
    .filter((song) => selectedIds.has(song.id))
    .map((song) => song.title || song.id.slice(0, 12));
  const preview = titles.slice(0, 5).join("\n• ");
  const more = titles.length > 5 ? `\n• … ve ${titles.length - 5} tane daha` : "";
  const confirmed = window.confirm(
    `${ids.length} şarkı silinecek:\n\n• ${preview}${more}\n\n`
    + "Stem'ler, kayıpsız FLAC asıllar, akor ve vuruş bilgisi kalıcı olarak "
    + "gidecek. BU İŞLEM GERİ ALINAMAZ.\n\nSilinsin mi?"
  );
  if (!confirmed) return;

  const button = el("select-delete");
  if (button) {
    button.disabled = true;
    button.textContent = "Siliniyor…";
  }
  try {
    const report = await api.deleteSongs(ids);
    const results = report.results || [];
    // not_found da "gitti" sayılıyor: sonuç istenen durumda (belki başka bir
    // cihazdan silinmiş). Önbelleği onlar için de temizliyoruz.
    const gone = results
      .filter((item) => item.outcome === "deleted" || item.outcome === "not_found")
      .map((item) => item.id);
    const busy = results.filter((item) => item.outcome === "busy");
    const invalid = results.filter((item) => item.outcome === "invalid");

    // Telefondaki sesler de gitsin, yoksa depolama boşuna şişer.
    let freed = { removed: 0, bytes: 0 };
    if (gone.length) {
      freed = await stemCache.removeSongs(gone);
      dropMeta(gone);            // cihazdaki durum/akor kopyası da gitsin
      if (mixStorage()) removeMix(mixStorage(), gone);
    }

    if (currentSong && gone.includes(currentSong.id)) closeCurrentSong();

    exitSelectMode();
    await refreshLibrary();

    const notes = [];
    if (gone.length) {
      // Yalnız anlamlı büyüklükte söyleniyor: "0 MB yer açıldı" saçma duruyor.
      const mb = freed.bytes >= 1024 ** 2
        ? ` (${(freed.bytes / 1024 ** 2).toFixed(0)} MB yer açıldı)` : "";
      notes.push(`${gone.length} şarkı silindi${mb}.`);
    }
    for (const item of busy) {
      notes.push(item.detail || "Bir şarkı işlendiği için silinemedi.");
    }
    if (invalid.length) notes.push(`${invalid.length} geçersiz kimlik atlandı.`);
    if (notes.length) {
      showMessage(
        el("library-message"),
        notes.join("\n"),
        busy.length || invalid.length ? "warn" : "ok"
      );
    }
  } catch (error) {
    showMessage(el("library-message"), describeError(error));
  } finally {
    syncSelectBar();
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!views.library.hidden) await refreshLibrary();
  }, POLL_MS);
}

async function handleUpload(file) {
  // Dönen: true = sunucu aldı (ya da zaten vardı), false = yüklenemedi (paylaşım kartı kaydı korusun diye).
  if (!requireOnline(el("library-message"), "şarkı yüklemek")) return false;
  const status = el("upload-status");
  status.hidden = false;
  status.textContent = `${file.name} yükleniyor… %0`;
  try {
    const quality = el("upload-quality") ? el("upload-quality").value : "hifi";
    const result = await api.uploadSong(file, (ratio) => {
      status.textContent = `${file.name} yükleniyor… %${Math.round(ratio * 100)}`;
    }, quality);
    status.textContent = result.existing
      ? `${file.name} zaten işlenmiş, listede.`
      : `${file.name} alındı, işleniyor.`;
    await refreshLibrary();
    schedulePoll();
    return true;
  } catch (error) {
    status.hidden = true;
    showMessage(el("library-message"), describeError(error));
    return false;
  }
}

// ------------------------------------------------ paylaş menüsünden ekleme (Web Share Target)
//
// sw.js POST /share-target'ı yakalayıp ilk dosyayı geçici cache'e koyuyor ve ?paylasim=1 ile buraya yolluyor. Dosya
// önce BU KARTTA görünür; sunucuya (ve GPU'ya) yalnız "Yükle ve ayır"a basınca gidilir. "Şarkı ekle" düğmesi
// bugünkü gibi dosyayı seçince doğrudan yükler (kart yalnız paylaşılan dosyada).

let sharePending = null;      // {file, name, size, note, seconds}
let shareBusy = false;

function renderShareCard() {
  const card = el("share-card");
  if (!card) return;
  if (!sharePending) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  el("share-name").textContent = sharePending.name;
  el("share-meta").textContent = [formatSize(sharePending.size), formatDuration(sharePending.seconds)]
    .filter(Boolean).join(" · ");
  const notes = [sharePending.note, durationWarning(sharePending.seconds)].filter(Boolean);
  const noteNode = el("share-note");
  noteNode.hidden = !notes.length;
  noteNode.textContent = notes.join(" ");
  const offline = isOffline();
  const configured = isConfigured(settings);
  el("share-go").disabled = shareBusy || offline || !configured;
  el("share-cancel").disabled = shareBusy;
  el("share-quality").disabled = shareBusy;
  el("share-go").textContent = shareBusy ? "Yükleniyor…" : "Yükle ve ayır";
  el("share-hint").textContent = !configured ? "Önce Ayarlar'dan API adresini ve token'ı gir."
    : offline ? "İnternet yok; bağlanınca yükleyebilirsin."
    : 'Ayırma (GPU) yalnız "Yükle ve ayır"a basınca başlar.';
}

// Süre: <audio> üst verisinden, en iyi çaba (okunamazsa kart süresiz kalır; sunucu 10 dk sınırını zaten uygular).
function probeDuration(file) {
  return new Promise((resolve) => {
    let url = "";
    const audio = new Audio();
    const done = (value) => {
      clearTimeout(timer);
      audio.removeAttribute("src");
      if (url) URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => done(null), 4000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null);
    try {
      url = URL.createObjectURL(file);
      audio.src = url;
    } catch {
      done(null);
    }
  });
}

async function showShareCard(pending, note) {
  sharePending = { file: pending.file, name: pending.name, size: pending.size, note, seconds: null };
  const select = el("share-quality");
  select.replaceChildren(...[...el("upload-quality").options].map((option) => {
    const copy = document.createElement("option");
    copy.value = option.value;
    copy.textContent = option.textContent;
    return copy;
  }));
  select.value = el("upload-quality").value;
  renderShareCard();
  const seconds = await probeDuration(pending.file);
  if (sharePending && sharePending.file === pending.file) {
    sharePending.seconds = seconds;
    renderShareCard();
  }
}

async function dropShare() {
  sharePending = null;
  shareBusy = false;
  renderShareCard();
  try {
    await clearPending(window.caches);
  } catch {
    /* cache erişilemedi: kayıt 1 saat sonra zaten bayatlıyor */
  }
}

async function confirmShare() {
  if (!sharePending || shareBusy) return;
  shareBusy = true;
  renderShareCard();
  // handleUpload kaliteyi #upload-quality'den ilk satırlarda (await'ten önce) okuyor: kartın seçimini oraya geçici yaz,
  // sonra eski değeri geri koy (kitaplıktaki seçim sessizce değişmesin).
  const select = el("upload-quality");
  const previous = select.value;
  select.value = el("share-quality").value;
  const run = handleUpload(sharePending.file);
  select.value = previous;
  const ok = await run;
  if (ok) {
    await dropShare();
  } else {
    shareBusy = false;
    renderShareCard();
  }
}

// Açılışta: ?paylasim=... varsa adresi temizle; bekleyen kayıt (varsa) kart ya da mesaj olur. Bekleyen kayıt parametresiz
// de bulunur (Android uygulamayı kart açıkken öldürebilir; kayıt 1 saat saklanır).
async function handleShareLaunch() {
  const kind = launchKind(location.search);
  if (new URLSearchParams(location.search).has(SHARE_PARAM)) {
    history.replaceState(history.state, "", location.pathname + location.hash);
  }
  const library = el("library-message");
  const say = (text, tone = "warn") => {
    showMessage(isConfigured(settings) ? library : el("settings-message"), text, tone);
  };
  try {
    if (kind === "empty") say(SHARE_MESSAGES.empty);
    else if (kind === "error") say(SHARE_MESSAGES.error);
    const pending = await readPending(window.caches, location.href);
    if (!pending) {
      if (kind === "file") say(SHARE_MESSAGES.gone);
      return;
    }
    const verdict = classify(pending);
    if (verdict.action === "card") {
      await showShareCard(pending, verdict.note);
      if (!isConfigured(settings)) {
        say("Paylaşılan dosya bekliyor. API adresini ve token'ı girip kaydet, sonra kitaplıkta yükleyebilirsin.", "warn");
      }
    } else {
      if (kind === "file" || pending.state !== "stale") say(verdict.text);
      await clearPending(window.caches);
    }
  } catch (error) {
    console.warn("[share]", error);
    if (kind === "file") say(SHARE_MESSAGES.error);
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

// ------------------------------------------------- açılış hızı: bilgi önbelleği
//
// ÖLÇÜM (masaüstü, 110 sn şarkı, Yüksek kip):
//   ilk açılış      2880 ms = bilgi 18 + indirme 253 + ÇÖZME 2593 + arayüz 16
//   aynı şarkı      2953 ms = bilgi 15 + önbellek 19 + ÇÖZME 2914 + arayüz 5
//   farklı şarkı    4145 ms = bilgi 18 + indirme 259 + ÇÖZME 3867 + arayüz 1
// Yani zamanın %90'ından fazlası decodeAudioData'da. İki sonuç çıkıyor:
//   1. Aynı şarkıya dönerken tamponlar ZATEN bellekte - yeniden çözmek saf
//      israf. Hızlı yol bunu tamamen siliyor.
//   2. Farklı şarkıda çözme kaçınılmaz; ikişerli çözmek (engine.loadStems)
//      indirmeyi de altına saklıyor.
// `bilgi` masaüstünde 18 ms ama telefonda Modal konteyneri soğuksa saniyeler
// sürebiliyor; o yüzden durum/akor cihazda saklanıyor ve açılış onu bekletmiyor.

const META_PREFIX = "stem-mikser.meta.";
const META_LIMIT = 40;          // şarkı başına ~12 KB; localStorage'a rahat sığar

function metaKey(id) {
  return META_PREFIX + id;
}

function readMeta(id) {
  try {
    const raw = localStorage.getItem(metaKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeMeta(id, detail) {
  try {
    localStorage.setItem(metaKey(id), JSON.stringify({
      status: detail.status, chords: detail.chords, savedAt: Date.now(),
    }));
    pruneMeta();
  } catch {
    // Kota dolduysa önemli değil: açılış yavaşlar, bozulmaz.
  }
}

function dropMeta(ids) {
  const lyricsKeep = lyricsStorage();
  if (lyricsKeep) {
    dropLyricsCache(lyricsKeep, ids);       // cihazdaki sözler de gitsin
    TR.dropCache(lyricsKeep, ids);          // ve çeviri önbelleği
    dropKicks(lyricsKeep, ids);             // ve kick vuruş listesi
  }
  for (const id of ids || []) {
    try {
      localStorage.removeItem(metaKey(id));
    } catch {
      /* yok say */
    }
  }
}

function pruneMeta() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(META_PREFIX)) keys.push(key);
    }
    if (keys.length <= META_LIMIT) return;
    const aged = keys.map((key) => {
      let savedAt = 0;
      try {
        savedAt = (JSON.parse(localStorage.getItem(key)) || {}).savedAt || 0;
      } catch {
        savedAt = 0;
      }
      return { key, savedAt };
    }).sort((a, b) => a.savedAt - b.savedAt);
    for (const item of aged.slice(0, aged.length - META_LIMIT)) {
      localStorage.removeItem(item.key);
    }
  } catch {
    /* yok say */
  }
}

// ---------------------------------------------------------------- çevrimdışı
//
// İki ayrı kusur vardı ve ikisi de yerelde tekrar üretildi:
//   1. İnternet yokken uygulama yeniden açılınca kitaplık BOMBOŞ geliyordu -
//      liste yalnız ağdan (`GET /songs`). Yani sesi cihazda duran şarkıya bile
//      ulaşılamıyordu.
//   2. Cihazda kopyası olmayan bir şarkı açılınca uzun uzun bekleyip alakasız
//      "antivirüs / VPN / ALLOWED_ORIGINS" tanı metnini gösteriyor, sonra boş
//      mikserde kalıyordu.
//
// Çözüm sırası: listeyi cihazda tut, isteklere zaman aşımı koy (api.js),
// çevrimdışıyken neyin açılabileceğini kitaplıkta GÖSTER.

const LIBRARY_KEY = "stem-mikser.library";

function readLibraryCache() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Array.isArray(parsed.songs) ? parsed.songs : null;
  } catch {
    return null;
  }
}

function writeLibraryCache(songs) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({
      songs, savedAt: Date.now(),
    }));
  } catch {
    // Kota dolduysa önemli değil: çevrimdışı açılış kötüleşir, uygulama değil.
  }
}

// Sunucuya ulaşılabiliyor mu? navigator.onLine yalnız NEGATİF yönde güvenilir
// (internetsiz Wi-Fi'da da true diyebiliyor), o yüzden son isteğin sonucunu da
// hesaba katıyoruz.
let serverReachable = true;

function isOffline() {
  return isDefinitelyOffline() || !serverReachable;
}

/** Bu şarkı ağ olmadan açılabilir mi? (bilgi + bütün stem'ler cihazda) */
function isOfflineReady(song, index = null) {
  const meta = readMeta(song.id);
  const stems = meta && meta.status && meta.status.stems;
  if (!stems || !stems.length) return false;
  const version = Number(song.stems_version || (meta.status.stems_version || 0));
  const tag = cacheTag(version, song.pipeline || meta.status.pipeline);
  return stemCache.indexHas(song.id, stems, tag, index);
}

/** Ağ gerektiren bir işlemden önce: çevrimdışıysak tek cümleyle söyle. */
function requireOnline(node, what) {
  if (!isOffline()) return true;
  showMessage(node, `İnternet yok, ${what} için bağlantı gerekiyor.`, "warn");
  return false;
}

function markOnlineState(reachable) {
  const changed = serverReachable !== reachable;
  serverReachable = reachable;
  if (changed && !views.library.hidden) renderLibrary(librarySongs);
  syncOfflineUi();
}

// Yükleme düğmesi çevrimdışıyken kapalı: dosya seçtirip sonra hata vermek
// kullanıcıyı boşuna uğraştırırdı.
function syncOfflineUi() {
  const offline = isOffline();
  refreshExportAvailability();
  renderShareCard();
  const label = el("upload-label");
  if (label) {
    label.classList.toggle("disabled", offline);
    const input = el("upload-input");
    if (input) input.disabled = offline;
    label.title = offline ? "İnternet yok" : "";
  }
}

// Tarayıcı ağ durumunu bildirince kitaplığı hemen tazele: "online" olduğunda
// listeyi de yenilemek gerekiyor, çevrimdışıyken eskimiş olabilir.
window.addEventListener("online", () => {
  serverReachable = true;
  syncOfflineUi();
  runPrefetch();
  if (!views.library.hidden && isConfigured(settings)) refreshLibrary();
  else if (!views.library.hidden) renderLibrary(librarySongs);
});
window.addEventListener("offline", () => {
  markOnlineState(false);
});

// ------------------------------------------- arka planda stem indirme (önden)
//
// Telefon ölçümü: cihazda kayıtlı şarkı 1-2 saniyede (9 dakikalık şarkı 6 sn)
// açılıyor; İLK açılışta darboğaz indirme (~0.6-1.2 MB/sn), çözme değil. Yani
// beklemeyi bitirmenin yolu sesi ÖNCEDEN indirmek.
//
// Ne zaman: bir şarkının ayrıştırması bittiğinde (durum -> done) ya da
// Hi-Fi'a yükseltme bitince (aynı şarkının stems_version'ı değişince) -
// yani kullanıcı zaten uygulamayı açık tutup beklerken.
//
// Kullanıcı bir şarkı açarsa indirme DURAKLIYOR: açılıştaki indirmeyle
// bant genişliği paylaşmak, beklenen şeyi yavaşlatmak demek. Duraklatma
// AbortController ile anında; yarım kalan stem sonra baştan iniyor (bir
// stem 2-10 MB, telefonda 10-20 saniye - "bir sonraki stem'i bekle" çok kaba
// kalırdı).

const prefetchQueue = [];          // [{id, title, version}]
const prefetchQueued = new Set();  // kuyrukta ya da inen kimlikler
const prefetchProgress = new Map(); // id -> {done, total, ratio}
let prefetchRunning = false;
let prefetchPaused = false;
let prefetchAbort = null;
// Kitaplıkta en son görülen durum: geçişi (bitti / sürüm değişti) yakalamak
// için. İlk listede kuyruğa hiçbir şey eklenmiyor - açılışta bütün kitaplığı
// indirmeye kalkmak istemiyoruz, yalnız GÖZÜMÜZÜN ÖNÜNDE biteni.
const seenSongs = new Map();       // id -> {state, version}

function noteSongsForPrefetch(songs) {
  for (const song of songs) {
    const id = song.id;
    const version = Number(song.stems_version || 0);
    const before = seenSongs.get(id);
    seenSongs.set(id, { state: song.state, version });
    if (!before) continue;                     // ilk görüş: geçiş sayılmaz
    if (song.state !== "done") continue;
    const finished = before.state !== "done";  // ayrıştırma bitti
    const upgraded = before.version && version && before.version !== version;
    if (finished || upgraded) enqueuePrefetch(song);
  }
}

function enqueuePrefetch(song) {
  if (!song || !song.id || prefetchQueued.has(song.id)) return;
  if (isOffline()) return;
  prefetchQueued.add(song.id);
  prefetchQueue.push({
    id: song.id,
    title: song.title || song.id.slice(0, 12),
    version: Number(song.stems_version || 0),
  });
  runPrefetch();
}

function pausePrefetch() {
  prefetchPaused = true;
  if (prefetchAbort) prefetchAbort.abort();
}

function resumePrefetch() {
  prefetchPaused = false;
  runPrefetch();
}

async function runPrefetch() {
  if (prefetchRunning || prefetchPaused) return;
  if (!prefetchQueue.length) return;
  prefetchRunning = true;
  try {
    while (prefetchQueue.length && !prefetchPaused && !isOffline()) {
      const item = prefetchQueue[0];
      const ok = await prefetchSong(item);
      if (!ok) break;              // duraklatıldı ya da hata: kuyrukta kalsın
      prefetchQueue.shift();
      prefetchQueued.delete(item.id);
      prefetchProgress.delete(item.id);
      updatePrefetchRow(item.id);
    }
  } finally {
    prefetchRunning = false;
  }
}

/** Tek şarkı. true = bitti, false = yarıda kaldı (kuyrukta kalmalı). */
async function prefetchSong(item) {
  try {
    // Stem listesi cihazda yoksa bir kez sunucudan: küçük istek.
    let meta = readMeta(item.id);
    if (!meta || !meta.status || Number(meta.status.stems_version || 0) !== item.version) {
      const detail = await api.getSong(item.id);
      writeMeta(item.id, detail);
      meta = readMeta(item.id);
    }
    const stems = (meta && meta.status && meta.status.stems) || STEM_ORDER;
    const version = Number((meta && meta.status && meta.status.stems_version) || item.version);
    const tag = cacheTag(version, meta && meta.status && meta.status.pipeline);
    if (stemCache.indexHas(item.id, stems, tag)) return true;  // zaten var

    prefetchProgress.set(item.id, { done: 0, total: stems.length, ratio: 0 });
    updatePrefetchRow(item.id);

    for (let i = 0; i < stems.length; i += 1) {
      const name = stems[i];
      if (prefetchPaused || isOffline()) return false;
      if (await stemCache.get(item.id, name, tag)) {
        // Zaten cihazda: okuduğumuzu geri yazmıyoruz, sadece sayacı ilerlet.
        prefetchProgress.set(item.id, { done: i + 1, total: stems.length, ratio: 0 });
        updatePrefetchRow(item.id);
        continue;
      }
      prefetchAbort = new AbortController();
      try {
        const buffer = await api.stemBuffer(item.id, name, (ratio) => {
          const entry = prefetchProgress.get(item.id);
          if (entry) {
            entry.ratio = ratio;
            updatePrefetchRow(item.id);
          }
        }, prefetchAbort.signal);
        await stemCache.put(item.id, name, buffer, tag);
      } finally {
        prefetchAbort = null;
      }
      prefetchProgress.set(item.id, { done: i + 1, total: stems.length, ratio: 0 });
      updatePrefetchRow(item.id);
    }
    console.info(`[onden] ${item.title} cihaza indi (${stems.length} kanal)`);
    return true;
  } catch (error) {
    // Duraklatma da buraya düşüyor (AbortError). Sessizce bırakıyoruz:
    // önden indirme bir kolaylık, hata mesajı göstermeye değmez.
    if (!prefetchPaused) {
      console.info(`[onden] ${item.title} indirilemedi: `
        + `${error && error.message ? error.message : error}`);
      // Ağ sorunu ise kuyrukta bırakıp duruyoruz; kullanıcı yenileyince ya da
      // bağlantı gelince yeniden denenecek.
      return false;
    }
    return false;
  }
}

// Satırı yerinde güncelliyoruz: bütün listeyi yeniden çizmek her yüzde
// değişiminde seçim modunu ve kaydırma konumunu hırpalardı.
function updatePrefetchRow(songId) {
  const row = el("song-list") && el("song-list").querySelector(`[data-id="${songId}"]`);
  if (!row) return;
  const sub = row.querySelector(".song-sub");
  const entry = prefetchProgress.get(songId);
  if (!entry) {
    if (sub && sub.dataset.original) {
      sub.textContent = sub.dataset.original;
      delete sub.dataset.original;
    }
    const bar = row.querySelector(".mini-progress.prefetch");
    if (bar) bar.remove();
    return;
  }
  const percent = Math.min(
    99,
    Math.round(((entry.done + entry.ratio) / entry.total) * 100)
  );
  if (sub) {
    if (!sub.dataset.original) sub.dataset.original = sub.textContent;
    sub.textContent = `${sub.dataset.original} · cihaza iniyor %${percent}`;
  }
  let bar = row.querySelector(".mini-progress.prefetch");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "mini-progress prefetch";
    bar.append(document.createElement("i"));
    const info = row.querySelector(".song-info");
    if (info) info.append(bar);
  }
  const fill = bar.querySelector("i");
  if (fill) fill.style.width = `${Math.max(percent, 3)}%`;
}

// Bellekte duran şarkının kimliği: hızlı yolun kapısı.
let loadedState = null;   // {id, stemsVersion, audioMode}

function canReuseLoaded(song) {
  if (!loadedState || !currentSong || currentSong.id !== song.id) return false;
  if (engine.channels.size === 0) return false;
  // Sürüm BİLİNMİYORSA hızlı yol YOK: Hi-Fi'a yükseltilmiş bir şarkıyı eski
  // sesiyle açmaktansa yeniden yüklemek iyidir. Sessiz bayat ses en kötüsü.
  const version = Number(song.stems_version || 0);
  if (!version || version !== loadedState.stemsVersion) return false;
  return engine.audioMode === loadedState.audioMode;
}

// Cihazdaki bilgiyle açtıysak sunucuyu ARKADA yokluyoruz. stems_version
// değiştiyse (ör. "Hi-Fi'a yükselt" başka bir cihazdan yapıldıysa) şarkı
// yeniden yükleniyor - bu kontrol olmadan eski ses SESSİZCE çalardı.
async function refreshSongDetail(song, usedVersion) {
  try {
    const detail = await api.getSong(song.id);
    writeMeta(song.id, detail);
    const fresh = Number((detail.status && detail.status.stems_version) || 0);
    if (fresh && fresh === usedVersion && currentSong && currentSong.id === song.id) {
      adoptDetail(detail);          // sözlerin / alt parçaların güncel durumu
      refreshSubUi();
      initLyrics();
    }
    if (!fresh || fresh === usedVersion) return;
    if (!currentSong || currentSong.id !== song.id || views.player.hidden) return;
    console.info(`[acilis] stems_version degisti ${usedVersion} -> ${fresh}, yeniden yukleniyor`);
    showMessage(el("player-message"),
                "Bu şarkının sesi sunucuda yenilenmiş, yeni sürüm yükleniyor…", "warn");
    loadedState = null;
    await openSong({ ...song, ...detail, stems_version: fresh });
  } catch {
    // Ağ yoksa cihazdaki bilgiyle devam: çevrimdışı açılış zaten kazanç.
  }
}

// Açılışın nereye gittiğini ÖLÇÜYORUZ: bilgi isteği, önbellekten okuma, ağ,
// çözme, arayüz. Telefonda konsol zor okunuyor ama tek satır özet yeterli ve
// tahminle iyileştirme yapmanın önünü kesiyor.
// Son açılışın dökümü Ayarlar ekranında görünüyor: telefonda konsol okumak zor
// ve bu sayılar olmadan "hızlandı mı" sorusu tahmine kalıyor.
const LAST_OPEN_KEY = "stem-mikser.lastopen";
let lastOpen = readLastOpen();

function readLastOpen() {
  try {
    const raw = localStorage.getItem(LAST_OPEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLastOpen(stats) {
  lastOpen = stats;
  try {
    localStorage.setItem(LAST_OPEN_KEY, JSON.stringify(stats));
  } catch {
    /* kota: ölçüm yine ekranda, sadece yeniden açılışta kaybolur */
  }
  refreshOpenStats();
}

function openTimer() {
  const t0 = performance.now();
  let last = t0;
  const marks = [];
  const steps = {};
  return {
    mark(name) {
      const now = performance.now();
      const ms = Math.round(now - last);
      marks.push(`${name} ${ms}`);
      steps[name] = ms;
      last = now;
    },
    done(prefix, extra = {}) {
      const total = Math.round(performance.now() - t0);
      console.info(`[acilis] ${prefix} toplam ${total} ms | ${marks.join(" | ")}`);
      saveLastOpen({ kind: prefix, total, steps, at: Date.now(), ...extra });
      return total;
    },
  };
}

async function openSong(song) {
  const timer = openTimer();
  // Arka plan indirmesi kullanıcının beklediği indirmeyle bant genişliği
  // paylaşmasın.
  pausePrefetch();

  // HIZLI YOL: aynı şarkı, aynı sürüm, aynı kalite kipi ve tamponlar hâlâ
  // bellekte. İndirme de çözme de yok, oynatıcı olduğu gibi duruyor -
  // duraklatılan konum bile korunuyor.
  if (canReuseLoaded(song)) {
    showView("player");
    pushLayer("view");
    lastPositionSync = -1;
    startLoop();
    refreshSubUi();
    ensureSubPolling();
    initLyrics();
    resumePrefetch();   // hızlı yolda indirme yapılmadı, hemen devam
    timer.done("hizli acilis (bellekte)", {
      source: "bellek", concurrency: 0,
      duration: Number(song.duration) || 0,
    });
    return;
  }

  showView("player");
  pushLayer("view");
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

  // Eski şarkının PCM'i İNDİRMEDEN ÖNCE bırakılıyor. setStems zaten
  // kanalları temizliyor ama o ancak altı dosya indikten SONRA çalışıyor;
  // arada iki şarkının tamponları birden bellekte duruyordu (8 dk, tasarruf
  // kipi: 350 + 350 MB). Kütüphaneye dönüşte BIRAKILMIYOR - aynı şarkıya
  // hızlı dönebilmek bilinçli olarak korunuyor.
  engine.releaseStems();
  // Tamponlar gitti: hızlı yolun kapısı kapansın. Yükleme başarısız bitse
  // bile burada null kalıyor, yoksa boş motorla "bellekte" denirdi.
  loadedState = null;
  flushMixSave();           // önceki şarkının bekleyen ayarı ANINDA yazılsın
  mixSongId = null;
  resetLoopState();         // motor döngüyü releaseStems'te bıraktı
  stopSubPolling();
  subStarting.clear();
  subBusy = false;
  mixer.groupSpecs.clear();
  resetLyrics();
  exportReset();
  closeFxDom();
  refreshExportAvailability();

  setOverlay(true, "Şarkı bilgileri alınıyor…");
  try {
    // Sürümün otoritesi KİTAPLIK SATIRI: /songs listesi stems_version'ı
    // veriyor ve az önce tazelendi. Cihazdaki bilgi yalnız o sürümle
    // eşleşiyorsa kullanılıyor, yani bayat akor/vuruşla açma ihtimali yok.
    const listVersion = Number(song.stems_version || 0);
    const cached = listVersion ? readMeta(song.id) : null;
    const cachedOk = cached && cached.status
      && Number(cached.status.stems_version || 0) === listVersion;

    let detail;
    if (cachedOk) {
      detail = { status: cached.status, chords: cached.chords };
      timer.mark("bilgi-cihazdan");
      refreshSongDetail(song, listVersion);   // await YOK: arkada koşuyor
    } else {
      detail = await api.getSong(song.id);
      writeMeta(song.id, detail);
      syncLyricsCache(detail);
      timer.mark("bilgi");
    }
    currentSong = { ...song, ...detail };
    const stems = (detail.status && detail.status.stems) || STEM_ORDER;
    // Alt parçalar (Aşama 10): sunucuda yoksa (ana şarkı yeniden işlendi) cihazdaki
    // lead/backing bayat kalmasın. Arayüz oturum 3'te.
    for (const group of GROUP_ORDER) {
      const sub = subOf(detail.status, group);
      if (!(sub && sub.state === "done")) {
        stemCache.removeNames(song.id, subNames(group)).catch(() => {});
      }
    }
    // Yeniden işlemede stem dosyaları değişiyor; sürüm önbellek anahtarına
    // giriyor, yoksa cihaz eski sesi çalmaya devam eder.
    const stemsVersion = Number((detail.status && detail.status.stems_version) || 0);
    // Önbellek anahtarı: stems_version + boru hattı sürümü (hifi_v2 gibi).
    const cacheKeyTag = cacheTag(stemsVersion, detail.status && detail.status.pipeline);

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
    // Getirme ve çözme TEK boru hattında, ikişerli. Eskiden önce altı dosya
    // iniyor, sonra çözme başlıyordu; indirme artık çözmenin altında saklanıyor.
    // İkiden fazlası yok: "Tasarruf" kipinde her çözme kendi stereo ara
    // tamponunu açıyor (9 dk / 32 kHz için ~69 MB), ikisi aynı anda +138 MB.
    let fromCache = 0;
    let loadStats = null;
    const parallelCount = settings.decodeParallel;
    setOverlay(true, "Kanallar hazırlanıyor…");
    const duration = await engine.loadStems(stems, async (name) => {
      const fill = fills.get(name);
      // Önce cihazdaki kopya: ikinci açılışta ağa hiç çıkılmıyor.
      let arrayBuffer = await stemCache.get(song.id, name, cacheKeyTag);
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
        await stemCache.put(song.id, name, arrayBuffer.slice(0), cacheKeyTag);
      }
      return arrayBuffer;
    }, {
      concurrency: parallelCount,
      onStats: (info) => { loadStats = info; },
    });
    console.info(`[stem] ${fromCache}/${stems.length} kanal cihazdan geldi`);
    timer.mark(fromCache === stems.length ? "onbellek+cozme" : "indirme+cozme");
    measureAacDelta(detail.status, duration);

    mixer.render(stems.filter((name) => engine.channels.has(name)));
    currentStemTag = cacheKeyTag;
    restoreMix(song.id);
    refreshSubUi();            // alt parça denetimi (düğme / ok / mesaj)
    ensureSubPolling();
    initLyrics();              // sözler: cihazdan ya da sunucudan, yoklama
    strip.build(detail.chords, duration);

    const chords = detail.chords;

    // Hız ve ton her şarkıda ORİJİNALE dönüyor: esnetici devre dışı, zincir
    // source -> gain -> master.
    originalBpm = chords && Number(chords.bpm) > 0 ? Number(chords.bpm) : 0;
    originalKey = (chords && chords.key) || null;
    tempoOffset = 0;
    pitchSemis = 0;
    vinylMode = false;
    if (el("vinyl-toggle")) el("vinyl-toggle").checked = false;
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
    setLoopGrid(chords);
    el("metro-toggle").disabled = !(chords && chords.beats && chords.beats.length);

    media.setMetadata({
      title: song.title || song.id.slice(0, 12),
      artist: chords ? `${chords.key || ""} · ${Math.round(chords.bpm || 0)} BPM` : "",
    });
    // "Hi-Fi'a yükselt" yalnız Standart ayrıştırılmış şarkılarda anlamlı.
    if (el("reprocess")) {
      const isStandard = (detail.status && detail.status.quality) === "standard";
      el("reprocess").hidden = !isStandard;
      el("reprocess").disabled = false;
    }

    media.bindHandlers({ onPlay: startPlayback, onPause: stopPlayback });
    lastPositionSync = -1;
    setOverlay(false);
    startLoop();
    // Hızlı yolun kapısı: ne yüklü olduğunu burada kayda geçiyoruz.
    loadedState = {
      id: song.id, stemsVersion, audioMode: engine.audioMode,
    };
    timer.mark("arayuz");
    resumePrefetch();
    timer.done(cachedOk ? "tam yukleme (bilgi cihazdan)" : "tam yukleme", {
      source: fromCache === stems.length ? "cihaz"
        : (fromCache === 0 ? "ağ" : `karışık ${fromCache}/${stems.length}`),
      infoSource: cachedOk ? "cihaz" : "ağ",
      concurrency: parallelCount,
      duration: Number(duration) || 0,
      stems: stems.length,
      // Boru hattı ikisini üst üste bindiriyor; bu toplamlar duvar saatinden
      // büyük olabilir ama HANGİSİNİN uzadığını ancak bunlar söylüyor.
      fetchMs: loadStats ? loadStats.fetchMs : null,
      decodeMs: loadStats ? loadStats.decodeMs : null,
      bytes: loadStats ? loadStats.bytes : null,
    });
  } catch (error) {
    // AÇILIŞ HERHANGİ BİR ADIMDA DÜŞERSE boş mikserde kalınmıyor: oynatıcı
    // katmanı kapanıyor ve sebep kitaplıkta yazıyor. Mesaj pendingLibraryNote
    // üzerinden gidiyor, çünkü katmanı kapatan yol kitaplığı tazeliyor ve
    // tazeleme ilk iş mesajı siliyor.
    setOverlay(false);
    stopPlayback();
    stopLoop();
    engine.releaseStems();
    loadedState = null;
    currentSong = null;
    resetLyrics();
    exportReset();
    refreshExportAvailability();
    const offlineMissing = error instanceof ApiError
      && (error.kind === "offline" || error.kind === "network");
    // Sunucuya ulaşılamadığı buradan da öğreniliyor: kitaplık hemen
    // çevrimdışı görünümüne geçsin, hangi şarkının açılabileceği belli olsun.
    if (offlineMissing) markOnlineState(false);
    pendingLibraryNote = offlineMissing && isOffline()
      ? "İnternet yok, bu şarkı telefonda kayıtlı değil."
      : describeError(error);
    if (nav.peek() === "view") history.back();
    else {
      showView("library");
      await refreshLibrary();
    }
    resumePrefetch();
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

// Duyulan perde (tam yarım ses): bağımsız kipte kaydırıcı, plak gibi kipte oranın en yakın yarım sesi.
function shownSemis() {
  return vinylMode ? keyShift(currentRate()).shift : pitchSemis;
}

function effectiveKey() {
  if (!originalKey) return null;
  const semis = shownSemis();
  if (!semis) return originalKey;
  return transposeKey(originalKey, semis) || originalKey;
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

  const derived = vinylMode ? vinylPitch(rate) : 0;
  if (el("pitch-value")) {
    if (vinylMode) {
      const approx = keyShift(rate).approx ? " ≈" : "";
      el("pitch-value").textContent = originalKey
        ? (shownSemis() ? `${originalKey} → ${effectiveKey()}${approx}` : originalKey)
        : formatPitch(derived);
    } else if (originalKey) {
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
    el("pitch-sub").textContent = vinylMode
      ? `${formatPitch(derived)} · tempoya bağlı`
      : pitchSemis ? `${signed(pitchSemis)} yarım ses` : "orijinal";
  }

  // Plak gibi kipinde ton kaydırıcısı KİLİTLİ: tempoyu izliyor (türetilen değeri gösterir).
  const pitchRow = el("pitch-range") ? el("pitch-range").closest(".tune-row") : null;
  if (pitchRow) pitchRow.classList.toggle("locked", vinylMode);
  for (const id of ["pitch-range", "pitch-minus", "pitch-plus"]) {
    if (el(id)) el(id).disabled = vinylMode;
  }
  if (vinylMode && el("pitch-range")) el("pitch-range").value = String(nearestSemitone(rate));
  if (el("vinyl-toggle")) el("vinyl-toggle").checked = vinylMode;

  if (el("tempo-reset")) el("tempo-reset").disabled = tempoOffset === 0;
  if (el("pitch-reset")) el("pitch-reset").disabled = vinylMode || pitchSemis === 0;
  // Panel kapalıyken de esneticinin açık olduğu düğmeden görünsün.
  if (el("tempo-toggle")) {
    el("tempo-toggle").classList.toggle("changed", tempoOffset !== 0 || (!vinylMode && pitchSemis !== 0));
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
  const shown = shownSemis();
  if (shown !== appliedSemis) {
    appliedSemis = shown;
    strip.setTranspose(shown, originalKey);
  }

  const ctx = engine.ctx;
  if (!ctx) return;  // şarkı açılmadan buraya gelinmiyor, yine de korunalı

  const gen = ++stretchGen;
  if (vinylMode) {
    // Plak gibi: esnetici YOK, gecikme 0, ölçüm yok. Hız yalnız kaynağın playbackRate'inden.
    await engine.setTempoAndPitch(rate, 0, 0, true);
    media.updatePosition();
    return;
  }
  // İSTENEN değil GERÇEKTEN KURULAN arka ucun gecikmesi: kütüphane
  // yüklenemeyip yedeğe düşüldüyse ölçüm de yedeğe ait olmalı.
  const backend = engine.activeStretcher;
  const guess = estimateLatency(ctx.sampleRate, rate, semis, backend);
  await engine.setTempoAndPitch(rate, semis, guess, false);
  media.updatePosition();
  if (!measure) return;

  const measured = await measureLatency(ctx.sampleRate, rate, semis, backend);
  // Kullanıcı ölçüm sürerken başka bir değere geçtiyse bu sonuç bayat.
  if (gen !== stretchGen) return;
  if (Math.abs(measured - guess) < 0.002) return;
  await engine.setTempoAndPitch(rate, semis, measured, false);
  media.updatePosition();
}

// "Plak gibi" anahtarı. AÇARKEN ton kaydırıcısı kilitlenir ve tempoyu izler; KAPATIRKEN bağımsız ton, duyulan
// perdeye en yakın tam yarım ses olur (esnetici aynı sesi korur, perde sıçramaz).
function setVinylMode(on) {
  const next = Boolean(on);
  if (next === vinylMode) return undefined;
  if (!next) {
    pitchSemis = nearestSemitone(currentRate());
    if (el("pitch-range")) el("pitch-range").value = String(pitchSemis);
  }
  vinylMode = next;
  return applyStretch(true);
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
  if (vinylMode) return undefined;              // plak gibi kipinde ton tempoya bağlı
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

// Geri tuşunun "panel" katmanı: AÇIK OLAN paneli kapatıyor, metronomun
// kendisine DOKUNMUYOR - panel kapanınca metronom çalmaya devam ediyor.
function closePanelsDom() {
  closeTunePanel();
  if (el("metro-panel")) el("metro-panel").hidden = true;
}

// Katman yığınını panellerin GERÇEK durumundan türetiyoruz. İki panel
// birbirini kapattığı için ayrı ayrı saymak gereksiz: açık panel varsa tek
// bir "panel" katmanı var, yoksa yok.
function syncPanelLayer() {
  const tempoOpen = el("tempo-panel") && !el("tempo-panel").hidden;
  const metroOpen = el("metro-panel") && !el("metro-panel").hidden;
  if (tempoOpen || metroOpen) pushLayer("panel");
  else if (nav.peek() === "panel") history.back();
}

on("tempo-toggle", "click", async (event) => {
  event.stopPropagation();
  // AudioContext hazır olmalı; bu bir kullanıcı hareketi.
  await engine.ensureContext();
  const open = el("tempo-panel").hidden;
  el("tempo-panel").hidden = !open;
  el("tempo-toggle").setAttribute("aria-pressed", String(open));
  if (open && el("metro-panel")) el("metro-panel").hidden = true;
  syncPanelLayer();
});

// input = sürükleme (ölçüm yok), change = bırakma (ölçüm var).
on("tempo-range", "input", () => setTempoOffset(Number(el("tempo-range").value), false));
on("tempo-range", "change", () => setTempoOffset(Number(el("tempo-range").value), true));
on("tempo-minus", "click", () => setTempoOffset(tempoOffset - 1, true));
on("tempo-plus", "click", () => setTempoOffset(tempoOffset + 1, true));
on("tempo-reset", "click", () => setTempoOffset(0, true));
on("vinyl-toggle", "change", () => setVinylMode(el("vinyl-toggle").checked));

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
  syncPanelLayer();
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
  if (lyricsScreen) lyricsScreen.setPlaying(playing);
}

// Tam ekran sözler açıkken ekran kilidi (Wake Lock) çalma bitse de tutulur; ekran kapanınca
// (LyricsScreen.close) çalma da yoksa bırakılır.
function releasePlaybackWake() {
  if (!(lyricsScreen && lyricsScreen.isOpen)) wakeLock.release();
}

function startLoop() {
  cancelAnimationFrame(rafHandle);
  const tick = () => {
    // visualTime: KULAĞA GİDEN konum. currentTime esneticiden çıkanı
    // gösteriyor, ona ctx.outputLatency daha eklenecek - Bluetooth
    // kulaklıkta 200 ms'yi buluyor ve imleç sesin önüne geçiyor.
    const time = engine.visualTime;
    strip.update(time);
    lyricsTick(time);
    if (lyricsScreen) lyricsScreen.tick(time);
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
      releasePlaybackWake();
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


// ------------------------------------------------- mikser hafızası (Madde 4)
// Şarkı KİMLİĞİNE bağlı (stems_version'a değil); biçim ve kurallar mixmemory.js'te.

const MIX_SAVE_DELAY = 500;
let mixSongId = null;       // restoreMix'ten sonra dolu; yüklenirken null = kayıt yok
let mixTimer = 0;
let mixPending = null;      // {id, states, master}: ANLIK görüntü, şarkı değişse de doğru şarkıya yazılır

function mixStorage() {
  try { return localStorage; } catch { return null; }
}

function masterPercent() {
  return Math.round(Number(el("master").value)) || 0;
}

function scheduleMixSave(options = {}) {
  if (!mixSongId) return;
  mixPending = {
    id: mixSongId, states: snapshot(engine.channels), master: masterPercent(), room: roomState,
    // Sıfırlama: kapalı alt kanalların (lead/backing) kayıtlı ayarı da silinsin.
    replaceAbsent: Boolean(options.replaceAbsent || (mixPending && mixPending.replaceAbsent
      && mixPending.id === mixSongId)),
  };
  hideMixNotice();
  clearTimeout(mixTimer);
  mixTimer = setTimeout(flushMixSave, MIX_SAVE_DELAY);
}

function flushMixSave() {
  clearTimeout(mixTimer);
  mixTimer = 0;
  const pending = mixPending;
  mixPending = null;
  const storage = mixStorage();
  if (pending && storage) {
    writeMix(storage, pending.id, pending.states, pending.master, Date.now(),
             { replaceAbsent: pending.replaceAbsent, room: pending.room });
  }
}

function hideMixNotice() {
  const notice = el("mix-notice");
  if (notice) notice.hidden = true;
}

function setMasterPercent(percent) {
  el("master").value = String(percent);
  const gain = percent / 100;
  engine.setMaster(gain);
  el("master-value").textContent = `${gainToDb(gain)} dB`;
}

// Kanallar kurulduktan SONRA çağrılır. Kayıt yoksa hiçbir şeye dokunmaz.
function restoreMix(songId) {
  mixSongId = null;                 // geri yükleme kendi kaydını tetiklemesin
  mixPending = null;
  hideMixNotice();
  const storage = mixStorage();
  const record = storage ? readMix(storage, songId) : null;
  const names = [...engine.channels.keys()];
  updatePresetButtons(names);
  setRoomState(record && record.room ? record.room : DEFAULT_ROOM);     // oda her şarkıda kayıttan ya da varsayılan
  if (record) {
    const plan = planRestore(record, names);
    engine.applyMix(plan);
    setMasterPercent(record.master);
    mixer.syncFromEngine();
    // Yalnız döngü kayıtlıysa "ayar geri yüklendi" rozeti boşuna çıkmasın.
    el("mix-notice").hidden = isDefaultMix(plan, record.master, record.room);
    // Döngü KAPALI gelir, uçlar yerinde görünür, tek dokunuşla açılır.
    const saved = record.loop ? normalizeLoop(record.loop.a, record.loop.b, engine.duration) : null;
    if (saved) {
      loopA = saved.a;
      loopB = saved.b;
      loopOn = false;
      refreshLoopUi();
    }
  }
  mixSongId = songId;
}

function updatePresetButtons(names) {
  for (const button of document.querySelectorAll("#mix-presets [data-preset]")) {
    const preset = PRESETS.find((item) => item.id === button.dataset.preset);
    if (preset && preset.needsSub) {
      // Alt parçası olmayan (ya da açılamayan) şarkıda pasif.
      button.disabled = !subUsable(preset.group || "vocals");
    } else {
      button.disabled = !preset || !applyPreset(preset, names);
    }
  }
}

function applyMixStates(states, options = {}) {
  engine.applyMix(states);
  mixer.syncFromEngine();
  scheduleMixSave(options);
}

function buildPresetButtons() {
  const box = el("mix-presets");
  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.preset = preset.id;
    button.textContent = preset.label;
    button.addEventListener("click", async () => {
      const group = preset.group || "vocals";
      if (preset.needsSub && !subExpanded(group)) {
        // Alt parçalar hazır ama kapalı: önce aç (kısa yeniden başlatma; başka
        // bir grup açıksa o kapanır).
        await expandSub(group);
        if (!subExpanded(group)) return;
      }
      const states = applyPreset(preset, [...engine.channels.keys()]);
      // Ön ayar "temiz başlangıç": kapalı alt kanalların eski kayıtlı ayarı da gitsin.
      if (states) applyMixStates(states, { replaceAbsent: true });
      if (states && preset.room) setRoomState(preset.room);
      if (states && preset.tempo) applyTempoPreset(preset.tempo);
    });
    box.append(button);
  }
}

// "Sıfırla": fader/mute/solo + pan/EQ/yankı gönderimi + ortak oda (hız/ton kendi "Orijinale geri dön"üyle sıfırlanır).
function resetMix() {
  setRoomState(DEFAULT_ROOM, false);
  applyMixStates(cleanStates([...engine.channels.keys()]), { replaceAbsent: true });
  refreshFxSheet();
}

on("mix-reset", "click", resetMix);

on("mix-notice-reset", "click", resetMix);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushMixSave();
});
window.addEventListener("pagehide", flushMixSave);

// ----------------------------------------------- miksi dışa aktar (Aşama 12)
// Mikserin o anki hâli SUNUCUDA tek ses dosyasına çevrilir (POST /songs/{id}/export,
// yoklama, imzalı indirme). Mantık exportmix.js'te; burası yalnız panel ve bağlama.
// Panel bir geri-tuşu katmanı ("export"). Panel kapanınca iş sürer: sunucu bir
// şarkıda tek iş yürütüyor ve dosya 24 saat durur; yeniden açınca durum görünür.

const EXPORT_LABELS = { ...STEM_LABELS, ...SUB_LABELS };
let exportRun = {
  gen: 0, phase: "idle", songId: null, specKey: null, result: null, file: null,
  shareState: "none", note: "", startedAt: 0, step: "starting", message: "", messageKind: "error",
};
let exportTicker = 0;

function exportOptions() {
  const rate = engine.rate;
  const semis = engine.semitones;
  const vinyl = engine.vinyl;
  const tempoChanged = rate !== 1 || semis !== 0;
  const hasLoop = loopA !== null && loopB !== null && loopB - loopA >= 0.1;
  return {
    format: document.querySelector('input[name="export-format"]:checked')?.value === "wav" ? "wav" : "m4a",
    useTempo: el("export-tempo").checked && tempoChanged,
    useRegion: el("export-region").checked && hasLoop,
    tempoChanged, hasLoop, rate, semis, vinyl,
  };
}

function exportInputs() {
  const options = exportOptions();
  return {
    channels: engine.channels, masterPercent: masterPercent(),
    rate: options.rate, semitones: options.semis, vinyl: options.vinyl,
    loop: options.hasLoop ? { a: loopA, b: loopB } : null,
    options, labels: EXPORT_LABELS, room: roomState,
  };
}

function exportWorking() {
  return exportRun.phase === "working";
}

function exportSetMessage(text, kind = "error") {
  exportRun.message = text;
  exportRun.messageKind = kind;
}

// Ayarlar paneli açılırken ya da değişirken: özet, kutuların durumu, düğme.
function exportRefreshForm() {
  if (!currentSong) return;
  const input = exportInputs();
  const { options } = input;
  const built = buildExportRequest(input);
  const busy = exportWorking();

  el("export-preset").textContent = presetLabel(engine.channels);
  el("export-summary-text").textContent = summarizeExport(input);

  el("export-tempo").disabled = busy || !options.tempoChanged;
  el("export-tempo-row").classList.toggle("disabled", !options.tempoChanged);
  el("export-tempo-note").textContent = tempoNote(options.rate, options.semis, options.vinyl);
  el("export-region-row").hidden = !options.hasLoop;
  el("export-region").disabled = busy;
  el("export-region-note").textContent = options.hasLoop ? regionNote({ a: loopA, b: loopB }) : "";
  for (const radio of document.querySelectorAll('input[name="export-format"]')) radio.disabled = busy;

  // Sonuç yalnız AYNI ayar için geçerli: biçim/kutu değişince eski dosya ortadan kalkar.
  if (!busy && exportRun.specKey && built.ok && exportRun.specKey !== JSON.stringify(built.body)
      && (exportRun.phase === "done" || exportRun.phase === "error")) {
    exportReset();
  }

  const offline = isOffline();
  let message = exportRun.message;
  let kind = exportRun.messageKind;
  if (exportRun.phase === "idle" || exportRun.phase === "error") {
    if (!built.ok) { message = built.problem; kind = "warn"; }
    else if (offline) { message = "İnternet yok, dışa aktarmak için bağlantı gerekiyor."; kind = "warn"; }
    else if (exportRun.phase === "idle") message = "";
  }
  const messageNode = el("export-message");
  if (message && (exportRun.phase !== "done")) showMessage(messageNode, message, kind);
  else hideMessage(messageNode);

  const done = exportRun.phase === "done";
  el("export-go").hidden = done;
  el("export-go").disabled = busy || !built.ok || offline;
  el("export-go").textContent = busy ? "Hazırlanıyor…"
    : exportRun.phase === "error" ? "Tekrar dene" : "Dışa aktar";
  el("export-status").hidden = !busy;
  el("export-bar").hidden = !busy;
  el("export-result").hidden = !done;
  if (busy) exportRenderStatusText();
  if (done) exportRenderResult();
}

function exportRenderStatusText() {
  const elapsed = formatElapsed(Date.now() - exportRun.startedAt);
  const duration = currentSong ? Number(currentSong.duration) : 0;
  el("export-status-text").textContent = exportRun.step === "starting"
    ? "Sunucuya gönderiliyor…"
    : `Sunucuda hazırlanıyor… ${elapsed}. ${waitHint(duration)}`;
}

function exportRenderResult() {
  const result = exportRun.result;
  if (!result) return;
  const extras = [formatExportBytes(result.bytes), result.duration ? formatTime(result.duration) : ""]
    .filter(Boolean).join(" · ");
  const file = el("export-file");
  file.textContent = result.filename || "";
  if (extras) {
    const small = document.createElement("small");
    small.textContent = extras;
    file.append(small);
  }
  const share = el("export-share");
  share.hidden = exportRun.shareState === "none";
  share.disabled = exportRun.shareState !== "ready";
  share.textContent = exportRun.shareState === "preparing" ? "Paylaş (hazırlanıyor…)" : "Paylaş";
}

function exportReset() {
  exportRun.gen += 1;               // süren yoklama/hazırlık bayatlar
  exportRun = { ...exportRun, phase: "idle", specKey: null, result: null, file: null,
    shareState: "none", message: "", messageKind: "error" };
  clearInterval(exportTicker);
  exportTicker = 0;
}

// Düğme: şarkı açık, kanallar var, internet var.
function refreshExportAvailability() {
  const chip = el("export-open");
  if (!chip) return;
  const ready = Boolean(currentSong) && engine.channels.size > 0;
  const offline = isOffline();
  chip.disabled = !ready || offline;
  chip.title = offline ? "İnternet yok" : "";
  if (!el("export-sheet").hidden) exportRefreshForm();
}

function openExport() {
  if (!currentSong || el("export-open").disabled) return;
  if (exportRun.songId !== currentSong.id) {
    exportReset();
    exportRun.songId = currentSong.id;
  }
  if (exportRun.phase === "idle") {
    el("export-tempo").checked = false;       // varsayılan: orijinal hız ve ton
    el("export-region").checked = false;
  }
  exportRefreshForm();
  el("export-sheet").hidden = false;
  pushLayer("export");
  el("export-close").focus();
}

function closeExportDom() {
  el("export-sheet").hidden = true;
}

async function startExportJob() {
  if (!currentSong || exportWorking()) return;
  const input = exportInputs();
  const built = buildExportRequest(input);
  if (!built.ok) {
    exportSetMessage(built.problem, "warn");
    exportRefreshForm();
    return;
  }
  if (isOffline()) {
    exportRefreshForm();           // çevrimdışı uyarısını form kendisi yazıyor
    return;
  }
  exportReset();
  const gen = exportRun.gen;
  const songId = currentSong.id;
  Object.assign(exportRun, {
    phase: "working", songId, specKey: JSON.stringify(built.body), startedAt: Date.now(), step: "starting",
  });
  exportTicker = setInterval(() => { if (exportWorking()) exportRenderStatusText(); }, 1000);
  exportRefreshForm();
  const stale = () => gen !== exportRun.gen;
  try {
    const result = await runExport({
      api, songId, body: built.body, isCancelled: stale,
      onUpdate: (update) => { exportRun.step = update.phase; },
    });
    if (result.cancelled || stale()) return;
    clearInterval(exportTicker);
    exportTicker = 0;
    Object.assign(exportRun, { phase: "done", result, message: "" });
    exportRefreshForm();
    prepareExportShare(result, gen, songId);
  } catch (error) {
    if (stale()) return;
    clearInterval(exportTicker);
    exportTicker = 0;
    exportSetMessage(exportErrorMessage(error));
    exportRun.phase = "error";
    exportRefreshForm();
  }
}

async function exportDownloadUrl(result) {
  const link = await api.exportLink(exportRun.songId, result.hash);
  return link.url;
}

// <a download>: blob bellekteyse ağsız da iner; yoksa imzalı bağlantı (Content-Disposition zorluyor).
async function downloadExport() {
  const result = exportRun.result;
  if (!result) return;
  const gen = exportRun.gen;
  let href = "";
  let revoke = false;
  try {
    if (exportRun.file) {
      href = URL.createObjectURL(exportRun.file);
      revoke = true;
    } else {
      if (!requireOnline(el("export-message"), "indirmek")) return;
      href = await exportDownloadUrl(result);
      if (gen !== exportRun.gen) return;
    }
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = result.filename || "miks";
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 60000);
    showMessage(el("export-message"), "İndiriliyor. Dosya indirilenler klasörüne düşer.", "ok");
  } catch (error) {
    showMessage(el("export-message"), exportErrorMessage(error));
  }
}

// Paylaş yalnız navigator.canShare varsa. Paylaşım DOKUNUŞ ANINDA açılmalı (kullanıcı
// etkinliği birkaç saniye geçerli), indirme o sırada yapılamaz: dosya bitince ARKADA
// belleğe alınıyor, hazır olunca düğme açılıyor.
async function prepareExportShare(result, gen, songId) {
  if (!shareSupported()) return;
  exportRun.shareState = "preparing";
  exportRenderResult();
  try {
    const url = await exportDownloadUrl(result);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (gen !== exportRun.gen) return;
    const file = new File([blob], result.filename || "miks", { type: mimeFor(result.format) });
    if (!navigator.canShare({ files: [file] })) {
      exportRun.shareState = "none";
    } else {
      exportRun.file = file;
      exportRun.shareState = "ready";
    }
  } catch (error) {
    if (gen !== exportRun.gen) return;
    console.info("[export] paylaşıma hazırlanamadı:", error);
    exportRun.shareState = "none";            // İndir yine çalışır
  }
  if (exportRun.songId === songId) exportRenderResult();
}

async function shareExport() {
  if (!exportRun.file || exportRun.shareState !== "ready") return;
  try {
    await navigator.share({ files: [exportRun.file], title: exportRun.result.filename });
  } catch (error) {
    if (error && error.name === "AbortError") return;      // kullanıcı vazgeçti
    showMessage(el("export-message"), "Paylaşım açılamadı. İndir düğmesini dene.");
  }
}

on("export-open", "click", openExport);
on("export-close", "click", () => requestBack("export"));
on("export-backdrop", "click", () => requestBack("export"));
on("export-go", "click", startExportJob);
on("export-download", "click", downloadExport);
on("export-share", "click", shareExport);
for (const id of ["export-tempo", "export-region"]) on(id, "change", exportRefreshForm);
for (const radio of document.querySelectorAll('input[name="export-format"]')) {
  radio.addEventListener("change", exportRefreshForm);
}

// -------------------------------------------- tam ekran sözler (Aşama 13)
// Mantık: lyricsscreen.js (ekran), beatpulse.js (vuruş), lyrics.js (satır bulma: panelle
// AYNI işlevler). Burada yalnız bağlama. Arka plan seçimi TÜM şarkılar için tek ayar
// (settings.lyricsBg); kendi dosyan yalnız cihazda (bgstore.js, IndexedDB).

let kickState = { id: null, tag: null, times: null };
let bgInfo = null;                 // {name, size, kind} ya da null (kayıtlı özel dosya)
let bgMediaGen = 0;
let bgNote = { text: "", warn: false };

function kickTag() {
  return String(subTag("drums"));
}

function kickStorage() {
  return lyricsStorage();
}

function currentBeats() {
  const kicks = currentSong && kickState.id === currentSong.id && kickState.tag === kickTag()
    ? kickState.times : null;
  return pickBeats({ kicks, grid: loopGrid });
}

// Kick vuruşları bir kez çıkarılır ve şarkıya kaydedilir; davul grubu kapalıyken de çalışsın.
async function extractKicks(songId, tag) {
  try {
    let buffer = null;
    const channel = engine.channels.get("kick");
    if (channel && channel.buffer) {
      buffer = channel.buffer;
    } else {
      const status = subStatus("drums");
      if (!status || status.state !== "done") return null;
      const raw = await stemCache.get(songId, "kick", subTag("drums"));
      if (!raw) return null;
      buffer = await engine.decode(raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));      // ses motoruna nefes
    const times = onsetsFromBuffer(buffer);
    const storage = kickStorage();
    if (times.length && storage) writeKicks(storage, songId, tag, times);
    return times.length ? times : null;
  } catch (error) {
    console.info("[kick] vuruşlar çıkarılamadı:", error);
    return null;
  }
}

async function ensureKicks() {
  if (!currentSong) return;
  const songId = currentSong.id;
  const tag = kickTag();
  if (kickState.id === songId && kickState.tag === tag && kickState.times) return;
  const storage = kickStorage();
  let times = storage ? readKicks(storage, songId, tag) : null;
  if (!times) times = await extractKicks(songId, tag);
  if (!times || !currentSong || currentSong.id !== songId) return;
  kickState = { id: songId, tag, times };
  if (lyricsScreen && lyricsScreen.isOpen) lyricsScreen.setBeats(currentBeats());
}

async function loadScreenMedia() {
  const gen = ++bgMediaGen;
  const record = await getBackground();
  if (gen !== bgMediaGen || !lyricsScreen.isOpen || settings.lyricsBg !== "custom" || !record) return;
  const { kind } = classifyBackground(record.blob);
  if (!kind) return;
  const url = URL.createObjectURL(record.blob);
  lyricsScreen.setMedia({ kind, url, revoke: () => URL.revokeObjectURL(url) });
}

function openLyricsScreen() {
  if (!lyricsDoc || !currentSong || lyricsScreen.isOpen) return;
  const mode = normalizeBg(settings.lyricsBg);
  lyricsScreen.open({
    lines: lyricsDoc.lines, lang: lyricsDoc.language, title: currentSong.title || "", mode,
    subs: currentSubs(), rows: normalizeRows(settings.lyricsRows),
    beats: currentBeats(), playing: engine.playing, time: engine.visualTime,
  });
  pushLayer("lyrics-full");
  if (mode === "custom") loadScreenMedia();
  if (wantsPulse(mode)) ensureKicks();
}

async function seekFromScreen(index) {
  const line = lyricsDoc && lyricsDoc.lines[index];
  if (!line || !(engine.duration > 0)) return;
  await engine.seek(Math.min(line.t, engine.duration));
  metronome.resync();
  lyricsScreen.tick(engine.visualTime, true);
}

// ---- arka plan seçici (ekrandaki ⚙ paneli ve Ayarlar aynı kodu kullanır)

const bgChoosers = [];
const rowSelects = [];

// "Görünen satır": üstte ve altta kaç satır (1-5). Ekran açıkken hemen uygulanır.
function buildRowsControl(container) {
  const label = document.createElement("label");
  label.className = "bg-opt";
  const text = document.createElement("span");
  text.textContent = "Görünen satır (üstte ve altta)";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Görünen satır sayısı");
  for (let n = ROWS_MIN; n <= ROWS_MAX; n += 1) {
    const option = document.createElement("option");
    option.value = String(n);
    option.textContent = String(n);
    select.append(option);
  }
  select.addEventListener("change", () => setLyricsRows(select.value));
  label.append(text, select);
  container.append(label);
  rowSelects.push(select);
}

function setLyricsRows(value) {
  settings = saveSettings({ lyricsRows: normalizeRows(value) });
  refreshBgChoosers();
  if (lyricsScreen && lyricsScreen.isOpen) lyricsScreen.setRows(settings.lyricsRows);
}

function bgMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function buildBgChooser(container, name) {
  const radios = new Map();
  for (const mode of BG_MODES) {
    const label = document.createElement("label");
    label.className = "bg-opt";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = mode;
    input.addEventListener("change", () => onBgChoice(mode));
    const text = document.createElement("span");
    text.textContent = BG_LABELS[mode];
    label.append(input, text);
    container.append(label);
    radios.set(mode, input);
  }
  const actions = document.createElement("div");
  actions.className = "bg-actions";
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "chip";
  pick.textContent = "Dosya seç";
  pick.addEventListener("click", () => el("bg-file").click());
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "chip";
  remove.textContent = "Kaldır";
  remove.addEventListener("click", removeBgFile);
  actions.append(pick, remove);
  const note = document.createElement("small");
  note.className = "bg-note";
  container.append(actions, note);
  bgChoosers.push({ radios, remove, note });
}

function refreshBgChoosers() {
  const mode = normalizeBg(settings.lyricsBg);
  for (const select of rowSelects) select.value = String(normalizeRows(settings.lyricsRows));
  for (const chooser of bgChoosers) {
    for (const [value, input] of chooser.radios) input.checked = value === mode;
    chooser.remove.disabled = !bgInfo;
    const fileText = bgInfo ? `${bgInfo.name} (${bgMb(bgInfo.size)})` : "Dosya seçilmedi";
    chooser.note.textContent = bgNote.text || (mode === "custom" || bgInfo ? fileText : "");
    chooser.note.classList.toggle("warn", bgNote.warn);
  }
}

function setLyricsBg(mode) {
  settings = saveSettings({ lyricsBg: mode });
  bgNote = { text: "", warn: false };
  refreshBgChoosers();
  if (!lyricsScreen || !lyricsScreen.isOpen) return;
  lyricsScreen.setMode(mode);
  if (mode === "custom") {
    loadScreenMedia();
  } else {
    bgMediaGen += 1;
    lyricsScreen.setMedia(null);
  }
  if (wantsPulse(mode)) {
    lyricsScreen.setBeats(currentBeats());
    ensureKicks();
  }
}

function onBgChoice(mode) {
  if (mode === "custom" && !bgInfo) {
    refreshBgChoosers();               // dosya seçilene kadar eski seçim görünür kalsın
    el("bg-file").click();
    return;
  }
  setLyricsBg(mode);
}

async function removeBgFile() {
  await clearBackground();
  bgInfo = null;
  if (normalizeBg(settings.lyricsBg) === "custom") setLyricsBg("plain");
  else refreshBgChoosers();
}

async function onBgFilePicked() {
  const input = el("bg-file");
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  const { kind, warn } = classifyBackground(file);
  if (!kind) {
    bgNote = { text: "Bir resim ya da video seç.", warn: true };
    refreshBgChoosers();
    return;
  }
  if (warn && !window.confirm(`Bu dosya büyük (${bgMb(file.size)}). Telefonda yavaşlık ya da bellek sorunu olabilir. Yine de kullanılsın mı?`)) {
    return;
  }
  const saved = await putBackground(file);
  if (!saved) {
    bgNote = { text: "Dosya telefona kaydedilemedi (yer yok olabilir).", warn: true };
    refreshBgChoosers();
    return;
  }
  bgInfo = { name: file.name, size: file.size, kind };
  setLyricsBg("custom");
}

lyricsScreen = new LyricsScreen({
  ui: {
    root: el("lyrics-full"), media: el("lf-media"), flow: el("lf-flow"), pulse: el("lf-pulse"),
    track: el("lf-track"), stage: el("lf-stage"), title: el("lf-title"),
    closeBtn: el("lf-close"), playBtn: el("lf-play"), settingsBtn: el("lf-settings"),
    followBtn: el("lf-follow"),
  },
  doc: document, win: window, rows: normalizeRows(settings.lyricsRows),
  wakeLock, keepAwake: () => engine.playing,
  reducedMotion: () => Boolean(reducedMotion && reducedMotion.matches),
  onSeek: seekFromScreen,
  onTogglePlay: togglePlayback,
  onRequestClose: () => requestBack("lyrics-full"),
  onClosed: () => {
    el("lf-panel").hidden = true;
    el("lf-settings").setAttribute("aria-expanded", "false");
    bgMediaGen += 1;
  },
  onSettings: () => {
    const panel = el("lf-panel");
    panel.hidden = !panel.hidden;
    el("lf-settings").setAttribute("aria-expanded", String(!panel.hidden));
  },
});
buildBgChooser(el("bg-chooser-screen"), "bg-mode-screen");
buildBgChooser(el("bg-chooser-settings"), "bg-mode-settings");
buildRowsControl(el("bg-chooser-screen"));
buildRowsControl(el("bg-chooser-settings"));
buildSubsControls(el("lf-subs"));
on("lyrics-translate", "click", () => startTranslation(false));
on("lyrics-add-reading", "click", () => startTranslation(true));
on("lyrics-tr-toggle", "click", () => setTrShow("tr", !trShow.tr));
on("lyrics-ro-toggle", "click", () => setTrShow("ro", !trShow.ro));
refreshBgChoosers();
getBackground().then((record) => {
  if (record) {
    bgInfo = { name: record.name, size: record.size, kind: classifyBackground(record.blob).kind };
    refreshBgChoosers();
  }
});
on("bg-file", "change", onBgFilePicked);
on("lyrics-full-open", "click", openLyricsScreen);

// ---------------------------------------- kanal ayarı ve yankı odası (Aşama 15)
// Mantık fx.js'te (saf) ve engine.js'te (şerit düğümleri). Burası yalnız sayfa ve bağlama.

const EQ_IDS = ["fx-eq0", "fx-eq1", "fx-eq2"];

function fmtDb(value) {
  if (!value) return "0 dB";
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(1).replace(".", ",")} dB`;
}

function fmtPan(percent) {
  if (!percent) return "Orta";
  return percent < 0 ? `Sol ${-percent}` : `Sağ ${percent}`;
}

function fmtSeconds(value) {
  return `${Number(value).toFixed(1).replace(".", ",")} sn`;
}

function setRoomState(room, save = true) {
  roomState = normalizeRoom(room);
  engine.setRoom(roomState);
  refreshFxSheet();
  if (save) scheduleMixSave();
}

// "Slowed + reverb" gibi ön ayarların hız/ton kısmı: plak gibi kipi + oran (tek yeniden çıpalama).
function applyTempoPreset(tempo) {
  const rate = Math.min(Math.max(Number(tempo.rate) || 1, MIN_RATE), MAX_RATE);
  const offset = originalBpm ? Math.round(originalBpm * (rate - 1)) : Math.round((rate - 1) * 100);
  tempoOffset = clampRange("tempo-range", offset);
  if (el("tempo-range")) el("tempo-range").value = String(tempoOffset);
  if (tempo.vinyl) vinylMode = true;
  return applyStretch(true);
}

function fxSheetBottom() {
  const bar = document.querySelector(".transport");
  el("fx-sheet").style.bottom = `${bar ? Math.round(bar.getBoundingClientRect().height) : 0}px`;
}

function openFxSheet(mode, name = null) {
  if (!currentSong || !engine.channels.size) return;
  if (mode === "channel" && !engine.channels.has(name)) return;
  fxMode = mode;
  fxChannel = mode === "channel" ? name : null;
  el("fx-channel").hidden = mode !== "channel";
  el("fx-room").hidden = mode !== "room";
  fxSheetBottom();
  el("fx-sheet").hidden = false;
  refreshFxSheet();
  pushLayer("fx");
}

function closeFxDom() {
  el("fx-sheet").hidden = true;
  fxChannel = null;
}

function setOut(id, text) {
  const node = el(id);
  if (node.textContent !== text) node.textContent = text;
}

function refreshFxSheet() {
  const sheet = el("fx-sheet");
  if (!sheet || sheet.hidden) return;
  if (fxMode === "room") {
    el("fx-title").textContent = "Yankı odası";
    const preset = roomPresetId(roomState);
    for (const button of el("fx-room-presets").children) {
      button.setAttribute("aria-pressed", String(button.dataset.room === preset));
    }
    el("fx-decay").value = String(roomState.decay);
    setOut("fx-decay-val", fmtSeconds(roomState.decay));
    el("fx-level").value = String(Math.round(roomState.level * 100));
    setOut("fx-level-val", `%${Math.round(roomState.level * 100)}`);
    return;
  }
  const channel = engine.channels.get(fxChannel);
  if (!channel) {
    requestBack("fx");                      // kanal kalktı (grup kapandı)
    return;
  }
  const fx = normalizeFx(channel);
  el("fx-title").textContent = `${STEM_LABELS[fxChannel] || SUB_LABELS[fxChannel] || fxChannel}${engine.isExpanded(fxChannel) ? " · tüm grup" : ""}`;
  const pan = Math.round(fx.pan * 100);
  el("fx-pan").value = String(pan);
  setOut("fx-pan-val", fmtPan(pan));
  EQ_IDS.forEach((id, i) => {
    el(id).value = String(fx.eq[i]);
    setOut(`${id}-val`, fmtDb(fx.eq[i]));
  });
  el("fx-send").value = String(Math.round(fx.send * 100));
  setOut("fx-send-val", `%${Math.round(fx.send * 100)}`);
}

function applyChannelFx(patch) {
  if (!fxChannel) return;
  engine.setChannelFx(fxChannel, patch);
  mixer.refresh();                          // nokta + kayıt
  refreshFxSheet();
}

function buildFxSheet() {
  const presets = el("fx-room-presets");
  for (const room of ROOM_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.dataset.room = room.id;
    button.textContent = room.label;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => setRoomState({ ...roomState, size: room.size, decay: room.decay }));
    presets.append(button);
  }
  el("fx-decay").min = String(DECAY_MIN);
  el("fx-decay").max = String(DECAY_MAX);
  on("fx-close", "click", () => requestBack("fx"));
  on("room-open", "click", () => openFxSheet("room"));
  on("fx-pan", "input", () => applyChannelFx({ pan: Number(el("fx-pan").value) / 100 }));
  on("fx-pan", "dblclick", () => applyChannelFx({ pan: 0 }));
  EQ_IDS.forEach((id, i) => on(id, "input", () => {
    const channel = engine.channels.get(fxChannel);
    if (!channel) return;
    const eq = [...normalizeFx(channel).eq];
    eq[i] = Number(el(id).value);
    applyChannelFx({ eq });
  }));
  on("fx-send", "input", () => applyChannelFx({ send: Number(el("fx-send").value) / 100 }));
  on("fx-channel-reset", "click", () => applyChannelFx(neutralFx()));
  on("fx-decay", "input", () => setRoomState({ ...roomState, decay: Number(el("fx-decay").value) }));
  on("fx-level", "input", () => setRoomState({ ...roomState, level: Number(el("fx-level").value) / 100 }));
  on("fx-room-reset", "click", () => setRoomState(DEFAULT_ROOM));
  mixer.onFx = (name) => openFxSheet("channel", name);
}

// ------------------------------------------------ alt parçalar (Aşama 10)
// İki grup: vokal (lead/backing) ve davul (kick/snare/tom/hi-hat/zil). Her ana
// kanalın altında KENDİ "Alt parçaları ayır" düğmesi / durumu / açma oku var.
// Açınca ana kanalın tamponu bellekten bırakılır, alt kanallar çalar (seek gibi
// kısa yeniden başlatma, canlı tampon değişimi YOK). AYNI ANDA TEK ana kanal
// açık: davulu açınca vokal grubu kapanır (ve tersi), TEK yeniden başlatmayla.
// Mantık sub.js'te.

const SUB_POLL_MS = 4000;
let subPollTimer = 0;
const subStarting = new Set();   // "ayır" isteği giden gruplar
let subBusy = false;             // açma/kapama sürüyor
let currentStemTag = 0;          // ana stem önbellek etiketi (kapatırken ana tampon geri gelsin)

function subStatus(group) {
  return currentSong && currentSong.status ? subOf(currentSong.status, group) : undefined;
}

function subTag(group) {
  return cacheTag(subVersion(subStatus(group)), "sub");
}

function subExpanded(group) {
  return engine.isExpanded(group);       // ana kanal adı = grup adı
}

function openGroup() {
  return GROUP_ORDER.find((group) => engine.isExpanded(group)) || null;
}

function subCached(group) {
  return Boolean(currentSong)
    && stemCache.indexHas(currentSong.id, subNames(group), subTag(group));
}

// Uzun şarkı eşiği GRUP BAŞINA (davul 5 alt kanal, vokal 2; başka bir grup açıksa
// geçişte o da bellekte): bkz. sub.js::groupThresholdSec.
function groupThreshold(group) {
  const open = openGroup();
  const nOpen = open && open !== group ? SUB_GROUPS[open].length : 0;
  return groupThresholdSec(longSongThresholdSec(), nOpen, SUB_GROUPS[group].length);
}

function subViewNow(group) {
  return subView({
    group,
    sub: subStatus(group),
    duration: engine.duration || Number(currentSong && currentSong.duration) || 0,
    mobile: isMobile(),
    thresholdSec: groupThreshold(group),
    offline: isOffline(),
    cached: subCached(group),
    expanded: subExpanded(group),
    busy: subBusy,
    starting: subStarting.has(group),
  });
}

// Ön ayar için: grubun alt parçaları kullanılabilir mi?
function subUsable(group) {
  if (!currentSong || !engine.channels.has(group)) return false;
  if (subExpanded(group)) return true;
  const view = subViewNow(group);
  return view.kind === "ready" && view.canExpand && !view.disabled;
}

function refreshSubUi() {
  for (const group of GROUP_ORDER) {
    if (!currentSong || !engine.channels.has(group)) {
      mixer.setGroupControl(group, null);
      continue;
    }
    const view = subViewNow(group);
    mixer.setGroupControl(group, {
      ...view,
      text: subBusy && view.kind !== "none" ? "Yükleniyor…" : view.text,
      onButton: () => startSubSeparation(group),
      onToggle: () => toggleSubExpand(group),
    });
  }
  updatePresetButtons([...engine.channels.keys()]);
  refreshExportAvailability();
}

// Sunucu (taze) durum "söz dosyası yok" diyorsa cihazdaki kopya bayattır: silinir.
function syncLyricsCache(detail) {
  const status = detail && detail.status;
  if (!status || !status.id) return;
  const lyr = lyricsOf(status);
  const hasFile = Boolean(lyr && (lyr.state === "done" || (lyr.previous && lyr.previous.state === "done")));
  const storage = lyricsStorage();
  if (!hasFile && storage && !(lyr && lyr.state === "running")) {
    dropLyricsCache(storage, [status.id]);
    TR.dropCache(storage, [status.id]);
  }
}

function adoptDetail(detail) {
  if (!currentSong || !detail || !detail.status || detail.status.id !== currentSong.id) return;
  syncLyricsCache(detail);
  currentSong = { ...currentSong, ...detail };
  writeMeta(currentSong.id, detail);     // çevrimdışı açılışta da alt parça bilgisi dursun
}

async function startSubSeparation(group) {
  if (!currentSong || subStarting.has(group)) return;
  if (!requireOnline(el("player-message"), "Alt parçaları ayırmak")) return;
  const songId = currentSong.id;
  subStarting.add(group);
  refreshSubUi();
  try {
    await api.startSub(songId, group);
    const detail = await api.getSong(songId);       // status.sub*'ın tamamı
    if (currentSong && currentSong.id === songId) adoptDetail(detail);
  } catch (error) {
    showMessage(el("player-message"), describeError(error));
  } finally {
    subStarting.delete(group);
    refreshSubUi();
    ensureSubPolling();
  }
}

function stopSubPolling() {
  clearInterval(subPollTimer);
  subPollTimer = 0;
}

function anySubRunning() {
  return GROUP_ORDER.some((group) => isRunning(subStatus(group)));
}

// Sürerken 4 sn'de bir durum (iki grup için TEK yoklama); bitince durur. Şarkı
// değişirse / kapanırsa durur.
function ensureSubPolling() {
  if (subPollTimer || !currentSong || !anySubRunning()) return;
  const songId = currentSong.id;
  subPollTimer = setInterval(async () => {
    if (!currentSong || currentSong.id !== songId) {
      stopSubPolling();
      return;
    }
    const before = new Set(GROUP_ORDER.filter((group) => isRunning(subStatus(group))));
    try {
      adoptDetail(await api.getSong(songId));
    } catch {
      return;                       // geçici ağ hatası: bir sonraki turda tekrar
    }
    if (!anySubRunning()) stopSubPolling();
    refreshSubUi();
    for (const group of before) {
      const sub = subStatus(group);
      if (!isRunning(sub) && sub && sub.state === "done") prefetchSubStems(group);
    }
  }, SUB_POLL_MS);
}

// Bitince alt parçalar sessizce cihaza iniyor: çevrimdışıyken de açılabilsin.
async function prefetchSubStems(group) {
  if (!currentSong || isOffline()) return;
  const songId = currentSong.id;
  const tag = subTag(group);
  for (const name of subNames(group)) {
    try {
      if (await stemCache.get(songId, name, tag)) continue;
      const buffer = await api.subStemBuffer(songId, name);
      await stemCache.put(songId, name, buffer, tag);
    } catch {
      return;                       // sonra açılırken zaten indirilir
    }
  }
  if (currentSong && currentSong.id === songId) refreshSubUi();
}

async function subStemBuffer(group, name) {
  const songId = currentSong.id;
  const tag = subTag(group);
  let buffer = await stemCache.get(songId, name, tag);
  if (!buffer) {
    buffer = await api.subStemBuffer(songId, name);
    await stemCache.put(songId, name, buffer.slice(0), tag);
  }
  return buffer;
}

async function parentStemBuffer(parent) {
  const songId = currentSong.id;
  let buffer = await stemCache.get(songId, parent, currentStemTag);
  if (!buffer) {
    buffer = await api.stemBuffer(songId, parent);
    await stemCache.put(songId, parent, buffer.slice(0), currentStemTag);
  }
  return buffer;
}

// Kanal yapısı değişti (açıldı/kapandı): satırları yeniden kur. Yeniden kurma
// kayıt tetiklemesin (alt kanallar varsayılanla yazılırdı); kayıtlı alt kanal
// ayarları açılışta uygulanıyor.
function rebuildMixer() {
  const keep = mixSongId;
  mixSongId = null;
  const names = [...engine.channels.keys()];
  const groups = new Map();
  for (const group of GROUP_ORDER) {
    if (engine.isExpanded(group)) groups.set(group, SUB_GROUPS[group].filter((n) => names.includes(n)));
  }
  mixer.render(names, groups);
  if (currentSong && keep) {
    const storage = mixStorage();
    const record = storage ? readMix(storage, currentSong.id) : null;
    const plan = planRestore(record, names);
    const subNamesAll = new Set(Object.values(SUB_GROUPS).flat());
    const only = new Map([...plan].filter(([name]) => subNamesAll.has(name)));
    if (only.size) engine.applyMix(only);
  }
  mixer.syncFromEngine();
  mixSongId = keep;
  refreshSubUi();
}

async function expandSub(group) {
  if (!currentSong || subBusy || subExpanded(group)) return;
  const view = subViewNow(group);
  if (view.kind !== "ready" || !view.canExpand) return;
  subBusy = true;
  refreshSubUi();
  try {
    // Sırayla: her çözme geçici ek bellek açıyor (telefon).
    const buffers = new Map();
    for (const name of SUB_GROUPS[group]) {
      buffers.set(name, await engine.decode(await subStemBuffer(group, name)));
    }
    // Başka bir grup açıksa o KAPANIR (tek ana kanal açık): ana tamponu da çözülür
    // ve ikisi TEK yeniden başlatmada değişir.
    const other = openGroup();
    const collapse = other
      ? { parent: other, buffer: await engine.decode(await parentStemBuffer(other)) }
      : null;
    await engine.regroup({ collapse, expand: { parent: group, buffers } });
    metronome.resync();
  } catch (error) {
    showMessage(el("player-message"), `Alt parçalar açılamadı: ${describeError(error)}`);
  } finally {
    subBusy = false;
    rebuildMixer();
    if (group === "drums" && subExpanded("drums")) ensureKicks();   // kick tamponu şimdi elde
  }
}

async function collapseSub(group) {
  if (!currentSong || subBusy || !subExpanded(group)) return;
  subBusy = true;
  refreshSubUi();
  try {
    const buffer = await engine.decode(await parentStemBuffer(group));
    await engine.collapseChannel(group, buffer);
    metronome.resync();
  } catch (error) {
    showMessage(el("player-message"), `Alt parçalar kapatılamadı: ${describeError(error)}`);
  } finally {
    subBusy = false;
    rebuildMixer();
  }
}

async function toggleSubExpand(group) {
  if (subExpanded(group)) await collapseSub(group);
  else await expandSub(group);
}

// ----------------------------------------------------- A-B döngü (Madde 1)
// Mantık loop.js'te, ses motorda (native döngü + dikiş çukuru). Burası yalnız
// işaretleri tutuyor ve motora iletiyor. Uçlar vuruşa (ya da ölçü başına)
// yapışır; ızgara telafisi YOK (PLAN.md Madde 9). Izgarasız şarkıda yapışma
// kapalı, uçlar serbest saniye.

let loopA = null;
let loopB = null;
let loopOn = false;
let loopGrid = null;        // {beats, downbeats} ya da null
let loopSnap = "beat";      // "beat" | "bar"
let loopNoticeTimer = 0;

function setLoopGrid(chords) {
  const beats = chords && chords.beats ? chords.beats.map(Number).filter(Number.isFinite) : [];
  const downbeats = chords && chords.downbeats
    ? chords.downbeats.map(Number).filter(Number.isFinite) : [];
  loopGrid = beats.length >= 2 ? { beats, downbeats } : null;
  if (!hasBars(loopGrid)) loopSnap = "beat";
  refreshLoopUi();
}

function resetLoopState() {
  loopA = null;
  loopB = null;
  loopOn = false;
  loopGrid = null;
  clearTimeout(loopNoticeTimer);
  refreshLoopUi();
}

function loopNotice(text) {
  const node = el("player-message");
  showMessage(node, text, "warn");
  clearTimeout(loopNoticeTimer);
  loopNoticeTimer = setTimeout(() => {
    if (node.textContent === text) hideMessage(node);
  }, 3500);
}

function formatPoint(t) {
  const minutes = Math.floor(t / 60);
  const seconds = (t - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

function snapTime(t) {
  return snapPoint(loopGrid, t, loopGrid ? loopSnap : "free");
}

function refreshLoopUi() {
  if (!el("loop-bar")) return;
  const ready = engine.channels.size > 0;
  const full = loopA !== null && loopB !== null;
  el("loop-a").disabled = !ready;
  el("loop-b").disabled = !ready;
  el("loop-toggle").disabled = !ready || !full;
  el("loop-toggle").setAttribute("aria-pressed", String(loopOn && full));
  el("loop-snap").disabled = !ready || !hasBars(loopGrid);
  el("loop-snap").textContent = !loopGrid ? "Yapış: yok"
    : loopSnap === "bar" ? "Yapış: ölçü" : "Yapış: vuruş";
  for (const button of el("loop-bars").children) {
    button.disabled = !ready || !hasBars(loopGrid);
  }
  el("loop-clear").disabled = !ready || (loopA === null && loopB === null);
  el("loop-range").textContent =
    `A ${loopA === null ? "—" : formatPoint(loopA)} · B ${loopB === null ? "—" : formatPoint(loopB)}`;
  layoutHandles();
}

// ---- seek çubuğundaki tutamaçlar
// Konum: range thumb'ı 13 px, merkezi [6.5, W-6.5] arasında gezer.
const THUMB = 13;

function layoutHandles() {
  const duration = engine.duration;
  const on = loopOn && loopA !== null && loopB !== null;
  for (const [which, t] of [["a", loopA], ["b", loopB]]) {
    const handle = el(`loop-handle-${which}`);
    handle.hidden = t === null || !(duration > 0);
    if (handle.hidden) continue;
    handle.style.left = `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${t / duration})`;
    handle.classList.toggle("off", !on);
    handle.setAttribute("aria-valuetext", formatPoint(t));
  }
  const region = el("loop-region");
  region.hidden = loopA === null || loopB === null || !(duration > 0);
  if (!region.hidden) {
    region.style.left = `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${loopA / duration})`;
    region.style.width = `calc((100% - ${THUMB}px) * ${(loopB - loopA) / duration})`;
    region.classList.toggle("off", !on);
  }
}

function saveLoopPoints() {
  const storage = mixStorage();
  if (!storage || !mixSongId) return;
  writeLoop(storage, mixSongId, loopA !== null && loopB !== null ? { a: loopA, b: loopB } : null);
}

// Sürükleme: uç yapışma kipine yapışır; bırakınca motora iletilir (döngü
// çalıyorsa ve konum dışarıda kaldıysa motor A'ya alır). Tutamaç seek çubuğunun
// ÜSTÜNDE ayrı bir eleman ve olayı yuttuğu için seek tetiklenmez.
function bindHandle(which) {
  const handle = el(`loop-handle-${which}`);
  let dragging = false;
  let grab = 0;
  const pointX = () => {
    const rect = el("seek").getBoundingClientRect();
    const t = which === "a" ? loopA : loopB;
    return rect.left + THUMB / 2 + (rect.width - THUMB) * (t / engine.duration);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (!(engine.duration > 0)) return;
    dragging = true;
    grab = event.clientX - pointX();     // tutamacın gövdesine bastık, noktaya değil
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("drag");
    event.preventDefault();
    event.stopPropagation();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = el("seek").getBoundingClientRect();
    const fraction = (event.clientX - grab - rect.left - THUMB / 2) / (rect.width - THUMB);
    const time = Math.min(Math.max(fraction, 0), 1) * engine.duration;
    const other = which === "a" ? loopB : loopA;
    const point = dragPoint(which, time, other, loopGrid, loopGrid ? loopSnap : "free", engine.duration);
    if (point === null) return;
    if (which === "a") loopA = point;
    else loopB = point;
    refreshLoopUi();
  });
  const finish = async (event) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("drag");
    try { handle.releasePointerCapture(event.pointerId); } catch { /* bırakılmıştı */ }
    await applyLoop();
    saveLoopPoints();
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

// İşaretleri motora iletir. Konum döngü dışındaysa motor A'ya alır.
async function applyLoop() {
  if (loopOn && loopA !== null && loopB !== null) {
    const result = await engine.setLoop(loopA, loopB);
    if (result === null) {
      loopOn = false;
      loopNotice("Döngü çok kısa.");
    }
  } else {
    engine.clearLoop();
  }
  refreshLoopUi();
}

function buildLoopButtons() {
  for (const bars of BAR_CHOICES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = String(bars);
    button.setAttribute("aria-label", `${bars} ölçü`);
    button.addEventListener("click", async () => {
      // A işaretliyse oradan, değilse çalan konumdan; en yakın ölçü başına yapışır.
      const from = loopA !== null ? loopA : engine.visualTime;
      const found = barLoop(loopGrid, from, bars, engine.duration);
      if (!found) {
        loopNotice("Bu şarkıda ölçü bilgisi yok.");
        return;
      }
      loopA = found.a;
      loopB = found.b;
      loopOn = true;
      await applyLoop();
      saveLoopPoints();
      if (found.clipped) loopNotice("Döngü şarkı sonuna kırpıldı.");
    });
    el("loop-bars").append(button);
  }
}

on("loop-a", "click", async () => {
  loopA = snapTime(engine.visualTime);
  if (loopB !== null && loopB - loopA < minLoopLength(loopGrid)) {
    loopB = null;
    loopOn = false;
  }
  await applyLoop();
  saveLoopPoints();
});

on("loop-b", "click", async () => {
  if (loopA === null) {
    loopNotice("Önce A'yı işaretle.");
    return;
  }
  const point = snapTime(engine.visualTime);
  if (point - loopA < 0.75 * minLoopLength(loopGrid)) {
    loopNotice("B, A'dan en az bir vuruş sonra olmalı.");
    return;
  }
  loopB = point;
  loopOn = true;      // B işaretlenince döngü başlar
  await applyLoop();
  saveLoopPoints();
});

on("loop-clear", "click", async () => {
  loopA = null;
  loopB = null;
  loopOn = false;
  await applyLoop();
  saveLoopPoints();        // uçlar silinince kayıttaki alan da silinir
});

on("loop-toggle", "click", async () => {
  if (loopA === null || loopB === null) {
    loopNotice("Önce A ve B'yi işaretle.");
    return;
  }
  loopOn = !loopOn;
  await applyLoop();
});

bindHandle("a");
bindHandle("b");
window.addEventListener("resize", layoutHandles);

on("loop-snap", "click", () => {
  loopSnap = loopSnap === "bar" ? "beat" : "bar";
  refreshLoopUi();
});

// ---------------------------------------------------------------- şarkı sözleri (Aşama 11)
//
// Bölüm akor şeridinin altında. Sözler yoksa "Sözleri çıkar" (dil seçici) ve "Sözleri
// yapıştır"; varsa satır listesi (o anki satır vurgulu), "Düzenle" (kaydedince
// pasted olarak yeniden hizalanır, ezmeden önce onay). Zaman engine.visualTime
// (ŞARKI saati): hız değişimi ve A-B döngüyle uyumlu. Satıra dokunmak seek eder
// (döngü kuralları engine.seek'te), uzun basmak satırı A-B döngüye alır. Yalnız
// satır düzeyi vurgu. Mantık lyrics.js'te (saf, node testli).

const LYRICS_POLL_MS = 4000;
const LYRICS_COLLAPSE_KEY = "stem-mikser.lyrics.collapsed";
const LYRICS_PRESS_MS = 520;
const PRESS_SLOP_PX = 10;
const SCROLL_GUARD_MS = 1200;

let lyricsDoc = null;             // normalizeDoc çıktısı (cihazdaki ya da sunucudan gelen)
let lyricsStarting = false;       // istek gidiyor
let lyricsPollTimer = 0;
let lyricsIndex = -2;             // son boyanan satır (-2: hiç boyanmadı)
let lyricsFollow = true;          // otomatik kaydırma
let lyricsScrollGuard = 0;        // programatik kaydırmanın ürettiği scroll olaylarını yut
let lyricsEditing = false;
let lyricsFixing = false;         // "Zamanı düzelt" kipi: dokunma = bu satır ŞİMDİ başlıyor
let lyricsFixBusy = false;
let lyricsLoadGen = 0;            // eski yüklemelerin cevabı yeni şarkıyı ezmesin
const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

function lyricsStorage() {
  try { return localStorage; } catch { return null; }
}

function lyricsStatus() {
  return currentSong && currentSong.status ? lyricsOf(currentSong.status) : undefined;
}

function lyricsCollapsed() {
  const storage = lyricsStorage();
  try { return Boolean(storage && storage.getItem(LYRICS_COLLAPSE_KEY) === "1"); } catch { return false; }
}

function buildLyricsLangOptions() {
  for (const id of ["lyrics-lang", "lyrics-edit-lang"]) {
    const select = el(id);
    if (!select || select.options.length) continue;
    for (const [value, label] of LANG_CHOICES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
  }
}

function lyricsSourceText(doc) {
  const source = doc.source === "pasted" ? "yapıştırılan metin" : "otomatik";
  const lang = LANG_CHOICES.find(([value]) => value === doc.language);
  return `${doc.lines.length} satır · ${source}${lang ? ` · ${lang[1]}` : ""}`;
}

function refreshLyricsUi() {
  const root = el("lyrics");
  if (!root) return;
  if (!currentSong) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const view = sectionView({
    status: currentSong.status,
    hasDoc: Boolean(lyricsDoc),
    duration: engine.duration || Number(currentSong.duration) || 0,
    offline: isOffline(),
    starting: lyricsStarting,
  });
  let status = view.text;
  if (view.kind === "none") status = `Sözler yok · ${view.estimate}`;
  else if (view.kind === "ready" && lyricsDoc) status = lyricsSourceText(lyricsDoc);
  else if (view.kind === "ready") status = "Sözler hazır";
  if (view.hint) status = `${status} · ${view.hint}`;
  el("lyrics-status").textContent = status;

  const editing = lyricsEditing;
  const show = (id, on) => { el(id).hidden = !on || editing; };
  const off = view.disabled || lyricsStarting;
  show("lyrics-extract", view.canExtract);
  show("lyrics-lang", view.canExtract);
  show("lyrics-paste", view.canPaste);
  show("lyrics-edit", view.canEdit);
  show("lyrics-realign", view.canRealign);
  show("lyrics-fix", view.canFix);
  show("lyrics-full-open", Boolean(lyricsDoc));      // sözü olmayan şarkıda görünmez
  refreshTranslateUi();
  for (const id of ["lyrics-extract", "lyrics-lang", "lyrics-paste", "lyrics-edit", "lyrics-realign", "lyrics-fix"]) {
    el(id).disabled = off;
  }
  el("lyrics-full-open").disabled = false;           // tam ekran çevrimdışı da açılır (sözler cihazda)
  if (!view.canFix) lyricsFixing = false;
  el("lyrics-fix").setAttribute("aria-pressed", String(lyricsFixing));
  el("lyrics-list").classList.toggle("fixing", lyricsFixing);
  const notices = el("lyrics-notices");
  notices.textContent = "";
  const shown = lyricsFixing
    ? [...view.notices, { tone: "info", text: "Zamanı düzelt açık: çalarken bir satır başlayınca ona dokun, başlangıcı o an olur" }]
    : view.notices;
  for (const item of shown) {
    const span = document.createElement("span");
    span.className = `notice ${item.tone === "info" ? "info" : ""}`.trim();
    span.textContent = item.text;
    notices.append(span);
  }

  const collapsed = lyricsCollapsed();
  el("lyrics-toggle").setAttribute("aria-expanded", String(!collapsed));
  el("lyrics-editor").hidden = !editing;
  el("lyrics-body").hidden = collapsed || editing || !lyricsDoc;
  el("lyrics-follow").hidden = lyricsFollow || el("lyrics-body").hidden;
}

function renderLyricsList() {
  const list = el("lyrics-list");
  list.textContent = "";
  lyricsIndex = -2;
  lyricsFollow = true;
  if (!lyricsDoc) {
    list.removeAttribute("lang");
    return;
  }
  if (lyricsDoc.language) list.lang = lyricsDoc.language;
  else list.removeAttribute("lang");
  const fragment = document.createDocumentFragment();
  lyricsDoc.lines.forEach((line, index) => {
    const item = document.createElement("li");
    item.className = "lyric-line" + (line.c === 0 ? " low" : "") + (line.m ? " manual" : "");
    item.dataset.i = String(index);
    const main = document.createElement("span");
    main.className = "lyric-main";
    main.textContent = line.text;
    const ro = document.createElement("span");
    ro.className = "lyric-sub lyric-ro";
    ro.hidden = true;
    const tr = document.createElement("span");
    tr.className = "lyric-sub lyric-tr";
    tr.hidden = true;
    item.append(main, ro, tr);
    fragment.append(item);
  });
  list.append(fragment);
  list.scrollTop = 0;
  refreshLyricSubs(false);
  if (lyricsScreen && lyricsScreen.isOpen) {
    lyricsScreen.setLines(lyricsDoc ? lyricsDoc.lines : [], lyricsDoc ? lyricsDoc.language : null, currentSubs());
  }
}

// ---- söz çevirisi (Aşama 14): alt satırlar, "Çevir/Güncelle", tercihler. Mantık translation.js'te.
// Çeviri satır METNİNE göre tutulur (trMap), indekse değil: yeniden hizalama/yapıştırma sonrası da doğru satırda.


function trLang() {
  return lyricsDoc ? lyricsDoc.language : null;
}

function currentSubs() {
  return lyricsDoc ? TR.subsList(lyricsDoc.lines, trMap, trShow, trLang()) : [];
}

// Panelde satırların alt yazılarını YERİNDE günceller (liste yeniden kurulmaz, kaydırma sıçramaz).
function refreshLyricSubs(updateScreen = true) {
  const items = el("lyrics-list").children;
  const subs = currentSubs();
  for (let i = 0; i < items.length; i += 1) {
    const sub = subs[i] || { ro: "", tr: "" };
    const ro = items[i].children[1];
    const tr = items[i].children[2];
    if (!ro || !tr) continue;
    if (ro.textContent !== sub.ro) ro.textContent = sub.ro;
    ro.hidden = !sub.ro;
    if (tr.textContent !== sub.tr) tr.textContent = sub.tr;
    tr.hidden = !sub.tr;
  }
  if (updateScreen && lyricsScreen && lyricsScreen.isOpen) lyricsScreen.setSubs(subs);
}

function translationRecord() {
  return currentSong && currentSong.status ? TR.translationOf(currentSong.status) : undefined;
}

function trView() {
  return TR.actionView({
    lang: trLang(), hasDoc: Boolean(lyricsDoc), record: translationRecord(), map: trMap,
    lines: lyricsDoc ? lyricsDoc.lines : [], offline: isOffline(), starting: trStarting,
  });
}

function refreshTranslateUi() {
  const view = trView();
  const button = el("lyrics-translate");
  const editing = lyricsEditing;
  const showButton = view.kind === "translate" || view.kind === "update" || view.kind === "retry";
  button.hidden = !showButton || editing;
  button.textContent = view.label || "Çevir";
  button.disabled = view.disabled;
  button.title = view.hint;
  const reading = el("lyrics-add-reading");
  reading.hidden = !view.addReading || editing;
  reading.disabled = isOffline() || trStarting;
  reading.title = isOffline() ? "İnternet yok" : "Çevirilere dokunmadan okunuşu ekler";
  const trToggle = el("lyrics-tr-toggle");
  const roToggle = el("lyrics-ro-toggle");
  trToggle.hidden = !view.showTr || editing;
  roToggle.hidden = !view.showRo || editing;
  trToggle.setAttribute("aria-pressed", String(trShow.tr));
  roToggle.setAttribute("aria-pressed", String(trShow.ro));
  const note = el("lyrics-tr-notice");
  const text = (view.note && view.note.text) || trNote;
  note.textContent = "";
  note.hidden = !text || editing;
  if (text) {
    const span = document.createElement("span");
    span.className = `notice ${view.note && view.note.tone === "info" ? "info" : ""}`.trim();
    span.textContent = text;
    note.append(span);
  }
  // Tam ekrandaki ⚙ paneli: veri yoksa "Alt yazı" bölümü görünmez
  const box = el("lf-subs-box");
  if (box) {
    box.hidden = !view.showTr;
    for (const [kind, input] of subsInputs) {
      input.checked = trShow[kind];
      input.closest("label").hidden = kind === "ro" ? !view.showRo : !view.showTr;
    }
  }
}

function setTrShow(kind, on) {
  trShow = { ...trShow, [kind]: Boolean(on) };
  try { TR.writeShow(localStorage, trShow); } catch { /* yok say */ }
  refreshTranslateUi();
  refreshLyricSubs();
}

function applyTranslation(map, version) {
  trMap = map && map.size ? map : null;
  trVersion = Number(version) || 0;
  trNote = "";
  refreshLyricSubs();
  refreshTranslateUi();
}

function resetTranslation() {
  trLoadGen += 1;
  clearInterval(trPollTimer);
  trPollTimer = 0;
  trMap = null;
  trVersion = 0;
  trStarting = false;
  trNote = "";
}

async function loadTranslation(retry = true) {
  if (!currentSong || !lyricsDoc || !TR.isTranslatable(lyricsDoc.language)) {
    if (trMap) applyTranslation(null, 0);
    else refreshTranslateUi();
    return;
  }
  const id = currentSong.id;
  const generation = ++trLoadGen;
  const storage = lyricsStorage();
  if (!trMap && storage) {
    const cached = TR.readCache(storage, id);
    if (cached) applyTranslation(cached.map, cached.version);
  }
  const record = translationRecord();
  const serverVersion = record && Number(record.version) ? Number(record.version) : 0;
  const needFetch = Boolean(record) && !isOffline() && (!trMap || (serverVersion && serverVersion !== trVersion))
    && !TR.isRunning(record);
  refreshTranslateUi();
  if (TR.isRunning(record)) ensureTranslationPolling();
  if (!needFetch) return;
  try {
    const response = await api.getTranslation(id);
    if (generation !== trLoadGen || !currentSong || currentSong.id !== id || !lyricsDoc) return;
    const map = TR.buildMap(lyricsDoc.lines, response.lines);
    if (!map) {
      // satır sayısı tutmadı: sözler bizde eski olabilir; bir kez yeniden yükle
      if (retry) await loadLyricsDoc();
      return;
    }
    if (storage) TR.writeCache(storage, id, map, response.version, response.lang);
    applyTranslation(map, response.version);
  } catch (error) {
    if (error instanceof ApiError && error.kind === "notfound") {
      if (storage) TR.dropCache(storage, [id]);
      if (trMap) applyTranslation(null, 0);
    }
    // ağ hatası: eldeki (önbellek) çeviri kalır
  }
}

function ensureTranslationPolling() {
  if (trPollTimer || !currentSong) return;
  const songId = currentSong.id;
  trPollTimer = setInterval(async () => {
    if (!currentSong || currentSong.id !== songId) {
      clearInterval(trPollTimer);
      trPollTimer = 0;
      return;
    }
    try {
      adoptDetail(await api.getSong(songId));
    } catch {
      return;                                      // geçici ağ hatası: bir sonraki turda
    }
    if (!TR.isRunning(translationRecord())) {
      clearInterval(trPollTimer);
      trPollTimer = 0;
      trStarting = false;
      const failure = TR.statusMessage(translationRecord());
      trNote = failure ? failure.text : "";
      await loadTranslation();
    }
  }, 4000);
}

async function startTranslation(reading = false) {
  if (!currentSong || !lyricsDoc || trStarting) return;
  if (!requireOnline(el("player-message"), "çeviri")) return;
  const songId = currentSong.id;
  trStarting = true;
  trNote = "";
  refreshTranslateUi();
  try {
    await api.startTranslate(songId, false, reading === true);
    const detail = await api.getSong(songId);
    if (currentSong && currentSong.id === songId) adoptDetail(detail);
  } catch (error) {
    trStarting = false;
    trNote = TR.errorMessage(error);
    refreshTranslateUi();
    return;
  }
  trStarting = false;
  if (!TR.isRunning(translationRecord())) {
    // anında bitti (tümü zaten çevrili) ya da hata: durumu yükle
    const failure = TR.statusMessage(translationRecord());
    trNote = failure ? failure.text : "";
    await loadTranslation();
  } else {
    refreshTranslateUi();
    ensureTranslationPolling();
  }
}

function buildSubsControls(container) {
  for (const [kind, text] of [["tr", "Çeviri göster"], ["ro", "Okunuş göster"]]) {
    const label = document.createElement("label");
    label.className = "bg-opt";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.addEventListener("change", () => setTrShow(kind, input.checked));
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    container.append(label);
    subsInputs.push([kind, input]);
  }
}

function lyricsReducedMotion() {
  return Boolean(reducedMotion && reducedMotion.matches);
}

function scrollLyricsTo(index) {
  const list = el("lyrics-list");
  const item = list.children[index];
  if (!item || list.clientHeight === 0) return;
  const top = Math.max(0, item.offsetTop - (list.clientHeight - item.offsetHeight) / 2);
  if (Math.abs(list.scrollTop - top) < 2) return;
  lyricsScrollGuard = performance.now() + SCROLL_GUARD_MS;
  list.scrollTo({ top, behavior: lyricsReducedMotion() ? "auto" : "smooth" });
}

function paintLyrics(index) {
  const items = el("lyrics-list").children;
  const previous = lyricsIndex;
  if (previous >= 0) {
    for (let k = previous - 1; k <= previous + 1; k += 1) {
      if (items[k]) items[k].classList.remove("active", "near");
    }
  }
  if (index >= 0) {
    for (let k = index - 1; k <= index + 1; k += 1) {
      if (items[k] && k !== index) items[k].classList.add("near");
    }
    if (items[index]) items[index].classList.add("active");
  }
  lyricsIndex = index;
  if (index >= 0 && lyricsFollow) scrollLyricsTo(index);
}

// Her karede çağrılıyor: satır değişmedikçe DOM'a dokunmaz.
function lyricsTick(time) {
  if (!lyricsDoc || el("lyrics-body").hidden) return;
  const index = findLine(lyricsDoc.lines, highlightTime(time));
  if (index !== lyricsIndex) paintLyrics(index);
}

function lyricsUserScrolled() {
  if (!lyricsFollow) return;
  lyricsFollow = false;
  el("lyrics-follow").hidden = false;
}

function lyricsResumeFollow() {
  lyricsFollow = true;
  el("lyrics-follow").hidden = true;
  if (!lyricsDoc) return;
  const target = scrollTarget(lyricsDoc.lines, highlightTime(engine.visualTime));
  if (target >= 0) scrollLyricsTo(target);
}

// "Zamanı düzelt": satırın başlangıcı = dokunduğun anki şarkı konumu - tepki payı. Sunucu kaydeder
// (CPU, anında), satır `m` ile işaretlenir ve sonraki yeniden hizalamada ÇAPA olarak korunur.
async function fixLyricTime(index) {
  if (!lyricsDoc || lyricsFixBusy || !currentSong) return;
  if (!requireOnline(el("player-message"), "Zamanı kaydetmek")) return;
  const songId = currentSong.id;
  const time = fixTime(engine.visualTime);
  lyricsFixBusy = true;
  const item = el("lyrics-list").children[index];
  if (item) item.classList.add("pressing");
  try {
    const result = await api.setLyricTimes(songId, { version: lyricsDoc.version, set: [{ i: index, t: time }] });
    if (!currentSong || currentSong.id !== songId || !lyricsDoc) return;
    lyricsDoc = applyChanged(lyricsDoc, result.changed, result.version);
    const lyr = lyricsStatus();
    if (lyr) {
      currentSong = { ...currentSong, status: { ...currentSong.status,
        lyrics: { ...lyr, version: result.version, edited: true } } };
      writeMeta(songId, currentSong);
    }
    const storage = lyricsStorage();
    if (storage) writeLyricsCache(storage, songId, lyricsDoc, result.version);
    const row = el("lyrics-list").children[index];
    if (row) {
      row.classList.remove("low");
      row.classList.add("manual");
    }
    lyricsIndex = -2;
    lyricsTick(engine.visualTime);
    loopNotice(`${index + 1}. satır ${formatPoint(time)}'de başlıyor.`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      showMessage(el("player-message"), "Sözler başka bir yerden değişmiş, yenileniyor.", "warn");
      await loadLyricsDoc();
    } else if (error instanceof ApiError && error.status === 400) {
      showMessage(el("player-message"), `Bu zaman olmaz: ${error.message}`, "warn");
    } else {
      showMessage(el("player-message"), describeError(error));
    }
  } finally {
    lyricsFixBusy = false;
    const row = el("lyrics-list").children[index];
    if (row) row.classList.remove("pressing");
  }
}

async function onLyricLineTap(index) {
  if (!lyricsDoc || !(engine.duration > 0)) return;
  const line = lyricsDoc.lines[index];
  if (!line) return;
  if (lyricsFixing) {
    await fixLyricTime(index);
    return;
  }
  lyricsFollow = true;
  el("lyrics-follow").hidden = true;
  await engine.seek(Math.min(line.t, engine.duration));
  metronome.resync();
  // Duraklatılmışken de vurgu/kaydırma hemen oturur.
  paintLyrics(index);
}

async function onLyricLineLongPress(index) {
  if (!lyricsDoc || !(engine.duration > 0)) return;
  const found = lineLoop(lyricsDoc.lines, index, engine.duration, minLoopLength(loopGrid));
  if (!found) {
    loopNotice("Bu satır döngü için çok kısa.");
    return;
  }
  try { if (navigator.vibrate) navigator.vibrate(15); } catch { /* yok say */ }
  loopA = found.a;
  loopB = found.b;
  loopOn = true;
  await applyLoop();
  saveLoopPoints();
  loopNotice(`${index + 1}. satır döngüde.`);
}

function bindLyricsList() {
  const list = el("lyrics-list");
  if (!list) return;
  let press = null;
  const cancel = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press.item.classList.remove("pressing");
    press = null;
  };
  list.addEventListener("pointerdown", (event) => {
    const item = event.target.closest(".lyric-line");
    if (!item || (event.pointerType === "mouse" && event.button !== 0)) return;
    cancel();
    const index = Number(item.dataset.i);
    press = { index, item, x: event.clientX, y: event.clientY, fired: false, timer: 0 };
    item.classList.add("pressing");
    press.timer = setTimeout(() => {
      if (!press) return;
      press.fired = true;
      press.item.classList.remove("pressing");
      onLyricLineLongPress(press.index);
    }, LYRICS_PRESS_MS);
  });
  list.addEventListener("pointermove", (event) => {
    if (!press || press.fired) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP_PX) cancel();
  });
  list.addEventListener("pointerup", () => {
    if (!press) return;
    const { fired, index } = press;
    cancel();
    if (!fired) onLyricLineTap(index);
  });
  list.addEventListener("pointercancel", cancel);      // kaydırma başlayınca tarayıcı iptal eder
  list.addEventListener("contextmenu", (event) => event.preventDefault());   // uzun basma menüsü
  // Kullanıcı kaydırınca otomatik kaydırma durur; programatik kaydırmanın scroll olayları sayılmaz.
  list.addEventListener("wheel", lyricsUserScrolled, { passive: true });
  list.addEventListener("touchmove", lyricsUserScrolled, { passive: true });
  list.addEventListener("scroll", () => {
    if (performance.now() > lyricsScrollGuard) lyricsUserScrolled();
  }, { passive: true });
  list.addEventListener("scrollend", () => { lyricsScrollGuard = 0; });
}

// ---- yükleme / önbellek / yoklama

function resetLyrics() {
  resetTranslation();
  clearInterval(lyricsPollTimer);
  lyricsPollTimer = 0;
  lyricsLoadGen += 1;
  lyricsDoc = null;
  lyricsStarting = false;
  lyricsEditing = false;
  lyricsFixing = false;
  renderLyricsList();
  refreshLyricsUi();
}

// Cihazdaki kopya sürümle eşleşiyorsa ağa çıkılmaz; çevrimdışıyken (ya da ağ
// hatasında) eldeki kopya kullanılır.
async function loadLyricsDoc() {
  if (!currentSong) return;
  const id = currentSong.id;
  const generation = ++lyricsLoadGen;
  const lyr = lyricsStatus();
  const storage = lyricsStorage();
  const entry = storage ? readLyricsCache(storage, id) : null;
  // Sunucuda söz dosyası olabilecek durumlar: done, ya da yeniden hizalanırken önceki kayıt.
  const serverHasFile = Boolean(lyr && (lyr.state === "done" || (lyr.previous && lyr.previous.state === "done")));
  const wantVersion = lyr
    ? (lyr.state === "done" ? Number(lyr.version) : Number(lyr.previous && lyr.previous.version)) || 0
    : 0;
  let doc = null;
  let version = 0;
  if (serverHasFile && entry && entry.version === wantVersion && wantVersion > 0) {
    doc = entry.doc;
    version = entry.version;
  } else if (serverHasFile && !isOffline()) {
    try {
      const response = await api.getLyrics(id);
      doc = normalizeLyricsDoc(response.lyrics);
      version = Number(response.version) || (doc && doc.version) || 0;
      if (doc && storage) writeLyricsCache(storage, id, response.lyrics, version);
    } catch (error) {
      if (error instanceof ApiError && error.kind === "notfound") {
        if (storage) dropLyricsCache(storage, [id]);
      } else if (entry) {
        doc = entry.doc;                         // ağ hatası: eldeki kopya
        version = entry.version;
      }
    }
  } else if (entry) {
    doc = entry.doc;                             // çevrimdışı / durum bilinmiyor
    version = entry.version;
  }
  if (generation !== lyricsLoadGen || !currentSong || currentSong.id !== id) return;
  if (doc && lyricsDoc && lyricsDoc.version === doc.version && lyricsDoc.lines.length === doc.lines.length) {
    refreshLyricsUi();                           // aynı sürüm: listeye dokunma, kaydırma sıçramasın
    loadTranslation();
    return;
  }
  lyricsDoc = doc;
  renderLyricsList();
  refreshLyricsUi();
  if (lyricsDoc) lyricsTick(engine.visualTime);
  loadTranslation();
}

function lyricsRunning() {
  return lyricsIsRunning(lyricsStatus());
}

function ensureLyricsPolling() {
  if (lyricsPollTimer || !currentSong || !lyricsRunning()) return;
  const songId = currentSong.id;
  lyricsPollTimer = setInterval(async () => {
    if (!currentSong || currentSong.id !== songId) {
      clearInterval(lyricsPollTimer);
      lyricsPollTimer = 0;
      return;
    }
    try {
      adoptDetail(await api.getSong(songId));
    } catch {
      return;                       // geçici ağ hatası: bir sonraki turda tekrar
    }
    if (!lyricsRunning()) {
      clearInterval(lyricsPollTimer);
      lyricsPollTimer = 0;
      await loadLyricsDoc();
    }
    refreshLyricsUi();
  }, LYRICS_POLL_MS);
}

function initLyrics() {
  lyricsStarting = false;
  refreshLyricsUi();
  loadLyricsDoc();
  ensureLyricsPolling();
}

async function startLyricsJob(params) {
  if (!currentSong || lyricsStarting) return false;
  if (!requireOnline(el("player-message"), "Sözleri hazırlamak")) return false;
  const songId = currentSong.id;
  lyricsStarting = true;
  refreshLyricsUi();
  let ok = false;
  try {
    await api.startLyrics(songId, params);
    adoptDetail(await api.getSong(songId));        // status.lyrics'in tamamı
    ok = true;
  } catch (error) {
    showMessage(el("player-message"), describeError(error));
  } finally {
    lyricsStarting = false;
    refreshLyricsUi();
    ensureLyricsPolling();
    if (ok && !lyricsRunning()) loadLyricsDoc();   // vokal yok / mevcut sonuç gibi anında biten durumlar
  }
  return ok;
}

// ---- düzenleme kutusu

function updateLyricsCount() {
  const { lines, error } = checkLyricsText(el("lyrics-text").value);
  const node = el("lyrics-count");
  node.textContent = error ? (lines.length || el("lyrics-text").value.trim() ? error : "") : `${lines.length} satır`;
  el("lyrics-save").disabled = Boolean(error) || lyricsStarting;
}

function openLyricsEditor(text) {
  buildLyricsLangOptions();
  el("lyrics-text").value = text;
  el("lyrics-edit-lang").value = (lyricsDoc && lyricsDoc.language) || "auto";
  el("lyrics-save").textContent = lyricsDoc ? "Kaydet ve hizala" : "Hizala";
  lyricsEditing = true;
  pushLayer("lyrics-editor");
  refreshLyricsUi();
  updateLyricsCount();
  el("lyrics-text").focus();
}

function closeLyricsEditorDom() {
  lyricsEditing = false;
  refreshLyricsUi();
}

function hasLyricsToOverwrite() {
  const lyr = lyricsStatus();
  return Boolean(lyricsDoc) || Boolean(lyr && lyr.state === "done");
}

async function saveLyricsEditor() {
  const { lines, error } = checkLyricsText(el("lyrics-text").value);
  if (error) {
    updateLyricsCount();
    return;
  }
  if (hasLyricsToOverwrite()
      && !window.confirm("Mevcut sözlerin üzerine yazılacak. Metin sese yeniden hizalanacak. Devam edilsin mi?")) {
    return;
  }
  const language = el("lyrics-edit-lang").value || "auto";
  const manual = lyricsDoc ? mapManual(lyricsDoc.lines, lines) : [];       // elle zamanlar çapa kalır
  const started = await startLyricsJob({ mode: "pasted", language, text: lines.join("\n"), manual });
  if (started) requestBack("lyrics-editor");
}

async function realignLyrics() {
  if (!lyricsDoc) return;
  if (!window.confirm("Sözler mevcut metinle sese yeniden hizalanacak. Devam edilsin mi?")) return;
  await startLyricsJob({ mode: "pasted", language: lyricsDoc.language || "auto", text: linesToText(lyricsDoc.lines),
    manual: mapManual(lyricsDoc.lines, lyricsDoc.lines.map((line) => line.text)) });
}

buildLyricsLangOptions();
bindLyricsList();
on("lyrics-toggle", "click", () => {
  const storage = lyricsStorage();
  try { if (storage) storage.setItem(LYRICS_COLLAPSE_KEY, lyricsCollapsed() ? "0" : "1"); } catch { /* yok say */ }
  refreshLyricsUi();
  if (lyricsDoc && !lyricsCollapsed()) {
    lyricsIndex = -2;
    lyricsTick(engine.visualTime);
    lyricsResumeFollow();
  }
});
on("lyrics-follow", "click", lyricsResumeFollow);
on("lyrics-extract", "click", () => {
  if (lyricsDoc && !window.confirm("Mevcut sözlerin üzerine yazılacak. Devam edilsin mi?")) return;
  startLyricsJob({ mode: "auto", language: el("lyrics-lang").value || "auto", replace: Boolean(lyricsDoc) });
});
on("lyrics-paste", "click", () => openLyricsEditor(""));
on("lyrics-edit", "click", () => openLyricsEditor(lyricsDoc ? linesToText(lyricsDoc.lines) : ""));
on("lyrics-realign", "click", realignLyrics);
on("lyrics-fix", "click", () => {
  lyricsFixing = !lyricsFixing;
  refreshLyricsUi();
});
on("lyrics-cancel", "click", () => requestBack("lyrics-editor"));
on("lyrics-save", "click", saveLyricsEditor);
on("lyrics-text", "input", updateLyricsCount);


// ---------------------------------------------------------------- olaylar

on("open-settings", "click", () => {
  refreshStemCacheState();
  el("setting-url").value = settings.url;
  el("setting-token").value = settings.token;
  el("setting-stretcher").value = settings.stretcher;
  refreshStretcherUi();
  refreshAudioUi();
  refreshParallelUi();
  refreshOpenStats();
  refreshAudioDiag();
  hideMessage(el("settings-message"));
  showView("settings");
  pushLayer("view");
});

on("close-settings", "click", () => requestBack("view"));

on("settings-form", "submit", (event) => {
  event.preventDefault();
  settings = saveSettings({
    url: el("setting-url").value,
    token: el("setting-token").value,
  });
  api = new Api(settings);
  renderShareCard();
  showMessage(el("settings-message"), "Kaydedildi.", "ok");
  // Kullanıcı eylemi sonrası yeniden iste: ilk açılışta reddedilen izin Chrome'un
  // etkileşim ölçütüyle sonradan verilebiliyor. Sonuç tanı satırında.
  stemCache.requestPersistence().then(() => refreshAudioDiag());
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

on("share-go", "click", confirmShare);
on("share-cancel", "click", dropShare);

on("refresh-list", "click", refreshLibrary);

// --- seçim modu düğmeleri ---
on("select-cancel", "click", exitSelectMode);
on("select-delete", "click", deleteSelected);
on("select-all", "click", () => {
  if (selectedIds.size === librarySongs.length) selectedIds.clear();
  else for (const song of librarySongs) selectedIds.add(song.id);
  renderLibrary(librarySongs);
});

// Escape = geri. Geri tuşu maddesi gelince aynı handleBack() popstate'e de
// bağlanacak; sıralama orada da "önce seçimden çık" olmalı.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && handleBack()) event.preventDefault();
});

// Mikserden kütüphaneye: çalma DURUYOR, konum korunuyor, tamponlar kalıyor
// (aynı şarkıya hızlı dönüş). Mini oynatıcı yok - bilinçli.
on("back-to-library", "click", () => requestBack("view"));

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
  releasePlaybackWake();
}

async function togglePlayback() {
  if (engine.playing) stopPlayback();
  else await startPlayback();
}

on("play", "click", togglePlayback);

on("reprocess", "click", async () => {
  if (!currentSong) return;
  if (!requireOnline(el("player-message"), "Hi-Fi'a yükseltmek")) return;
  const button = el("reprocess");
  button.disabled = true;
  showMessage(el("player-message"),
    "Hi-Fi ile yeniden ayrıştırılıyor. Akor ve vuruş korunuyor; " +
    "bitince listeye dönüp şarkıyı yeniden aç.", "warn");
  try {
    await api.reprocess(currentSong.id, "hifi");
  } catch (error) {
    showMessage(el("player-message"), describeError(error));
    button.disabled = false;
  }
});

on("rewind", "click", async () => {
  // Döngü açıkken "başa dön" döngünün A'sına döner (döngü kapanmaz).
  if (engine.loop) {
    await engine.seek(engine.loop.a, { keepLoop: true });
    metronome.resync();
  } else {
    await engine.seek(0);
  }
});

on("seek", "input", () => {
  seeking = true;
  const time = Number(el("seek").value) / 10;
  el("time-current").textContent = formatTime(time);
  el("time-remaining").textContent = `-${formatTime(engine.duration - time)}`;
  strip.update(time);
  lyricsTick(time);
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
  scheduleMixSave();
});

// --------------------------------------------------------- esnetici seçimi

// --------------------------------------------- AAC decode gecikmesi (ucuz kısım)
//
// Hipotez: m4a'nın encoder priming'i (tipik 1024-2112 örnek = 23-48 ms)
// tarayıcıda kırpılmıyorsa ses ızgaraya göre kayar. Sunucuya dokunmadan
// ölçülebilen BİR şey var: çözülen tamponun UZUNLUĞU. Sunucu süreyi ham
// PCM'den hesaplayıp status.json'a yazıyor; AAC ise hem başa priming hem
// sona çerçeve dolgusu ekliyor. Tarayıcı bunları kırpıyorsa iki süre
// birbirini tutar, kırpmıyorsa tampon ~23-48 ms UZUN çıkar.
//
// Ne KANITLAMAZ: uzunluk farkı 0 ise başın doğru kırpıldığı kesinleşmez
// (teorik olarak baş kırpılmayıp son fazladan kırpılmış olabilir) ve fark
// varsa kaymanın tam miktarı bilinmez. Kesin ölçüm çapraz ilinti ister:
// aynı stem'in FLAC aslını `POST /songs/{id}/download-link?format=flac` ile
// imzalı URL'den indirip iki tamponu karşılaştırmak. Sunucu değişikliği
// gerekmiyor ama ~20 MB indirme + ilinti kodu gerekiyor; yerelde FLAC aslı
// olmadığı için bu turda DOĞRULANAMAZDI, o yüzden sonraki tura bırakıldı.
function measureAacDelta(status, decodedDuration) {
  const reported = Number(status && status.duration) || 0;
  if (!reported || !decodedDuration) {
    lastAacDelta = "";
    return;
  }
  const deltaMs = (decodedDuration - reported) * 1000;
  const rounded = Math.round(deltaMs * 10) / 10;
  lastAacDelta = `AAC uzunluk farkı ${rounded >= 0 ? "+" : ""}${rounded} ms`;
  console.info(
    `[aac] çözülen ${decodedDuration.toFixed(3)} sn, sunucu ${reported.toFixed(3)} sn, `
    + `fark ${rounded} ms (0'a yakınsa tarayıcı priming/dolguyu kırpıyor)`
  );
}

// ------------------------------------------------------- mobil ses kalitesi

// Ayarlar ekranındaki iki satır: cihazın DOĞAL hızı (zorlamasız bir context
// açıp okunuyor) ve ŞU AN kullanılan context'in hızı + kanal sayısı. İkisi
// ayrı ayrı gerekiyor: zorlama yüzünden doğal hız bugüne kadar hiç görünmedi.
async function refreshAudioUi() {
  const select = el("setting-audio");
  if (select) select.value = settings.mobileAudio;

  const note = el("audio-note");
  if (note) {
    note.textContent = engine.mobile
      ? "Yüksek (varsayılan): cihazın kendi hızı, stereo. 9 dakikalık bir "
        + "şarkı (~1.25 GB) telefonda sorunsuz çalıştı ve hiza testi 48 kHz'de "
        + "geçti. Tasarruf: AudioContext 32 kHz'e zorlanır, stem'ler mono'ya "
        + "iner (8 dk şarkıda ~350 MB); yalnız belleği dar bir cihazda gerekir."
      : "Bu ayar yalnız mobilde etkili; masaüstünde zaten tam kalite "
        + "(cihaz hızı, stereo) çalışıyor.";
  }

  const state = el("audio-state");
  if (!state) return;
  const info = engine.audioInfo();
  const native = await nativeSampleRate();
  const parts = [];
  parts.push(native ? `cihazın doğal hızı ${native} Hz` : "cihaz hızı okunamadı");
  if (info.sampleRate) {
    const channelText = info.stems
      ? `${info.channels === 1 ? "mono" : `${info.channels} kanal`}, ${info.stems} stem`
      : "kanal yok (şarkı açılmadı)";
    parts.push(`şu an ${Math.round(info.sampleRate)} Hz, ${channelText}`);
  } else {
    parts.push("ses motoru henüz açılmadı (bir şarkı aç)");
  }
  if (info.forcedRate) parts.push(`hız ${info.forcedRate} Hz'e zorlanıyor`);
  if (lastAacDelta) parts.push(lastAacDelta);
  state.textContent = parts.join(" · ");
}

// Paralel çözme seçeneği GEÇİCİ bir deney ayarı: kaç stem'in aynı anda
// getirilip çözüleceğini seçtiriyor. Kalıcı bir kullanıcı ayarı değil,
// telefonda ölçüm yapabilmek için duruyor.
function buildParallelOptions() {
  const select = el("setting-parallel");
  if (!select) return;
  select.innerHTML = "";
  // "Varsayılan" etiketi settings.js'teki değerden geliyor, elle yazılmıyor:
  // varsayılan değişince etiket de değişsin.
  const fallback = normalizeParallel(undefined);
  for (const value of DECODE_PARALLEL) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = value === fallback ? `${value} (varsayılan)` : String(value);
    select.append(option);
  }
}

function refreshParallelUi() {
  const select = el("setting-parallel");
  if (select) select.value = String(settings.decodeParallel);
  const note = el("parallel-note");
  if (!note) return;
  // 9 dakikalık şarkı, 48 kHz stereo float32: stem başına 207 MB.
  const perStem = 540 * 48000 * 2 * 4 / 1024 ** 2;
  const total = perStem * 6;
  const extra = perStem * (settings.decodeParallel - 1);
  note.textContent =
    `Aynı anda kaç stem getirilip çözülecek. Her çözme arka planda bir AudioBus `
    + `üretip ana iş parçacığında AudioBuffer'a kopyalıyor; kopya bitene kadar `
    + `ikisi de bellekte. 9 dk / 48 kHz stereo şarkıda stem başına `
    + `${Math.round(perStem)} MB: son hâl ${Math.round(total)} MB, `
    + `${settings.decodeParallel}'li çözmede tepe ~${Math.round(total + extra)} MB `
    + `(+${Math.round(extra)} MB geçici). Takılma ya da çökme görürsen düşür.`;
}

// Ses tanısı satırı (diag.js). Bellekteki toplam PCM burada görünüyor: 6 dk'lık
// bir şarkı Yüksek kipte ~900 MB tutabiliyor, telefonda belleğin gerçekten
// sorun olup olmadığı ancak buradan okunur.
function diagText() {
  const info = engine.diagnostics();
  info.deviceMemoryGb = navigator.deviceMemory || 0;
  info.jsHeapBytes = performance.memory ? performance.memory.usedJSHeapSize : 0;
  info.persisted = stemCache.persisted;
  return summarize(info, diag);
}

function refreshAudioDiag() {
  const node = el("audio-diag");
  if (!node) return;
  node.textContent = diagText();
  const log = el("audio-diag-log");
  if (log) log.textContent = eventsText(diag);
}

function refreshOpenStats() {
  const node = el("open-stats");
  if (!node) return;
  if (!lastOpen) {
    node.textContent = "Son açılış: henüz ölçülmedi.";
    return;
  }
  const steps = lastOpen.steps || {};
  const parts = Object.entries(steps).map(([name, ms]) => `${name} ${ms}`);
  const bits = [`Son açılış: ${lastOpen.total} ms`];
  if (parts.length) bits.push(parts.join(" · "));
  // İndirme ve çözme toplamları: boru hattında üst üste bindikleri için
  // toplamları duvar saatini aşabilir, ama hangisinin uzadığı ancak böyle
  // görülüyor.
  if (lastOpen.fetchMs != null || lastOpen.decodeMs != null) {
    bits.push(`indirme ${lastOpen.fetchMs} + çözme ${lastOpen.decodeMs} (toplam iş)`);
  }
  if (lastOpen.bytes) {
    bits.push(`${(lastOpen.bytes / 1024 ** 2).toFixed(1)} MB`);
  }
  if (lastOpen.source) bits.push(`kaynak: ${lastOpen.source}`);
  if (lastOpen.infoSource) bits.push(`bilgi: ${lastOpen.infoSource}`);
  if (lastOpen.concurrency) bits.push(`paralellik ${lastOpen.concurrency}`);
  if (lastOpen.duration) bits.push(`şarkı ${Math.round(lastOpen.duration)} sn`);
  if (lastOpen.kind) bits.push(lastOpen.kind);
  node.textContent = bits.join(" · ");
}

on("setting-parallel", "change", () => {
  settings = saveSettings({ decodeParallel: el("setting-parallel").value });
  refreshParallelUi();
});

on("setting-audio", "change", async () => {
  settings = saveSettings({ mobileAudio: el("setting-audio").value });
  const changed = engine.setAudioMode(settings.mobileAudio);
  if (changed) {
    // AudioBuffer'lar context'in örnekleme hızına bağlı, taşınamıyorlar:
    // context yeniden kurulunca açık şarkı da düşüyor. Sayfa yenilemek
    // GEREKMİYOR, ama şarkının yeniden açılması gerekiyor - kullanıcı bunu
    // ekranda okusun, sessizce "ses gelmiyor" yaşamasın.
    stopPlayback();
    stopLoop();
    metronome.dispose();
    await engine.rebuildContext();
    currentSong = null;
    showMessage(
      el("settings-message"),
      "Ses motoru yeniden kuruldu. Açık şarkı kapatıldı; kütüphaneden "
      + "yeniden aç. Sayfayı yenilemene gerek yok.",
      "ok"
    );
  }
  await refreshAudioUi();
});

function refreshStretcherUi() {
  const select = el("setting-stretcher");
  const check = el("setting-formants");
  if (!select || !check) return;
  // Seçilen ile GERÇEKTEN kullanılan ayrılabilir: WebAssembly yoksa ya da
  // kütüphane yüklenemezse yedeğe düşülüyor.
  const effective = normalizeStretcher(settings.stretcher);
  const info = stretcherInfo(effective);
  const able = supportsFormants(effective);
  const fellBack = effective !== settings.stretcher;
  el("stretcher-note").textContent =
    (fellBack
      ? `Bu cihazda ${stretcherInfo(settings.stretcher).label} çalışmıyor ` +
        `(WebAssembly yok), ${info.label} kullanılıyor. `
      : "") +
    `${info.label} (${info.license}). Değişiklik çalarken de uygulanıyor; ` +
    `hız 1.0 ve ton 0 iken hiçbir esnetici kurulmuyor.`;
  check.disabled = !able;
  check.checked = able && Boolean(settings.formants);
  el("formant-note").textContent = able
    ? "Ton kaydırırken formantları yerinde tutmayı dener. Kaynağın hız " +
      "kaydırması ayrıca geri çevriliyor, yoksa formantlar tempoyla birlikte " +
      "düşüyor (ölçüldü). A/B'de KAPALISI daha iyi geldi, varsayılan kapalı."
    : `${info.label} formant telafisi sunmuyor.`;
}

function applyStretcherSettings() {
  engine.setStretcher(settings.stretcher);
  engine.setFormants(settings.formants);
}

function applyAudioSettings() {
  engine.setAudioMode(settings.mobileAudio);
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
function renderAlignment(rows, legend) {
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
  // Açıklama testten geliyor: saçılma cümlesi kullanılan esneticiye göre
  // değişiyor (WSOLA'nın doğası Signalsmith için geçerli değil).
  const note = document.createElement("small");
  note.className = "align-legend";
  note.textContent = legend;
  host.append(note);
}

on("align-run", "click", async () => {
  const button = el("align-run");
  const state = el("align-state");
  const results = el("align-results");
  button.disabled = true;
  results.innerHTML = "";
  state.hidden = false;
  state.textContent = "Hazırlanıyor…";
  // Ölçüm sürerken geri yutuluyor: yarıda kesilen bir ölçüm yanlış sayı
  // verir, yanlış sayı da yanlış karar.
  nav.block("align");
  try {
    // Oynatıcı çalıyorsa durdur: iki AudioContext aynı anda ses vermesin.
    if (engine.playing) stopPlayback();
    const { runAlignmentCheck, PASS_MS } = await import("./aligncheck.js");
    const { rows, legend } = await runAlignmentCheck(
      (text) => { state.textContent = text; },
      {
        stretcher: settings.stretcher,
        formants: settings.formants,
        // Hiza testi SEÇİLİ kalitede koşuyor: kendi Engine'ini kurduğu için
        // kipi ona ayrıca söylemek gerekiyor, yoksa "Yüksek" seçiliyken
        // 32 kHz mono ölçer ve sonuç uygulamayı anlatmaz.
        audioMode: settings.mobileAudio,
      }
    );
    renderAlignment(rows, legend);
    const failed = rows.filter((item) => item.passed === false).length;
    state.textContent = failed
      ? `${failed} ölçüm kaldı (eşik ±${PASS_MS} ms).`
      : `Hepsi geçti (eşik ±${PASS_MS} ms).`;
  } catch (error) {
    state.textContent = `Test çalıştırılamadı: ${error && error.message ? error.message : error}`;
  } finally {
    nav.unblock("align");
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

// Saat örneği her saniye (çalarken), tanı satırı yalnız Ayarlar açıkken.
setInterval(() => {
  engine.sampleClock();
  if (!views.settings.hidden) refreshAudioDiag();
}, 1000);
window.addEventListener("error", (event) => diag.note("error", event.message || "?"));
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  diag.note("rejection", String((reason && reason.message) || reason));
});

// Çalarken context askıya alınırsa motor kendini duraklatıyor; arayüz de
// aynı durumu göstermeli, yoksa düğme "çalıyor" der, süre çubuğu donar.
engine.onInterrupted = (state) => {
  stopPlayback();
  showMessage(el("player-message"),
    `Ses sistem tarafından kesildi (${state}). Devam etmek için oynat'a bas.`, "warn");
};
engine.onResumed = () => {
  showMessage(el("player-message"), "Ses geri geldi. Oynat'a basabilirsin.", "ok");
  setTimeout(() => hideMessage(el("player-message")), 4000);
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) engine.resumeIfSuspended();
});

on("copy-diag", "click", async () => {
  const text = `${diagText()}
${eventsText(diag)}`;
  const button = el("copy-diag");
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Kopyalandı";
  } catch {
    // Pano reddedildi: olay listesini aç, elle seçilsin.
    const details = el("audio-diag-details");
    if (details) details.open = true;
    button.textContent = "Kopyalanamadı, elle seç";
  }
  setTimeout(() => { button.textContent = "Tanıyı kopyala"; }, 2500);
});

mixer = new Mixer(el("channels"), engine, scheduleMixSave, downloadStem);
buildFxSheet();
buildPresetButtons();
buildLoopButtons();
engine.onLoopCleared = () => {
  loopOn = false;
  refreshLoopUi();
  loopNotice("Döngü kapandı: döngü dışına atladın.");
};
// İndirme menüsü de bir katman: geri tuşu önce onu kapatıyor. Menü kendi
// içinde de kapanabiliyor (dışarı dokunma, bir biçim seçme) - o zaman
// katmanı history üzerinden düşürüyoruz ki iki yığın ayrışmasın.
mixer.onMenuChange = (open) => {
  if (open) pushLayer("menu");
  else if (nav.peek() === "menu") history.back();
};
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
buildParallelOptions();
refreshParallelUi();
applyStretcherSettings();
applyAudioSettings();
registerServiceWorker();
stemCache.requestPersistence();
// Sürüm değişimlerinden kalan eski dosyaları bir kez süpür.
stemCache.pruneSuperseded().catch(() => {});

if (isConfigured(settings)) {
  showView("library");
  // ÖNCE cihazdaki liste: internet yokken (ya da API soğuk başlarken)
  // kitaplık boş açılmasın. Sunucu hemen ardından arkada yoklanıyor.
  const cachedSongs = readLibraryCache();
  if (cachedSongs && cachedSongs.length) renderLibrary(cachedSongs);
  syncOfflineUi();
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
// Paylaş menüsünden gelen dosya (varsa) onay kartı olur; ayarlar yoksa ayar ekranında bilgi verilir.
handleShareLaunch();
