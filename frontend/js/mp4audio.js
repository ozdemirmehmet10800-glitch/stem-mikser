// Klip dosyasından SESİ telefonda ayıklar: görüntü atılır, ses YENİDEN KODLANMADAN yeni bir dosyaya konur (mp4/mov -> .m4a,
// webm/mkv -> .webm/.mka). Böylece 30 MB sunucu sınırı klibe değil yalnız sesine uygulanır. SAF mantık (Blob/File dışında bağımlılık yok).
// node tests\mp4audio_test.mjs
//
// Desteklenen: normal ve parçalı (fragmented / streaming) MP4/MOV ("moov" başta ya da sonda), WebM/Matroska (boyutu bilinmeyen Segment ve
// Cluster dahil: tarayıcı kayıtları böyle). Ses baytları AYNEN kopyalanır; büyük veri Blob.slice ile taşınır (bellek şişmez).
// Başlık, sanatçı ve kapak gibi üst veri korunur: sunucu şarkı adını ve kapağı oradan okur. Desteklenmeyen: şifreli (DRM) içerik.
// Desteklenmeyen/bozuk dosyada {ok: false, reason} döner (atmaz); çağıran ne yapacağına karar verir.

export const MOOV_MAX_BYTES = 48 * 1024 * 1024;
export const MOOF_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_CHUNKS = 400000;
const MAX_TOP_BOXES = 400000;
const EBML_WINDOW = 512 * 1024;
const EBML_META_MAX = 4 * 1024 * 1024;
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const s32 = (b, o) => u32(b, o) | 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const utf8 = new TextDecoder("utf-8");
const ascii = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 255);

class Cancelled extends Error {}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new Cancelled("iptal");
}

const fail = (reason) => ({ ok: false, reason });

function put32(value) {
  return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function put64(value) {
  return new Uint8Array([...put32(Math.floor(value / 4294967296)), ...put32(value >>> 0)]);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function makeBox(type, payload) {
  return concat([put32(8 + payload.length), ascii(type), payload]);
}

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Bitişik dilimleri birleştirerek Blob parçaları üretir (dosya baytları KOPYALANMAZ, yalnız başvurulur). */
function sliceParts(file, ranges) {
  const merged = [];
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    const last = merged[merged.length - 1];
    if (last && last[1] === start) last[1] = end;
    else merged.push([start, end]);
  }
  return merged.map(([start, end]) => file.slice(start, end));
}

/**
 * Dönen: {ok: true, blob, ext, mime, audioBytes, chunks, meta: {title, artist, hasCover}}
 *     ya da {ok: false, reason: "notclip" | "fragmented" | "noaudio" | "unsupported" | "toolarge" | "encrypted" | "cancelled"}.
 * Seçenekler: onProgress(0..1), signal (AbortSignal: iptal).
 */
export async function extractAudio(file, { onProgress = () => {}, signal = null } = {}) {
  try {
    if (!file || !(file.size >= 8)) return fail("notclip");
    checkAbort(signal);
    const head = await bytesOf(file, 0, 4);
    const result = u32(head, 0) === 0x1a45dfa3
      ? await extractMatroska(file, onProgress, signal)
      : await extractMp4(file, onProgress, signal);
    if (result.ok) onProgress(1);
    return result;
  } catch (error) {
    if (error instanceof Cancelled) return fail("cancelled");
    return { ok: false, reason: "unsupported", detail: String((error && error.message) || error) };
  }
}

export const REASON_TEXT = {
  notclip: "Bu dosya tanınan bir klip biçiminde değil (mp4, mov, webm, mkv).",
  notmp4: "Bu dosya tanınan bir klip biçiminde değil (mp4, mov, webm, mkv).",
  fragmented: "Bu klibin yapısı okunamadı.",
  noaudio: "Dosyada ses izi bulunamadı.",
  unsupported: "Bu dosyanın ses yapısı desteklenmiyor.",
  toolarge: "Dosyanın ses tablosu çok büyük.",
  encrypted: "Bu klip şifreli (korumalı); sesi ayıklanamaz.",
  cancelled: "Ayıklama iptal edildi.",
};

// ================================================================== MP4 / MOV

/** [start, end) aralığındaki kutular: [{type, start, end, hlen}] (iç içe kapsayıcılar `children` ile). */
function parseBoxes(bytes, start, end, deep = true) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let len = u32(bytes, at);
    const type = tag(bytes, at + 4);
    let hlen = 8;
    if (len === 1) {
      if (at + 16 > end) break;
      len = u64(bytes, at + 8);
      hlen = 16;
    } else if (len === 0) {
      len = end - at;
    }
    if (len < hlen || at + len > end) break;
    const node = { type, start: at, end: at + len, hlen };
    if (deep && CONTAINERS.has(type)) node.children = parseBoxes(bytes, at + hlen, at + len, true);
    out.push(node);
    at += len;
  }
  return out;
}

