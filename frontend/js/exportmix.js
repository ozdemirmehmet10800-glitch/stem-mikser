// Miks dışa aktarma arayüzü mantığı (Aşama 12, oturum 2). SAF: DOM, ses ve ağ
// yok (api dışarıdan verilir); node ile test ediliyor: node tests\exportmix_test.mjs
//
// Sunucu mikser kuralı BİLMİYOR: dosya başına NİHAİ kazancı biz hesaplayıp
// yolluyoruz (mixmemory.effectiveGain). Açık bir grubun (ör. vokal) ana kanalının
// tamponu bellekten bırakılmıştır; yalnız alt parçaları (lead/backing) gider,
// yoksa sunucu "ana kanalla alt parçası birlikte karıştırılamaz" diye reddeder.

import {
  PRESETS, applyPreset, snapshot, effectiveGain, validLoop,
} from "./mixmemory.js";

export const MISC_LABEL = "Miks";            // hiçbir ön ayarla eşleşmeyen mikser
export const MAX_GAIN = 2.0;                 // sunucu sınırı (dosya başına doğrusal kazanç)
export const MAX_MASTER = 1.5;
export const POLL_MS = 2000;
export const GIVE_UP_MS = 15 * 60 * 1000;    // sunucudaki "takıldı" eşiği 20 dk; biz daha önce bırakırız
export const MAX_POLL_FAILS = 3;             // ardışık yoklama hatası

// ------------------------------------------------------------ mikser -> istek

/** Duyulan yaprak kanallar: ad -> nihai kazanç (0'lar atılır). */
export function leafGains(channels) {
  const gains = {};
  for (const [name, channel] of channels) {
    if (Array.isArray(channel.children) && channel.children.length) continue;   // açık grubun ana kanalı
    const gain = effectiveGain(channels, name);
    if (!(gain > 0)) continue;
    gains[name] = Math.round(Math.min(gain, MAX_GAIN) * 10000) / 10000;
  }
  return gains;
}

function sameState(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, state] of a) {
    const other = b.get(name);
    if (!other || other.fader !== state.fader || other.mute !== state.mute
        || other.solo !== state.solo) return false;
  }
  return true;
}

/**
 * Mikserin o anki hâli bir ön ayarla BİREBİR eşleşiyorsa onun adı, değilse "Miks".
 * Ana ses ön ayara dahil değil (ön ayarlar ona dokunmaz).
 */
export function presetLabel(channels) {
  const names = [...channels.keys()];
  const current = snapshot(channels);
  for (const preset of PRESETS) {
    const states = applyPreset(preset, names);
    if (states && sameState(states, current)) return preset.label;
  }
  return MISC_LABEL;
}

/**
 * İstek gövdesini kurar.
 *   channels: motor kanalları, masterPercent: 0-150, rate/semitones: mikserin hâli,
 *   options: {format, useTempo, useRegion}, loop: {a, b} ya da null (kuruluysa).
 * Dönen: {ok: true, body, label} | {ok: false, problem}.
 */
export function buildRequest({ channels, masterPercent, rate = 1, semitones = 0, vinyl = false, loop = null,
                               options = {} }) {
  const gains = leafGains(channels);
  if (!Object.keys(gains).length) {
    return { ok: false, problem: "Hiçbir kanal duyulmuyor. En az bir kanalı aç." };
  }
  const master = Math.min(Math.max(Number(masterPercent) / 100, 0), MAX_MASTER);
  if (!(master > 0)) return { ok: false, problem: "Ana ses sıfır. Sesi aç." };

  const label = presetLabel(channels);
  const body = {
    format: options.format === "wav" ? "wav" : "m4a",
    gains,
    master: Math.round(master * 10000) / 10000,
    label,
  };
  if (options.useTempo) {
    const r = Math.round((Number(rate) || 1) * 10000) / 10000;
    const s = vinyl ? 0 : Math.round(Number(semitones) || 0);
    if (r !== 1) body.rate = r;
    if (s !== 0) body.semitones = s;
    if (vinyl && r !== 1) body.vinyl = true;          // plak gibi: sunucu rubberband yerine asetrate+aresample'ı kullanır
  }
  if (options.useRegion) {
    const region = validLoop(loop);
    if (region) {
      body.region = { a: Math.round(region.a * 1000) / 1000, b: Math.round(region.b * 1000) / 1000 };
    }
  }
  return { ok: true, body, label };
}

// ------------------------------------------------------------------- özet

function lowerFirst(text) {
  return text ? text.charAt(0).toLocaleLowerCase("tr") + text.slice(1) : text;
}

