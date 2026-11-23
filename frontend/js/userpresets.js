// Kendi mikser ön ayarların + şarkı başına ADLI A-B döngüleri: SAF mantık, depolama dışarıdan. node tests\userpresets_test.mjs
//
// Ön ayar: kanal adlarına göre fader/mute/solo/pan/EQ/yankı gönderimi (+ ortak oda varsa). Ana ses'e dokunmaz. Başka şarkıda olmayan kanal adları
// atlanır. Tek anahtar `stem-mikser.mixpresets` (en çok 12). Adlı döngüler şarkı kimliğine bağlı: `stem-mikser.loops.<kimlik>` (en çok 12).

export const PRESETS_KEY = "stem-mikser.mixpresets";
export const LOOPS_PREFIX = "stem-mikser.loops.";
export const PRESET_LIMIT = 12;
export const LOOP_LIMIT = 12;
export const NAME_MAX = 16;
export const MIN_LOOP_SECONDS = 0.5;
const SONG_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;

export function cleanName(raw) {
  return String(raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, NAME_MAX).trim();
}

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function cleanStem(entry) {
  if (!entry || typeof entry !== "object") return null;
  const eq = Array.isArray(entry.eq) ? entry.eq.slice(0, 3).map((value) => Math.min(Math.max(num(value), -12), 12)) : [0, 0, 0];
  while (eq.length < 3) eq.push(0);
  return {
    fader: Math.min(Math.max(num(entry.fader, 100), 0), 150), mute: entry.mute === true, solo: entry.solo === true,
    pan: Math.min(Math.max(num(entry.pan), -1), 1), eq, send: Math.min(Math.max(num(entry.send), 0), 1),
  };
}

// ---------------------------------------------------------------- ön ayarlar

export function readPresets(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(PRESETS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      const name = cleanName(item.name);
      if (!name || !item.stems || typeof item.stems !== "object") continue;
      const stems = {};
      for (const [stem, entry] of Object.entries(item.stems)) {
        const clean = cleanStem(entry);
        if (clean && /^[0-9A-Za-z_-]{1,24}$/.test(stem)) stems[stem] = clean;
      }
      if (Object.keys(stems).length) out.push({ id: item.id, name, stems, room: item.room && typeof item.room === "object" ? item.room : null });
      if (out.length >= PRESET_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function writePresets(storage, list) {
  try {
    storage.setItem(PRESETS_KEY, JSON.stringify(list.slice(0, PRESET_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/** states: Map ad -> {fader, mute, solo, pan, eq, send} (mixmemory.snapshot). room: ortak oda ya da null (varsayılansa null ver). */
export function makePreset(name, states, room, id) {
  const clean = cleanName(name);
  if (!clean) return null;
  const stems = {};
  for (const [stem, entry] of states) {
    const value = cleanStem(entry);
    if (value) stems[stem] = value;
  }
  return Object.keys(stems).length ? { id, name: clean, stems, room: room || null } : null;
}

/** Ekler; aynı ad (büyük-küçük farksız) varsa ÜSTÜNE yazar. Dönen {list, error?}: "limit" | "empty". */
export function addPreset(list, preset) {
  if (!preset) return { list, error: "empty" };
  const key = preset.name.toLocaleLowerCase("tr");
  const at = list.findIndex((item) => item.name.toLocaleLowerCase("tr") === key);
  if (at >= 0) {
    const next = [...list];
    next[at] = { ...preset, id: list[at].id };
    return { list: next, replaced: true };
  }
  if (list.length >= PRESET_LIMIT) return { list, error: "limit" };
  return { list: [...list, preset] };
}

export function removePreset(list, id) {
  return list.filter((item) => item.id !== id);
}

/** mixmemory.normalizeRecord'un anladığı ham kayıt (ana ses ZORUNLU değer: verilen). */
export function presetRecord(preset, master = 100) {
  return { v: 1, savedAt: 0, master, stems: preset.stems, ...(preset.room ? { room: preset.room } : {}) };
}

// ------------------------------------------------------------------ adlı döngüler

export const loopsKey = (songId) => LOOPS_PREFIX + songId;

export function readLoops(storage, songId) {
  if (!SONG_ID_RE.test(String(songId))) return [];
  try {
    const parsed = JSON.parse(storage.getItem(loopsKey(songId)) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === "string" && Number.isFinite(item.a) && Number.isFinite(item.b) && item.a >= 0 && item.b - item.a >= MIN_LOOP_SECONDS)
      .map((item) => ({ id: item.id, name: cleanName(item.name) || "Döngü", a: item.a, b: item.b }))
      .slice(0, LOOP_LIMIT);
  } catch {
    return [];
  }
}

export function writeLoops(storage, songId, list) {
  if (!SONG_ID_RE.test(String(songId))) return false;
  try {
    if (!list.length) storage.removeItem(loopsKey(songId));
    else storage.setItem(loopsKey(songId), JSON.stringify(list.slice(0, LOOP_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/** Döngü ekler. Ad boşsa "Döngü N". Dönen {list, error?}: "short" | "limit" | "range". */
export function addLoop(list, { name, a, b }, id, duration = Infinity) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > duration + 0.01) return { list, error: "range" };
  if (b - a < MIN_LOOP_SECONDS) return { list, error: "short" };
  if (list.length >= LOOP_LIMIT) return { list, error: "limit" };
  const label = cleanName(name) || `Döngü ${list.length + 1}`;
  return { list: [...list, { id, name: label, a: Math.round(a * 100) / 100, b: Math.round(b * 100) / 100 }] };
}

export function removeLoop(list, id) {
  return list.filter((item) => item.id !== id);
}

/** Silinen şarkıların adlı döngüleri (yalnız kendi anahtarları). */
export function dropLoops(storage, songIds) {
  for (const id of songIds) {
    if (!SONG_ID_RE.test(String(id))) continue;
    try { storage.removeItem(loopsKey(id)); } catch { /* yok say */ }
  }
}