const child = (node, type) => (node && node.children ? node.children.find((item) => item.type === type) : undefined);
const path = (node, types) => types.reduce((current, type) => child(current, type), node);

/** Dosyanın en üst düzey kutuları (yalnız başlıklar okunur; gövde YÜKLENMEZ). */
async function topLevel(file, signal) {
  const boxes = [];
  let at = 0;
  while (at + 8 <= file.size && boxes.length < MAX_TOP_BOXES) {
    if (boxes.length % 256 === 255) checkAbort(signal);
    const head = await bytesOf(file, at, Math.min(at + 16, file.size));
    let len = u32(head, 0);
    let hlen = 8;
    if (len === 1 && head.length >= 16) {
      len = u64(head, 8);
      hlen = 16;
    } else if (len === 0) {
      len = file.size - at;
    }
    if (len < hlen || at + len > file.size) break;
    boxes.push({ type: tag(head, 4), start: at, len, hlen });
    at += len;
  }
  return boxes;
}

/** Ağacı yeniden yazar: `patch` içindeki düğüm yerine verilen bayt (null = at); dokunulmayan dal ham baytlarıyla AYNEN kopyalanır. */
function serialize(node, bytes, patch) {
  if (patch.has(node)) return patch.get(node) || new Uint8Array(0);
  const touched = (item) => patch.has(item) || Boolean(item.children && item.children.some(touched));
  if (node.children && node.children.some(touched)) {
    return makeBox(node.type, concat(node.children.map((item) => serialize(item, bytes, patch))));
  }
  return bytes.subarray(node.start, node.end);
}

function trakHandler(moov, trak) {
  const hdlr = path(trak, ["mdia", "hdlr"]);
  return hdlr ? tag(moov, hdlr.start + hdlr.hlen + 8) : "";
}

function trakEnabled(moov, trak) {
  const tkhd = child(trak, "tkhd");
  return Boolean(tkhd) && (moov[tkhd.start + tkhd.hlen + 3] & 1) === 1;
}

function trakId(moov, trak) {
  const tkhd = child(trak, "tkhd");
  if (!tkhd) return 0;
  const version = moov[tkhd.start + tkhd.hlen];
  return u32(moov, tkhd.start + tkhd.hlen + 4 + (version === 1 ? 16 : 8));
}

function pickAudioTrak(moov, kids) {
  const sounds = kids.filter((item) => item.type === "trak" && trakHandler(moov, item) === "soun");
  return sounds.find((trak) => trakEnabled(moov, trak)) || sounds[0] || null;
}

function isEncrypted(moov, stbl) {
  const stsd = child(stbl, "stsd");
  if (!stsd) return false;
  return tag(moov, stsd.start + stsd.hlen + 12) === "enca";
}

const META_TEXT = {
  "©nam": "title", "©ART": "artist",
  "com.apple.quicktime.title": "title", "com.apple.quicktime.displayname": "title", "com.apple.quicktime.artist": "artist",
};
const META_COVER = new Set(["covr", "com.apple.quicktime.artwork"]);

/** Başlık/sanatçı/kapak var mı (iTunes tarzı ilst, QuickTime keys+ilst, eski QuickTime udta metni). Hata vermez. */
function readMp4Meta(moov, kids) {
  const meta = { title: "", artist: "", hasCover: false };
  const setText = (key, text) => {
    const value = String(text || "").replace(/\0+$/, "").trim();
    if (value && !meta[key]) meta[key] = value.slice(0, 200);
  };
  const scanMeta = (box) => {
    let first = box.start + box.hlen;
    if (tag(moov, first + 4) !== "hdlr") first += 4;           // ISO 'meta' tam kutu (sürüm+bayrak), QuickTime'ınki değil
    const inner = parseBoxes(moov, first, box.end, false);
    const keysBox = inner.find((item) => item.type === "keys");
    const names = [];
    if (keysBox) {
      const count = u32(moov, keysBox.start + keysBox.hlen + 4);
      let at = keysBox.start + keysBox.hlen + 8;
      for (let i = 0; i < count && at + 8 <= keysBox.end; i += 1) {
        const len = u32(moov, at);
        if (len < 8 || at + len > keysBox.end) break;
        names.push(utf8.decode(moov.subarray(at + 8, at + len)));
        at += len;
      }
    }
    const ilst = inner.find((item) => item.type === "ilst");
    if (!ilst) return;
    for (const item of parseBoxes(moov, ilst.start + ilst.hlen, ilst.end, false)) {
      const name = keysBox ? (names[u32(moov, item.start + 4) - 1] || "") : item.type;
      const data = parseBoxes(moov, item.start + item.hlen, item.end, false).find((box2) => box2.type === "data");
      if (!data || data.end - data.start < data.hlen + 8) continue;
      const kind = u32(moov, data.start + data.hlen) & 0xffffff;
      const value = moov.subarray(data.start + data.hlen + 8, data.end);
      if (META_COVER.has(name)) {
        if (value.length) meta.hasCover = true;
      } else if (META_TEXT[name] && kind === 1) {
        setText(META_TEXT[name], utf8.decode(value));
      }
    }
  };
  try {
    for (const kid of kids) {
      if (kid.type === "meta") scanMeta(kid);
      if (kid.type !== "udta") continue;
      for (const item of parseBoxes(moov, kid.start + kid.hlen, kid.end, false)) {
        if (item.type === "meta") scanMeta(item);
        else if (META_TEXT[item.type] && item.end - item.start > item.hlen + 4) {      // eski QuickTime: uzunluk(2) + dil(2) + metin
          const len = u16(moov, item.start + item.hlen);
          const from = item.start + item.hlen + 4;
          setText(META_TEXT[item.type], utf8.decode(moov.subarray(from, Math.min(item.end, from + len))));
        }
      }
    }
  } catch {
    /* üst veri isteğe bağlı: okunamazsa boş kalır */
  }
  return meta;
}