function mmss(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function formatRate(rate) {
  return `${(Math.round(rate * 100) / 100).toString().replace(".", ",")}x`;
}

export function formatSemitones(semitones) {
  return `${semitones > 0 ? "+" : ""}${semitones} yarım ton`;
}

/**
 * "Ana vokal kapalı, arka vokal açık, 0,8x" gibi tek satır. Kapalı kanalları sayar;
 * kapalı kardeşi olan açık alt parçaları ayrıca "açık" diye yazar. Seviye ve ana ses
 * farklıysa onu da söyler. labels: ad -> görünen ad.
 */
export function summarize({ channels, masterPercent = 100, rate = 1, semitones = 0, vinyl = false, loop = null,
                            options = {}, labels = {} }) {
  const nameOf = (name) => labels[name] || name;
  const leaves = [];
  for (const [name, channel] of channels) {
    if (Array.isArray(channel.children) && channel.children.length) continue;
    leaves.push({ name, parent: channel.parent || null, gain: effectiveGain(channels, name) });
  }
  const closed = leaves.filter((leaf) => !(leaf.gain > 0));
  const parts = [];
  for (const leaf of closed) parts.push(`${nameOf(leaf.name)} kapalı`);
  // Kapalı bir kardeşi olan açık alt parçalar: "arka vokal açık".
  const groupsWithClosed = new Set(closed.filter((leaf) => leaf.parent).map((leaf) => leaf.parent));
  for (const leaf of leaves) {
    if (leaf.gain > 0 && leaf.parent && groupsWithClosed.has(leaf.parent)) {
      parts.push(`${nameOf(leaf.name)} açık`);
    }
  }
  if (!closed.length) parts.push("Tüm kanallar açık");
  const open = leaves.filter((leaf) => leaf.gain > 0);
  if (open.some((leaf) => Math.abs(leaf.gain - 1) > 0.01)) parts.push("bazı kanallar farklı seviyede");
  if (Math.round(Number(masterPercent)) !== 100) parts.push(`ana ses %${Math.round(Number(masterPercent))}`);

  if (options.useTempo) {
    const r = Number(rate) || 1;
    const s = vinyl ? 0 : Math.round(Number(semitones) || 0);
    if (r !== 1 || s !== 0) {
      const bits = [];
      if (r !== 1) bits.push(formatRate(r) + (vinyl ? " plak gibi" : ""));
      if (s !== 0) bits.push(formatSemitones(s));
      parts.push(bits.join(", "));
    }
  }
  const region = options.useRegion ? validLoop(loop) : undefined;
  if (region) parts.push(`yalnız ${mmss(region.a)}–${mmss(region.b)}`);

  return parts.map((part, index) => (index === 0 ? part : lowerFirst(part))).join(", ");
}

/** Hız/ton kutusunun alt yazısı: "0,8x, +2 yarım ton" ya da "şu an orijinal". */
export function tempoNote(rate, semitones, vinyl = false) {
  const r = Number(rate) || 1;
  const s = vinyl ? 0 : Math.round(Number(semitones) || 0);
  if (r === 1 && s === 0) return "şu an orijinal hız ve ton";
  const bits = [];
  if (r !== 1) bits.push(formatRate(r) + (vinyl ? " plak gibi" : ""));
  if (s !== 0) bits.push(formatSemitones(s));
  return bits.join(", ");
}

export function regionNote(loop) {
  const region = validLoop(loop);
  return region ? `${mmss(region.a)} – ${mmss(region.b)}` : "";
}

// ------------------------------------------------------------------ biçimler

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatElapsed(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} sn` : `${Math.floor(sec / 60)} dk ${String(sec % 60).padStart(2, "0")} sn`;
}

/** İşin ne kadar süreceğine dair dürüst bir ipucu (ölçüm: 158 sn'lik şarkı ~9-14 sn render, 30-38 sn bekleme). */
export function waitHint(durationSec) {
  const d = Number(durationSec) || 0;
  if (d <= 0) return "Birkaç on saniye sürebilir.";
  const estimate = Math.max(15, Math.round((20 + d * 0.1) / 5) * 5);     // ~20 sn soğuk başlangıç + ~0,1 x süre
  return `Bu şarkıda genelde ~${estimate} saniye sürer.`;
}

// ------------------------------------------------------------ hata mesajları

export class ExportFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportFailure";
  }
}

const has = (text, part) => String(text || "").toLowerCase().includes(part);

/** ApiError / ExportFailure -> kullanıcıya tek-iki cümle. */
export function errorMessage(error) {
  if (error instanceof ExportFailure) return error.message;
  const kind = error && error.kind;
  const status = error && error.status;
  const detail = error && error.message;
  if (kind === "offline") return "İnternet yok, dışa aktarmak için bağlantı gerekiyor.";
  if (kind === "network") return "Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.";
  if (kind === "config") return "API adresi ve token ayarlı değil. Ayarlar ekranını aç.";
  if (kind === "auth") return "Token kabul edilmedi. Ayarlar ekranından kontrol et.";
  if (kind === "notfound" || status === 404) {
    return "Şarkı ya da dışa aktarılan dosya bulunamadı (dosyalar 24 saat sonra silinir). Yeniden dışa aktar.";
  }
  if (status === 409) {
    if (has(detail, "baska bir disa aktarma")) {
      return "Başka bir dışa aktarma sürüyor. Bitmesini bekleyip tekrar dene.";
    }
    if (has(detail, "henuz hazir degil")) return "Şarkı henüz hazır değil. Hazır olunca tekrar dene.";
    if (has(detail, "isleniyor") || has(detail, "ayrilirken") || has(detail, "hazirlanirken")
        || has(detail, "ayristirilmamis")) {
      return "Şarkı şu an işleniyor. Bitince tekrar dene.";
    }
    return "Sunucu şu an dışa aktaramıyor. Biraz sonra tekrar dene.";
  }
  if (status === 400) {
    if (has(detail, "hicbir kanal")) return "Hiçbir kanal duyulmuyor. En az bir kanalı aç.";
    if (has(detail, "ana ses sifir")) return "Ana ses sıfır. Sesi aç.";
    if (has(detail, "birlikte karistirilamaz")) {
      return "Ana kanal ile alt parçaları birlikte karışamaz. Alt parçaları kapatıp açmayı dene.";
    }
    if (has(detail, "bilinmeyen ya da kullanilamayan")) {
      return "Bir kanal sunucuda hazır değil (alt parçalar yenilenmiş olabilir). Şarkıyı yeniden açıp dene.";
    }
    if (has(detail, "bolge")) return "A-B bölgesi geçersiz (en az 0,1 saniye olmalı).";
    return `Bu ayarla dışa aktarılamadı${detail ? ` (${detail})` : ""}.`;
  }
  if (status >= 500) return "Sunucu hatası. Biraz sonra tekrar dene.";
  return detail ? `Dışa aktarılamadı: ${detail}` : "Dışa aktarılamadı.";
}

// ------------------------------------------------------------- iş akışı

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Başlat -> yokla -> bitince sonuç. api: {startExport(id, body), getExport(id, hash)}.
 * onUpdate({phase: "starting" | "rendering", elapsedMs, existing?}); isCancelled() true
 * olursa {cancelled: true} döner (sunucudaki iş sürer, dosya 24 saat durur).
 * Dönen: {hash, filename, bytes, duration, format, existing}. Başarısızlıkta ApiError ya da
 * ExportFailure atar.
 */
export async function runExport({ api, songId, body, onUpdate = () => {}, isCancelled = () => false,
                                  sleep = defaultSleep, now = Date.now, pollMs = POLL_MS,
                                  giveUpMs = GIVE_UP_MS }) {
  const startedAt = now();
  onUpdate({ phase: "starting", elapsedMs: 0 });
  let job = await api.startExport(songId, body);
  const hash = job.hash;
  const existing = Boolean(job.existing);
  let fails = 0;
  while (job.state === "running") {
    if (isCancelled()) return { cancelled: true };
    const elapsed = now() - startedAt;
    if (elapsed > giveUpMs) {
      throw new ExportFailure("Dışa aktarma beklenenden uzun sürdü. Biraz sonra tekrar dene.");
    }
    onUpdate({ phase: "rendering", elapsedMs: elapsed, existing });
    await sleep(pollMs);
    if (isCancelled()) return { cancelled: true };
    try {
      job = await api.getExport(songId, hash);
      fails = 0;
    } catch (error) {
      // Geçici bağlantı hatası işi öldürmez; ardışık birkaç hata olursa bırakılır.
      const transient = error && (error.kind === "network" || error.kind === "offline");
      fails += 1;
      if (!transient || fails >= MAX_POLL_FAILS) throw error;
      job = { state: "running" };
    }
  }
  if (isCancelled()) return { cancelled: true };
  if (job.state !== "done") {
    throw new ExportFailure(job.message
      ? `Dışa aktarma başarısız: ${job.message}`
      : "Dışa aktarma başarısız oldu. Tekrar dene.");
  }
  return {
    hash, existing, filename: job.filename, bytes: job.bytes, duration: job.duration,
    format: job.format || body.format,
  };
}

/** Paylaşılabilir dosya türü (Web Share dosya türüne bakıyor). */
export function mimeFor(format) {
  return format === "wav" ? "audio/wav" : "audio/mp4";
}

/** Web Share'in dosya paylaşımı bu tarayıcıda var mı? (blob hazır olunca asıl sınama canShare({files})) */
export function shareSupported(nav = (typeof navigator !== "undefined" ? navigator : null)) {
  return Boolean(nav && typeof nav.canShare === "function" && typeof nav.share === "function");
}
