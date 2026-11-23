// Çevrimdışı kopyaların şarkı başına dökümü + tanı raporu metni: SAF mantık. node tests\cachelist_test.mjs

/** index: stemcache indeksi {anahtar: {songId, size}} -> [{songId, bytes, files}] (büyükten küçüğe). */
export function summarizeBySong(index) {
  const map = new Map();
  for (const item of Object.values(index || {})) {
    if (!item || typeof item.songId !== "string") continue;
    const row = map.get(item.songId) || { songId: item.songId, bytes: 0, files: 0 };
    row.bytes += Number(item.size) || 0;
    row.files += 1;
    map.set(item.songId, row);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes || a.songId.localeCompare(b.songId));
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Tanı raporu: "başlık: değer" satırları. SIR YOK: token, API adresi, söz/çeviri metni, mikrofon verisi girmez; çağıran yalnız
 * sayı ve durum verir. sections: [[başlık, [satır...]], ...]
 */
export function buildReport(sections) {
  const lines = [];
  for (const [title, rows] of sections) {
    const clean = (rows || []).filter((row) => row !== null && row !== undefined && row !== "");
    if (!clean.length) continue;
    lines.push(`== ${title} ==`, ...clean.map(String));
  }
  return lines.join("\n");
}