async function outputFtyp(file, ftypBox) {
  if (ftypBox && ftypBox.len <= 1024) {
    const raw = await bytesOf(file, ftypBox.start, ftypBox.start + ftypBox.len);
    if (tag(raw, ftypBox.hlen) === "qt  ") return raw;            // QuickTime yapıları için kendi markası kalsın
  }
  return makeBox("ftyp", concat([ascii("M4A "), put32(0), ascii("M4A mp42isom")]));
}

async function extractMp4(file, onProgress, signal) {
  const boxes = await topLevel(file, signal);
  const types = new Set(boxes.map((box) => box.type));
  if (!types.has("ftyp") && !types.has("moov")) return fail("notclip");
  const moovBox = boxes.find((box) => box.type === "moov");
  if (!moovBox) return fail("notclip");
  if (moovBox.len > MOOV_MAX_BYTES) return fail("toolarge");
  const moov = await bytesOf(file, moovBox.start, moovBox.start + moovBox.len);
  const root = parseBoxes(moov, 0, moov.length, true)[0];
  if (!root || root.type !== "moov") return fail("notclip");
  const kids = root.children || [];
  const mvhd = kids.find((item) => item.type === "mvhd");
  const audio = pickAudioTrak(moov, kids);
  if (!mvhd || !audio) return fail("noaudio");
  const stbl = path(audio, ["mdia", "minf", "stbl"]);
  if (!stbl) return fail("unsupported");
  if (isEncrypted(moov, stbl)) return fail("encrypted");
  checkAbort(signal);
  onProgress(0.1);
  const ftyp = await outputFtyp(file, boxes.find((box) => box.type === "ftyp"));
  const fragmented = types.has("moof") || kids.some((item) => item.type === "mvex");
  const result = fragmented
    ? await mp4Fragmented({ file, boxes, moov, kids, audio, stbl, ftyp, onProgress, signal })
    : mp4Plain({ file, moov, kids, audio, stbl, ftyp });
  if (!result.ok) return result;
  return { ...result, ext: "m4a", mime: "audio/mp4", meta: readMp4Meta(moov, kids) };
}

/** moov'un yeni hâli: yalnız seçilen ses izi; iods (iz başvurusu) ve ses izinin tref'i (silinen izlere başvurabilir) atılır. */
function rebuildMoov(moov, kids, audio, patch, replace = new Map()) {
  const tref = child(audio, "tref");
  const local = new Map(patch);
  if (tref) local.set(tref, null);
  const body = [];
  for (const kid of kids) {
    if (kid.type === "iods") continue;
    if (kid.type === "trak" && kid !== audio) continue;
    if (replace.has(kid)) body.push(replace.get(kid));
    else body.push(serialize(kid, moov, local));
  }
  return makeBox("moov", concat(body));
}

