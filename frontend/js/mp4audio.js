// Klip (mp4) dosyasından SESİ telefonda ayıklar: görüntü atılır, ses yeniden kodlanmadan yeni bir .m4a'ya konur. Böylece 30 MB sunucu
// sınırı klibin kendisine değil yalnız sesine uygulanır. SAF mantık (Blob/File dışında bağımlılık yok). node tests\mp4audio_test.mjs
//
// Desteklenen: normal (ilerleyen olmayan) MP4/MOV; `moov` başta ya da sonda olabilir. Desteklenmeyen: parçalı (fragmented) MP4, webm/mkv
// (bunlar için `reason` döner, çağıran dosyayı olduğu gibi yüklemeyi dener). Ses örnekleri bayt bayt AYNEN kopyalanır.

export const MOOV_MAX_BYTES = 48 * 1024 * 1024;
export const MAX_CHUNKS = 400000;
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]);

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function put32(value) {
  return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function put64(value) {
  const high = Math.floor(value / 4294967296);
  return new Uint8Array([...put32(high), ...put32(value >>> 0)]);
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
  return concat([put32(8 + payload.length), new TextEncoder().encode(type), payload]);
}

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

const child = (node, type) => (node.children || []).find((item) => item.type === type);

function handlerOf(trak) {
  const hdlr = child(child(trak, "mdia") || { children: [] }, "hdlr");
  return hdlr ? hdlr : null;
}

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Dosyanın en üst düzey kutuları (başlıkları okuyarak; gövdeyi YÜKLEMEDEN). */
async function topLevel(file) {
  const boxes = [];
  let at = 0;
  while (at + 8 <= file.size && boxes.length < 5000) {
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

function serialize(node, bytes, patch) {
  if (patch.has(node)) return patch.get(node);
  if (node.children) {
    return makeBox(node.type, concat(node.children.map((item) => serialize(item, bytes, patch))));
  }
  return bytes.subarray(node.start, node.end);
}

/**
 * Dönen: {ok: true, blob, audioBytes, chunks} ya da {ok: false, reason: "notmp4" | "fragmented" | "noaudio" | "unsupported" | "toolarge"}.
 */
export async function extractAudio(file) {
  const boxes = await topLevel(file);
  if (!boxes.some((box) => box.type === "ftyp") && !boxes.some((box) => box.type === "moov")) return { ok: false, reason: "notmp4" };
  if (boxes.some((box) => box.type === "moof")) return { ok: false, reason: "fragmented" };
  const moovBox = boxes.find((box) => box.type === "moov");
  if (!moovBox) return { ok: false, reason: "notmp4" };
  if (moovBox.len > MOOV_MAX_BYTES) return { ok: false, reason: "toolarge" };
  const moov = await bytesOf(file, moovBox.start, moovBox.start + moovBox.len);
  const root = parseBoxes(moov, 0, moov.length, true)[0];
  if (!root || root.type !== "moov") return { ok: false, reason: "notmp4" };
  if (child(root, "mvex")) return { ok: false, reason: "fragmented" };
  const mvhd = (root.children || []).find((item) => item.type === "mvhd");
  const audio = (root.children || []).filter((item) => item.type === "trak").find((trak) => {
    const hdlr = handlerOf(trak);
    return hdlr && tag(moov, hdlr.start + hdlr.hlen + 8) === "soun";
  });
  if (!mvhd || !audio) return { ok: false, reason: "noaudio" };

  const stbl = child(child(child(audio, "mdia") || { children: [] }, "minf") || { children: [] }, "stbl");
  if (!stbl) return { ok: false, reason: "unsupported" };
  const stsz = child(stbl, "stsz");
  const stsc = child(stbl, "stsc");
  const stco = child(stbl, "stco");
  const co64 = child(stbl, "co64");
  const offsetsBox = stco || co64;
  if (!stsz || !stsc || !offsetsBox) return { ok: false, reason: "unsupported" };

  // örnek boyutları
  const szAt = stsz.start + stsz.hlen + 4;
  const fixedSize = u32(moov, szAt);
  const sampleCount = u32(moov, szAt + 4);
  if (sampleCount === 0) return { ok: false, reason: "fragmented" };
  const sizeOf = (index) => (fixedSize ? fixedSize : u32(moov, szAt + 8 + index * 4));
  if (!fixedSize && szAt + 8 + sampleCount * 4 > stsz.end) return { ok: false, reason: "unsupported" };
  // parça başına örnek sayısı
  const scAt = stsc.start + stsc.hlen + 4;
  const runs = u32(moov, scAt);
  if (scAt + 4 + runs * 12 > stsc.end || runs === 0) return { ok: false, reason: "unsupported" };
  const entries = [];
  for (let i = 0; i < runs; i += 1) entries.push({ first: u32(moov, scAt + 4 + i * 12), per: u32(moov, scAt + 8 + i * 12) });
  // parça ofsetleri
  const wide = offsetsBox.type === "co64";
  const coAt = offsetsBox.start + offsetsBox.hlen + 4;
  const chunkCount = u32(moov, coAt);
  if (chunkCount === 0 || chunkCount > MAX_CHUNKS || coAt + 4 + chunkCount * (wide ? 8 : 4) > offsetsBox.end) return { ok: false, reason: "unsupported" };
  const chunks = [];
  let sample = 0;
  for (let c = 0; c < chunkCount; c += 1) {
    let per = 0;
    for (const run of entries) if (run.first <= c + 1) per = run.per;
    let size = 0;
    for (let k = 0; k < per; k += 1) {
      if (sample >= sampleCount) return { ok: false, reason: "unsupported" };
      size += sizeOf(sample);
      sample += 1;
    }
    const offset = wide ? u64(moov, coAt + 4 + c * 8) : u32(moov, coAt + 4 + c * 4);
    if (offset + size > file.size) return { ok: false, reason: "unsupported" };
    chunks.push({ offset, size });
  }
  if (sample !== sampleCount) return { ok: false, reason: "unsupported" };

  // yeni moov (yalnız ses izi), ofsetler sonradan
  const ftyp = makeBox("ftyp", concat([new TextEncoder().encode("M4A "), put32(0), new TextEncoder().encode("M4A mp42isom")]));
  const audioBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const build = (offsets) => {
    const payload = wide
      ? concat([Uint8Array.of(0, 0, 0, 0), put32(chunkCount), ...offsets.map(put64)])
      : concat([Uint8Array.of(0, 0, 0, 0), put32(chunkCount), ...offsets.map(put32)]);
    const patch = new Map([[offsetsBox, makeBox(offsetsBox.type, payload)]]);
    return makeBox("moov", concat([moov.subarray(mvhd.start, mvhd.end), serialize(audio, moov, patch)]));
  };
  const probe = build(chunks.map(() => 0));
  const base = ftyp.length + probe.length + 8;
  let running = base;
  const offsets = chunks.map((chunk) => {
    const at = running;
    running += chunk.size;
    return at;
  });
  const newMoov = build(offsets);
  if (newMoov.length !== probe.length) return { ok: false, reason: "unsupported" };

  const parts = [ftyp, newMoov, concat([put32(8 + audioBytes), new TextEncoder().encode("mdat")])];
  for (let i = 0; i < chunks.length; i += 200) {
    const batch = chunks.slice(i, i + 200);
    const data = await Promise.all(batch.map((chunk) => bytesOf(file, chunk.offset, chunk.offset + chunk.size)));
    parts.push(...data);
  }
  return { ok: true, blob: new Blob(parts, { type: "audio/mp4" }), audioBytes, chunks: chunks.length };
}

export const REASON_TEXT = {
  notmp4: "Bu dosya MP4 gibi görünmüyor.",
  fragmented: "Bu klip parçalı (streaming) MP4 biçiminde; sesi telefonda ayıklanamıyor.",
  noaudio: "Dosyada ses izi bulunamadı.",
  unsupported: "Bu dosyanın ses yapısı desteklenmiyor.",
  toolarge: "Dosyanın ses tablosu çok büyük.",
};
