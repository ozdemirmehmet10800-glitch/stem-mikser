// Kapak yedeği (yalnız senin seçtiğin / onayladığın kapaklar): SAF mantık. node tests\coverbackup_test.mjs
// Biçim: {v:1, kind:"stem-mikser-covers", exported, covers:{ "<şarkı kimliği>": {source:"user"|"found"|"clip", mime, data:<base64>} }}.
// Dosyadan gelen "gömülü" kapaklar yedeğe GİRMEZ (sunucudan yeniden istenir). Yükleme BİRLEŞTİRİR: şarkıda zaten senin kapağın varsa dokunmaz.

export const BACKUP_KIND = "stem-mikser-covers";
export const BACKUP_MAX_BYTES = 16 * 1024 * 1024;
export const COVER_B64_MAX = 260 * 1024;      // tek kapak (küçültülmüş ~30-60 KB); bunun üstü reddedilir
export const BACKUP_MAX_COVERS = 400;
const ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
const MIME_RE = /^image\/(jpeg|png|webp|gif)$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** entries: [{id, source, mime, data}] -> JSON metni. Yalnız user/found/clip alınır. */
export function encodeBackup(entries, now = Date.now()) {
  const covers = {};
  for (const entry of entries) {
    if (!entry || !ID_RE.test(entry.id) || !["user", "found", "clip"].includes(entry.source)) continue;
    if (!MIME_RE.test(entry.mime) || !B64_RE.test(entry.data) || entry.data.length > COVER_B64_MAX) continue;
    covers[entry.id] = { source: entry.source, mime: entry.mime, data: entry.data };
  }
  return JSON.stringify({ v: 1, kind: BACKUP_KIND, exported: new Date(now).toISOString(), covers });
}

/** Dönen {ok, entries:[{id, source, mime, data}], skipped} ya da {ok:false, error: "size"|"json"|"format"}. */
export function parseBackup(text) {
  if (typeof text !== "string" || text.length > BACKUP_MAX_BYTES) return { ok: false, error: "size" };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "json" };
  }
  if (!data || typeof data !== "object" || data.v !== 1 || data.kind !== BACKUP_KIND || !data.covers || typeof data.covers !== "object" || Array.isArray(data.covers)) {
    return { ok: false, error: "format" };
  }
  const entries = [];
  let skipped = 0;
  for (const [id, item] of Object.entries(data.covers)) {
    const good = ID_RE.test(id) && item && typeof item === "object" && ["user", "found", "clip"].includes(item.source)
      && MIME_RE.test(item.mime) && typeof item.data === "string" && B64_RE.test(item.data) && item.data.length <= COVER_B64_MAX;
    if (!good || entries.length >= BACKUP_MAX_COVERS) {
      skipped += 1;
      continue;
    }
    entries.push({ id, source: item.source, mime: item.mime, data: item.data });
  }
  return { ok: true, entries, skipped };
}