function mp4Plain({ file, moov, kids, audio, stbl, ftyp }) {
  const stsz = child(stbl, "stsz");
  const stsc = child(stbl, "stsc");
  const offsetsBox = child(stbl, "stco") || child(stbl, "co64");
  if (!stsz || !stsc || !offsetsBox) return fail("unsupported");

  // örnek boyutları
  const szAt = stsz.start + stsz.hlen + 4;
  const fixedSize = u32(moov, szAt);
  const sampleCount = u32(moov, szAt + 4);
  if (sampleCount === 0) return fail("noaudio");
  if (!fixedSize && szAt + 8 + sampleCount * 4 > stsz.end) return fail("unsupported");
  const sizeOf = (index) => (fixedSize || u32(moov, szAt + 8 + index * 4));
  // parça başına örnek sayısı
  const scAt = stsc.start + stsc.hlen + 4;
  const runs = u32(moov, scAt);
  if (runs === 0 || scAt + 4 + runs * 12 > stsc.end) return fail("unsupported");
  const entries = [];
  for (let i = 0; i < runs; i += 1) entries.push({ first: u32(moov, scAt + 4 + i * 12), per: u32(moov, scAt + 8 + i * 12) });
  // parça ofsetleri
  const wide = offsetsBox.type === "co64";
  const coAt = offsetsBox.start + offsetsBox.hlen + 4;
  const chunkCount = u32(moov, coAt);
  if (chunkCount === 0 || chunkCount > MAX_CHUNKS || coAt + 4 + chunkCount * (wide ? 8 : 4) > offsetsBox.end) return fail("unsupported");
  const chunks = [];
  let sample = 0;
  let run = 0;
  for (let c = 0; c < chunkCount; c += 1) {
    while (run + 1 < entries.length && entries[run + 1].first <= c + 1) run += 1;
    const per = entries[run].first <= c + 1 ? entries[run].per : 0;
    let size = 0;
    for (let k = 0; k < per; k += 1) {
      if (sample >= sampleCount) return fail("unsupported");
      size += sizeOf(sample);
      sample += 1;
    }
    const offset = wide ? u64(moov, coAt + 4 + c * 8) : u32(moov, coAt + 4 + c * 4);
    if (offset + size > file.size) return fail("unsupported");
    chunks.push({ offset, size });
  }
  if (sample !== sampleCount) return fail("unsupported");

  // yeni moov; ofsetler önce sıfırla (boyut sabit), sonra gerçek değerle
  const audioBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const build = (offsets) => {
    const payload = concat([Uint8Array.of(0, 0, 0, 0), put32(chunkCount), ...offsets.map(wide ? put64 : put32)]);
    return rebuildMoov(moov, kids, audio, new Map([[offsetsBox, makeBox(offsetsBox.type, payload)]]));
  };
  const probe = build(chunks.map(() => 0));
  let running = ftyp.length + probe.length + 8;
  const offsets = chunks.map((chunk) => {
    const at = running;
    running += chunk.size;
    return at;
  });
  const newMoov = build(offsets);
  if (newMoov.length !== probe.length) return fail("unsupported");
  if (!wide && running > 0xffffffff) return fail("toolarge");

  const parts = [ftyp, newMoov, concat([put32(8 + audioBytes), ascii("mdat")]),
    ...sliceParts(file, chunks.map((chunk) => [chunk.offset, chunk.offset + chunk.size]))];
  return { ok: true, blob: new Blob(parts, { type: "audio/mp4" }), audioBytes, chunks: chunks.length };
}

/**
 * Parçalı MP4 (moov + [moof mdat]...): her moof'tan yalnız ses izinin traf'ı kalır, örnekleri hemen arkasındaki yeni mdat'a konur.
 * tfhd "default-base-is-moof" yapılır, her trun'a veri ofseti yazılır (kaynakta nasıl hesaplanmış olursa olsun aynı baytları gösterir).
 */
