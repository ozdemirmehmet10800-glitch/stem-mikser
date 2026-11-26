// miksi dışa aktar (Aşama 12)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { STEM_LABELS } from "../engine.js";
import { SUB_LABELS } from "../sub.js";
import { buildRequest as buildExportRequest, errorMessage as exportErrorMessage, formatElapsed, formatBytes as formatExportBytes, mimeFor, presetLabel, regionNote, runExport, shareSupported, summarize as summarizeExport, tempoNote, waitHint } from "../exportmix.js";
import { el, on } from "../dom.js";
import { formatTime } from "../chords.js";

let engine, hideMessage, isOffline, masterPercent, pushLayer, requestBack, requireOnline, showMessage, currentSong, loopA, loopB, roomState, api;   // app.js'ten (bind)

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
  const hasLoop = loopA() !== null && loopB() !== null && loopB() - loopA() >= 0.1;
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
    loop: options.hasLoop ? { a: loopA(), b: loopB() } : null,
    options, labels: EXPORT_LABELS, room: roomState(),
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
  if (!currentSong()) return;
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
  el("export-region-note").textContent = options.hasLoop ? regionNote({ a: loopA(), b: loopB() }) : "";
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
  const duration = currentSong() ? Number(currentSong().duration) : 0;
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

export function exportReset() {
  exportRun.gen += 1;               // süren yoklama/hazırlık bayatlar
  exportRun = { ...exportRun, phase: "idle", specKey: null, result: null, file: null,
    shareState: "none", message: "", messageKind: "error" };
  clearInterval(exportTicker);
  exportTicker = 0;
}

// Düğme: şarkı açık, kanallar var, internet var.
export function refreshExportAvailability() {
  const chip = el("export-open");
  if (!chip) return;
  const ready = Boolean(currentSong()) && engine.channels.size > 0;
  const offline = isOffline();
  chip.disabled = !ready || offline;
  chip.title = offline ? "İnternet yok" : "";
  if (!el("export-sheet").hidden) exportRefreshForm();
}

function openExport() {
  if (!currentSong() || el("export-open").disabled) return;
  if (exportRun.songId !== currentSong().id) {
    exportReset();
    exportRun.songId = currentSong().id;
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

export function closeExportDom() {
  el("export-sheet").hidden = true;
}

async function startExportJob() {
  if (!currentSong() || exportWorking()) return;
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
  const songId = currentSong().id;
  Object.assign(exportRun, {
    phase: "working", songId, specKey: JSON.stringify(built.body), startedAt: Date.now(), step: "starting",
  });
  exportTicker = setInterval(() => { if (exportWorking()) exportRenderStatusText(); }, 1000);
  exportRefreshForm();
  const stale = () => gen !== exportRun.gen;
  try {
    const result = await runExport({
      api: api(), songId, body: built.body, isCancelled: stale,
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
  const link = await api().exportLink(exportRun.songId, result.hash);
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

export function bind(deps) {
  ({ engine, hideMessage, isOffline, masterPercent, pushLayer, requestBack, requireOnline, showMessage, currentSong, loopA, loopB, roomState, api } = deps);

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
}