async function mp4Fragmented({ file, boxes, moov, kids, audio, stbl, ftyp, onProgress, signal }) {
  const stsz = child(stbl, "stsz");
  if (stsz && u32(moov, stsz.start + stsz.hlen + 8) > 0) return fail("unsupported");     // moov'da da örnek var: karma yapı
  const mvex = kids.find((item) => item.type === "mvex");
  if (!mvex) return fail("unsupported");
  const audioId = trakId(moov, audio);
  const trex = new Map();
  const mvexKids = parseBoxes(moov, mvex.start + mvex.hlen, mvex.end, false);
  for (const item of mvexKids) {
    if (item.type !== "trex") continue;
    const at = item.start + item.hlen + 4;
    trex.set(u32(moov, at), { size: u32(moov, at + 12), raw: moov.subarray(item.start, item.end) });
  }
  if (!trex.has(audioId)) return fail("unsupported");
  const newMvex = makeBox("mvex", concat([
    ...mvexKids.filter((item) => item.type === "mehd").map((item) => moov.subarray(item.start, item.end)),
    trex.get(audioId).raw,
  ]));
  const newMoov = rebuildMoov(moov, kids, audio, new Map(), new Map([[mvex, newMvex]]));

  const parts = [ftyp, newMoov];
  let audioBytes = 0;
  let runCount = 0;
  const moofs = boxes.filter((box) => box.type === "moof");
  for (let index = 0; index < moofs.length; index += 1) {
    const box = moofs[index];
    if (index % 32 === 0) {
      checkAbort(signal);
      onProgress(0.1 + 0.85 * (index / moofs.length));
    }
    if (box.len > MOOF_MAX_BYTES) return fail("toolarge");
    const mb = await bytesOf(file, box.start, box.start + box.len);
    const inner = parseBoxes(mb, box.hlen, mb.length, false);
    const mfhd = inner.find((item) => item.type === "mfhd");
    let prevEnd = box.start;
    let picked = null;
    let trafIndex = 0;
    for (const traf of inner) {
      if (traf.type !== "traf") continue;
      const trafKids = parseBoxes(mb, traf.start + traf.hlen, traf.end, false);
      const tfhd = trafKids.find((item) => item.type === "tfhd");
      if (!tfhd) return fail("unsupported");
      const flags = u32(mb, tfhd.start + tfhd.hlen) & 0xffffff;
      let at = tfhd.start + tfhd.hlen + 4;
      const trackId = u32(mb, at);
      at += 4;
      let base;
      if (flags & 0x1) {
        base = u64(mb, at);
        at += 8;
      } else if (flags & 0x20000) {
        base = box.start;
      } else {
        base = trafIndex === 0 ? box.start : prevEnd;
      }
      if (flags & 0x2) at += 4;
      if (flags & 0x8) at += 4;
      let defaultSize = trex.has(trackId) ? trex.get(trackId).size : 0;
      if (flags & 0x10) defaultSize = u32(mb, at);
      let cursor = base;
      const runs = [];
      for (const trun of trafKids) {
        if (trun.type !== "trun") continue;
        const tf = u32(mb, trun.start + trun.hlen) & 0xffffff;
        let q = trun.start + trun.hlen + 4;
        const count = u32(mb, q);
        q += 4;
        let start = cursor;
        if (tf & 0x1) {
          start = base + s32(mb, q);
          q += 4;
        }
        if (tf & 0x4) q += 4;
        const durationField = tf & 0x100 ? 4 : 0;
        const stride = durationField + (tf & 0x200 ? 4 : 0) + (tf & 0x400 ? 4 : 0) + (tf & 0x800 ? 4 : 0);
        if (q + count * stride > trun.end) return fail("unsupported");
        let size = 0;
        for (let s = 0; s < count; s += 1) size += tf & 0x200 ? u32(mb, q + s * stride + durationField) : defaultSize;
        runs.push({ trun, tf, start, size });
        cursor = start + size;
      }
      prevEnd = cursor;
      trafIndex += 1;
      if (trackId === audioId) picked = { trafKids, tfhd, flags, runs };
    }
    if (!picked || !picked.runs.length) continue;
    for (const run of picked.runs) if (run.start < 0 || run.start + run.size > file.size) return fail("unsupported");

    const tfhdBody = mb.subarray(picked.tfhd.start + picked.tfhd.hlen, picked.tfhd.end);
    const newFlags = (picked.flags & ~0x1) | 0x20000;
    const newTfhd = makeBox("tfhd", concat([
      Uint8Array.of(tfhdBody[0], (newFlags >> 16) & 255, (newFlags >> 8) & 255, newFlags & 255),
      tfhdBody.subarray(4, 8),
      tfhdBody.subarray(picked.flags & 0x1 ? 16 : 8),
    ]));
    const buildMoof = (offsets) => {
      const trafParts = [];
      let runIndex = 0;
      for (const item of picked.trafKids) {
        if (item.type === "tfhd") {
          trafParts.push(newTfhd);
        } else if (item.type === "trun") {
          const run = picked.runs[runIndex];
          const body = mb.subarray(item.start + item.hlen, item.end);
          const f = run.tf | 0x1;
          trafParts.push(makeBox("trun", concat([
            Uint8Array.of(body[0], (f >> 16) & 255, (f >> 8) & 255, f & 255),
            body.subarray(4, 8),
            put32(offsets[runIndex] >>> 0),
            body.subarray(run.tf & 0x1 ? 12 : 8),
          ])));
          runIndex += 1;
        } else if (!["saio", "saiz", "senc"].includes(item.type)) {
          trafParts.push(mb.subarray(item.start, item.end));
        }
      }
      return makeBox("moof", concat([mfhd ? mb.subarray(mfhd.start, mfhd.end) : new Uint8Array(0), makeBox("traf", concat(trafParts))]));
    };
    const probe = buildMoof(picked.runs.map(() => 0));
    let running = probe.length + 8;
    const offsets = picked.runs.map((run) => {
      const at = running;
      running += run.size;
      return at;
    });
    const moof = buildMoof(offsets);
    const total = picked.runs.reduce((sum, run) => sum + run.size, 0);
    parts.push(moof, concat([put32(8 + total), ascii("mdat")]), ...sliceParts(file, picked.runs.map((run) => [run.start, run.start + run.size])));
    audioBytes += total;
    runCount += picked.runs.length;
  }
  if (!runCount) return fail("noaudio");
  return { ok: true, blob: new Blob(parts, { type: "audio/mp4" }), audioBytes, chunks: runCount };
}

// ================================================================== WebM / Matroska (EBML)

const EBML_ID = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TAGS = 0x1254c367;
const ATTACHMENTS = 0x1941a469;
// Cluster'ın olası çocukları: boyutu bilinmeyen Cluster bunlardan biri OLMAYAN ilk öğede biter.
const CLUSTER_CHILDREN = new Set([0xe7, 0x5854, 0xa7, 0xab, 0xa3, 0xa0, 0xaf, 0xec, 0xbf]);

/** EBML değişken uzunluklu tamsayı. keepMarker: kimlik (ID) okunurken işaret biti korunur. */
function vint(buf, at, keepMarker) {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len += 1;
  if (at + len > buf.length) return null;
  const mask = 0xff >> len;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < len; i += 1) {
    value = value * 256 + buf[at + i];
    if (buf[at + i] !== 255) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function sizeVint8(value) {
  return Uint8Array.of(0x01, ...put64(value).subarray(1));
}

const idBytes = (id) => {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return Uint8Array.from(out);
};

function* ebmlChildren(buf, start, end) {
  let at = start;
  while (at < end) {
    const id = vint(buf, at, true);
    if (!id || id.len > 4) return;
    const size = vint(buf, at + id.len, false);
    if (!size) return;
    const dataStart = at + id.len + size.len;
    if (dataStart > end) return;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    yield { id: id.value, start: at, dataStart, end: dataEnd };
    at = dataEnd;
  }
}

const ebmlUint = (buf, el) => {
  let value = 0;
  for (let i = el.dataStart; i < el.end; i += 1) value = value * 256 + buf[i];
  return value;
};
const ebmlText = (buf, el) => utf8.decode(buf.subarray(el.dataStart, el.end)).replace(/\0+$/, "");

class WindowReader {
  constructor(file) {
    this.file = file;
    this.base = 0;
    this.buf = new Uint8Array(0);
  }

  /** `pos`tan en az `need` bayt (dosya sonuna kadar) arabellekte olsun; arabellekteki konumu döner. */
  async at(pos, need) {
    if (pos >= this.base && pos + need <= this.base + this.buf.length) return pos - this.base;
    const end = Math.min(this.file.size, pos + Math.max(need, EBML_WINDOW));
    this.buf = await bytesOf(this.file, pos, end);
    this.base = pos;
    return 0;
  }

  async header(pos) {
    if (pos + 2 > this.file.size) return null;
    const o = await this.at(pos, 12);
    const id = vint(this.buf, o, true);
    if (!id || id.len > 4) return null;
    const size = vint(this.buf, o + id.len, false);
    if (!size) return null;
    return { id: id.value, start: pos, dataStart: pos + id.len + size.len, size: size.unknown ? -1 : size.value };
  }

  /** Blok başı: iz numarası + Cluster'a göre zaman (int16). */
  async block(dataStart) {
    if (dataStart >= this.file.size) return { track: -1, rel: 0 };
    const o = await this.at(dataStart, 12);
    const number = vint(this.buf, o, false);
    if (!number || o + number.len + 2 > this.buf.length) return { track: -1, rel: 0 };
    const raw = u16(this.buf, o + number.len);
    return { track: number.value, rel: raw >= 0x8000 ? raw - 0x10000 : raw };
  }

  async uint(start, end) {
    if (end - start > 8) return 0;
    const o = await this.at(start, end - start);
    let value = 0;
    for (let i = 0; i < end - start; i += 1) value = value * 256 + this.buf[o + i];
    return value;
  }
}

function float64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function pickMkvTrack(bytes, start, end) {
  const candidates = [];
  for (const entry of ebmlChildren(bytes, start, end)) {
    if (entry.id !== 0xae) continue;
    const track = { number: 0, type: 0, codec: "", isDefault: true, enabled: true, encrypted: false, raw: bytes.subarray(entry.start, entry.end) };
    for (const item of ebmlChildren(bytes, entry.dataStart, entry.end)) {
      if (item.id === 0xd7) track.number = ebmlUint(bytes, item);
      else if (item.id === 0x83) track.type = ebmlUint(bytes, item);
      else if (item.id === 0x86) track.codec = ebmlText(bytes, item);
      else if (item.id === 0x88) track.isDefault = ebmlUint(bytes, item) !== 0;
      else if (item.id === 0xb9) track.enabled = ebmlUint(bytes, item) !== 0;
      else if (item.id === 0x6d80) {
        for (const encoding of ebmlChildren(bytes, item.dataStart, item.end)) {
          for (const part of ebmlChildren(bytes, encoding.dataStart, encoding.end)) if (part.id === 0x5035) track.encrypted = true;
        }
      }
    }
    if (track.type === 2 && track.number > 0) candidates.push(track);
  }
  const usable = candidates.filter((track) => track.enabled);
  return usable.find((track) => track.isDefault) || usable[0] || candidates[0] || null;
}

function readMkvTags(bytes, meta) {
  const walk = (start, end) => {
    for (const el of ebmlChildren(bytes, start, end)) {
      if (el.id === 0x7373) walk(el.dataStart, el.end);
      if (el.id !== 0x67c8) continue;
      let name = "";
      let value = "";
      for (const item of ebmlChildren(bytes, el.dataStart, el.end)) {
        if (item.id === 0x45a3) name = ebmlText(bytes, item).toUpperCase();
        else if (item.id === 0x4487) value = ebmlText(bytes, item).trim();
      }
      if (name === "TITLE" && value && !meta.title) meta.title = value.slice(0, 200);
      if (name === "ARTIST" && value && !meta.artist) meta.artist = value.slice(0, 200);
      walk(el.dataStart, el.end);                // iç içe SimpleTag
    }
  };
  walk(0, bytes.length);
}

function hasImageAttachment(bytes) {
  for (const file of ebmlChildren(bytes, 0, bytes.length)) {
    if (file.id !== 0x61a7) continue;
    for (const item of ebmlChildren(bytes, file.dataStart, file.end)) {
      if (item.id === 0x4660 && /^image\//i.test(ebmlText(bytes, item))) return true;
    }
  }
  return false;
}

async function readCluster(reader, el, segEnd, audioNumber) {
  const end = el.size < 0 ? segEnd : Math.min(segEnd, el.dataStart + el.size);
  const kept = [];
  let timecode = null;
  let clusterTime = 0;
  let lastTime = -Infinity;
  let blocks = 0;
  let at = el.dataStart;
  const keepIfAudio = async (blockStart, range) => {
    const info = await reader.block(blockStart);
    if (info.track !== audioNumber) return false;
    kept.push(range);
    blocks += 1;
    lastTime = Math.max(lastTime, clusterTime + info.rel);
    return true;
  };
  while (at + 2 <= end) {
    const item = await reader.header(at);
    if (!item) {
      at = end;
      break;
    }
    if (el.size < 0 && !CLUSTER_CHILDREN.has(item.id)) break;           // boyutu bilinmeyen Cluster burada biter
    if (item.size < 0) {
      at = end;
      break;
    }
    const itemEnd = item.dataStart + item.size;
    if (itemEnd > reader.file.size) {                                  // kesik dosya: eldeki tam bloklar kalır
      at = reader.file.size;
      break;
    }
    if (item.id === 0xe7) {
      timecode = [at, itemEnd];
      clusterTime = await reader.uint(item.dataStart, itemEnd);
    } else if (item.id === 0xa3) {
      await keepIfAudio(item.dataStart, [at, itemEnd]);
    } else if (item.id === 0xa0) {
      let inner = item.dataStart;
      while (inner + 2 <= itemEnd) {
        const part = await reader.header(inner);
        if (!part || part.size < 0) break;
        if (part.id === 0xa1) {
          await keepIfAudio(part.dataStart, [at, itemEnd]);
          break;
        }
        inner = part.dataStart + part.size;
      }
    }
    at = itemEnd;
  }
  if (!kept.length) return { next: at, parts: null, blocks: 0, bytes: 0, lastTime };
  const slices = sliceParts(reader.file, timecode ? [timecode, ...kept] : kept);
  const size = slices.reduce((sum, part) => sum + part.size, 0);
  return { next: at, parts: [concat([idBytes(CLUSTER), sizeVint8(size)]), ...slices], blocks, bytes: size, lastTime };
}

/**
 * Info'da süre (Duration) yoksa ekler: tarayıcı kayıtları (MediaRecorder) yazmaz, sunucu da süresiz dosyayı "bozuk" sayar. Süre son ses
 * bloğunun zamanı + bir ses çerçevesi (20 ms) olarak, Info'nun zaman ölçeğinde (TimecodeScale, yoksa 1 ms) yazılır.
 */
function infoWithDuration(bytes, lastTime) {
  let scale = 1000000;
  let hasDuration = false;
  const kids = [...ebmlChildren(bytes, 0, bytes.length)];
  for (const item of kids) {
    if (item.id === 0x2ad7b1) scale = ebmlUint(bytes, item) || 1000000;
    if (item.id === 0x4489) hasDuration = true;
  }
  if (hasDuration || !Number.isFinite(lastTime) || lastTime < 0) return null;
  const duration = lastTime + 20000000 / scale;
  return concat([idBytes(INFO), sizeVint8(bytes.length + 11), bytes, Uint8Array.of(0x44, 0x89, 0x88), float64(duration)]);
}

async function extractMatroska(file, onProgress, signal) {
  const reader = new WindowReader(file);
  const head = await reader.header(0);
  if (!head || head.id !== EBML_ID || head.size < 0 || head.dataStart + head.size > file.size) return fail("notclip");
  const headEnd = head.dataStart + head.size;
  const headBytes = await bytesOf(file, 0, headEnd);
  let docType = "matroska";
  for (const el of ebmlChildren(headBytes, head.dataStart, headEnd)) if (el.id === 0x4282) docType = ebmlText(headBytes, el);

  let pos = headEnd;
  let segment = null;
  while (pos + 2 <= file.size) {
    const el = await reader.header(pos);
    if (!el) break;
    if (el.id === SEGMENT) {
      segment = el;
      break;
    }
    if (el.size < 0) break;
    pos = el.dataStart + el.size;
  }
  if (!segment) return fail("notclip");
  const segEnd = segment.size < 0 ? file.size : Math.min(file.size, segment.dataStart + segment.size);

  const meta = { title: "", artist: "", hasCover: false };
  let info = null;
  let infoBytes = null;
  let track = null;
  const extras = [];
  const clusters = [];
  let blocks = 0;
  let audioBytes = 0;
  let lastTime = -Infinity;
  let reported = 0;
  pos = segment.dataStart;
  while (pos + 2 <= segEnd) {
    checkAbort(signal);
    if (pos - reported > 4 * 1024 * 1024) {
      reported = pos;
      onProgress(0.05 + 0.9 * (pos / file.size));
    }
    const el = await reader.header(pos);
    if (!el) break;
    if (el.id === CLUSTER) {
      if (!track) return fail("unsupported");
      const out = await readCluster(reader, el, segEnd, track.number);
      if (out.parts) {
        clusters.push(...out.parts);
        blocks += out.blocks;
        audioBytes += out.bytes;
        lastTime = Math.max(lastTime, out.lastTime);
      }
      if (out.next <= pos) break;
      pos = out.next;
      continue;
    }
    if (el.size < 0) break;
    const end = el.dataStart + el.size;
    if (end > file.size) break;
    if (el.id === INFO && el.size <= EBML_META_MAX) {
      info = [pos, end];
      const bytes = await bytesOf(file, el.dataStart, end);
      infoBytes = bytes;
      for (const item of ebmlChildren(bytes, 0, bytes.length)) {
        if (item.id === 0x7ba9 && !meta.title) meta.title = ebmlText(bytes, item).trim().slice(0, 200);
      }
    } else if (el.id === TRACKS) {
      if (el.size > EBML_META_MAX) return fail("unsupported");
      const bytes = await bytesOf(file, el.dataStart, end);
      track = pickMkvTrack(bytes, 0, bytes.length);
      if (!track) return fail("noaudio");
      if (track.encrypted) return fail("encrypted");
    } else if (el.id === TAGS && el.size <= EBML_META_MAX) {
      extras.push([pos, end]);
      readMkvTags(await bytesOf(file, el.dataStart, end), meta);
    } else if (el.id === ATTACHMENTS && el.size <= ATTACH_MAX_BYTES) {
      extras.push([pos, end]);
      if (hasImageAttachment(await bytesOf(file, el.dataStart, end))) meta.hasCover = true;
    }
    pos = end;
  }
  if (!track || !blocks) return fail("noaudio");

  // Yeni Segment: Info + yalnız ses izi + etiket/ekler (Cluster'lardan ÖNCE: okuyucular SeekHead olmadan da görsün) + ses Cluster'ları.
  // SeekHead/Cues/Chapters atılır (eski konumları gösterirler).
  const fixedInfo = infoBytes ? infoWithDuration(infoBytes, lastTime) : null;
  const body = [
    ...(fixedInfo ? [fixedInfo] : info ? [file.slice(info[0], info[1])] : []),
    concat([idBytes(TRACKS), sizeVint8(track.raw.length), track.raw]),
    ...extras.map(([start, end]) => file.slice(start, end)),
    ...clusters,
  ];
  const bodySize = body.reduce((sum, part) => sum + (part.size !== undefined ? part.size : part.length), 0);
  const webm = docType === "webm" && /^A_(OPUS|VORBIS)$/.test(track.codec);
  const mime = webm ? "audio/webm" : "audio/x-matroska";
  const blob = new Blob([headBytes, concat([idBytes(SEGMENT), sizeVint8(bodySize)]), ...body], { type: mime });
  return { ok: true, blob, ext: webm ? "webm" : "mka", mime, audioBytes, chunks: blocks, meta };
}
