// Klipten ses ayıklama (js/mp4audio.js): SENTETİK mp4 / parçalı mp4 / webm (video + ses izleri iç içe), çıktı bağımsız çözümlenir.
// Gerçek kodlayıcı çıktıları için ayrıca: tests/clip_fixtures_test.mjs.   node tests\mp4audio_test.mjs

import { extractAudio, REASON_TEXT } from "../frontend/js/mp4audio.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const enc = new TextEncoder();
const be16 = (v) => Uint8Array.of((v >>> 8) & 255, v & 255);
const be32 = (v) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const be64 = (v) => new Uint8Array([...be32(Math.floor(v / 4294967296)), ...be32(v >>> 0)]);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const latin = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));
const box = (type, ...payload) => { const body = cat(...payload); return cat(be32(8 + body.length), latin(type), body); };
const full = (type, version, ...payload) => box(type, Uint8Array.of(version, 0, 0, 0), ...payload);
const fullF = (type, flags, ...payload) => box(type, Uint8Array.of(0, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const blobOf = (bytes) => new Blob([bytes]);
const readAll = async (blob) => new Uint8Array(await blob.arrayBuffer());

const tkhd = (id, enabled = true) => fullF("tkhd", enabled ? 3 : 0, new Uint8Array(8), be32(id), new Uint8Array(68));
const hdlr = (kind) => full("hdlr", 0, be32(0), latin(kind), new Uint8Array(12), latin("x\0"));
const ilst = ({ title, artist, cover }) => box("udta", full("meta", 0, hdlr("mdir"), box("ilst",
  ...(title ? [box("©nam", box("data", be32(1), be32(0), enc.encode(title)))] : []),
  ...(artist ? [box("©ART", box("data", be32(1), be32(0), enc.encode(artist)))] : []),
  ...(cover ? [box("covr", box("data", be32(13), be32(0), new Uint8Array(30).fill(0xff)))] : []))));

// ------------------------------------------------------------------ normal mp4: iki iz, mdat'ta parçalar İÇ İÇE: V A V A A V
function makeMp4({ moovFirst = false, wide = false, fixedSampleSize = 0, fragmented = false, noAudio = false, metaBox = null, extras = false } = {}) {
  const videoChunks = [new Uint8Array(500).fill(0x11), new Uint8Array(700).fill(0x12), new Uint8Array(300).fill(0x13)];
  const audioSamples = Array.from({ length: 9 }, (_, i) => new Uint8Array(fixedSampleSize || 40 + i * 5).fill(0xa0 + i));
  const audioGroups = [audioSamples.slice(0, 3), audioSamples.slice(3, 7), audioSamples.slice(7, 9)];      // [3], [4], [2] örnek
  const audioChunkBytes = audioGroups.map((g) => cat(...g));
  const order = [["v", 0], ["a", 0], ["v", 1], ["a", 1], ["a", 2], ["v", 2]];
  const ftyp = box("ftyp", latin("isom"), be32(0), latin("isomiso2mp41"));
  const mdat = box("mdat", cat(...order.map(([kind, i]) => (kind === "v" ? videoChunks[i] : audioChunkBytes[i]))));
  function buildMoov(audioOffsets, videoOffsets = [0, 0, 0]) {
    const stco = (offs) => (wide ? full("co64", 0, be32(offs.length), ...offs.map(be64)) : full("stco", 0, be32(offs.length), ...offs.map(be32)));
    const stsz = fixedSampleSize
      ? full("stsz", 0, be32(fixedSampleSize), be32(9))
      : full("stsz", 0, be32(0), be32(9), ...audioSamples.map((s) => be32(s.length)));
    const audioStbl = box("stbl", full("stsd", 0, be32(1), box("mp4a", new Uint8Array(28))), full("stts", 0, be32(1), be32(9), be32(1024)),
      full("stsc", 0, be32(3), be32(1), be32(3), be32(1), be32(2), be32(4), be32(1), be32(3), be32(2), be32(1)), stsz, stco(audioOffsets));
    const videoStbl = box("stbl", full("stsd", 0, be32(1), box("avc1", new Uint8Array(78))), full("stts", 0, be32(1), be32(3), be32(1000)),
      full("stsc", 0, be32(1), be32(1), be32(1), be32(1)), full("stsz", 0, be32(0), be32(3), be32(500), be32(700), be32(300)), stco(videoOffsets));
    const trak = (id, kind, stbl) => box("trak", tkhd(id), ...(extras && kind === "soun" ? [box("tref", box("chap", be32(9)))] : []),
      box("edts", full("elst", 0, be32(0))),
      box("mdia", full("mdhd", 0, new Uint8Array(20)), hdlr(kind), box("minf", box("dinf", full("dref", 0, be32(0))), stbl)));
    const mvex = fragmented ? box("mvex", full("trex", 0, new Uint8Array(20))) : new Uint8Array(0);
    return box("moov", full("mvhd", 0, new Uint8Array(96)), ...(extras ? [full("iods", 0, new Uint8Array(8))] : []),
      trak(1, "vide", videoStbl), ...(noAudio ? [] : [trak(2, "soun", audioStbl)]), mvex, ...(metaBox ? [metaBox] : []));
  }
  const mdatStart = (moovFirst ? ftyp.length + buildMoov([0, 0, 0]).length : ftyp.length) + 8;
  let at = mdatStart;
  const placed = { v: [], a: [] };
  for (const [kind, i] of order) {
    placed[kind][i] = at;
    at += (kind === "v" ? videoChunks[i] : audioChunkBytes[i]).length;
  }
  const moov = buildMoov(placed.a, placed.v);
  const bytes = moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
  return { bytes, audioPayload: cat(...audioChunkBytes), chunkLens: audioChunkBytes.map((c) => c.length) };
}

// bağımsız mp4 okuyucu (testin kendi kodu)
function boxesIn(bytes, from, to) {
  const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const out = [];
  for (let o = from; o + 8 <= to;) {
    const len = u32(o);
    if (len < 8) break;
    out.push({ o, len, type: String.fromCharCode(...bytes.subarray(o + 4, o + 8)) });
    o += len;
  }
  return out;
}
const U32 = (bytes, o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
const deepFind = (bytes, node, pathTypes) => {
  let cur = node;
  for (const type of pathTypes) {
    cur = boxesIn(bytes, cur.o + 8, cur.o + cur.len).find((b) => b.type === type);
    if (!cur) return null;
  }
  return cur;
};

function inspectPlain(out) {
  const top = boxesIn(out, 0, out.length);
  const moov = top.find((b) => b.type === "moov");
  const moovKids = boxesIn(out, moov.o + 8, moov.o + moov.len);
  const traks = moovKids.filter((b) => b.type === "trak");
  const trak = traks[0];
  const handler = (() => { const h = deepFind(out, trak, ["mdia", "hdlr"]); return String.fromCharCode(...out.subarray(h.o + 16, h.o + 20)); })();
  const stbl = deepFind(out, trak, ["mdia", "minf", "stbl"]);
  const stblKids = boxesIn(out, stbl.o + 8, stbl.o + stbl.len);
  const co = stblKids.find((b) => b.type === "stco" || b.type === "co64");
  const wide = co.type === "co64";
  const count = U32(out, co.o + 12);
  const offsets = Array.from({ length: count }, (_, i) => (wide ? U32(out, co.o + 16 + i * 8) * 4294967296 + U32(out, co.o + 20 + i * 8) : U32(out, co.o + 16 + i * 4)));
  return { top: top.map((b) => b.type), moovKids: moovKids.map((b) => b.type), trakKids: boxesIn(out, trak.o + 8, trak.o + trak.len).map((b) => b.type), trakCount: traks.length, handler, offsets, wide };
}

for (const variant of [{ name: "moov sonda", opts: {} }, { name: "moov başta", opts: { moovFirst: true } }, { name: "64-bit ofset (co64)", opts: { wide: true } }, { name: "sabit örnek boyutu", opts: { fixedSampleSize: 64 } }]) {
  const made = makeMp4(variant.opts);
  const result = await extractAudio(blobOf(made.bytes));
  check(`${variant.name}: ayıklanır (m4a)`, result.ok === true && result.chunks === 3 && result.ext === "m4a" && result.mime === "audio/mp4", JSON.stringify({ ok: result.ok, reason: result.reason, detail: result.detail }));
  if (!result.ok) continue;
  const out = await readAll(result.blob);
  const info = inspectPlain(out);
  check(`${variant.name}: çıktı ftyp + moov + mdat, tek iz, ses (soun)`, info.top.join() === "ftyp,moov,mdat" && info.trakCount === 1 && info.handler === "soun", JSON.stringify(info.top));
  const joined = cat(...info.offsets.map((o, i) => out.subarray(o, o + made.chunkLens[i])));
  check(`${variant.name}: ses baytları AYNEN ve ofsetler doğru`, equal(joined, made.audioPayload) && info.wide === Boolean(variant.opts.wide));
  check(`${variant.name}: çıktı videodan çok küçük (video baytı yok)`, out.length < made.bytes.length - 1400);
}

{
  const made = makeMp4({ extras: true, metaBox: ilst({ title: "Deneme Şarkı", artist: "Örnek Grup", cover: true }) });
  const result = await extractAudio(blobOf(made.bytes));
  check("üst veri: başlık/sanatçı/kapak okunur (Türkçe karakter dahil)", result.ok && result.meta.title === "Deneme Şarkı" && result.meta.artist === "Örnek Grup" && result.meta.hasCover === true, JSON.stringify(result.meta));
  const info = inspectPlain(await readAll(result.blob));
  check("üst veri kutusu (udta) çıktıda KORUNUR (sunucu ad/kapak okur)", info.moovKids.includes("udta"), info.moovKids.join());
  check("iods ve ses izinin tref'i atılır (silinen izlere başvurmasın)", !info.moovKids.includes("iods") && !info.trakKids.includes("tref"), info.trakKids.join());
  const bare = await extractAudio(blobOf(makeMp4({}).bytes));
  check("üst veri yoksa boş alanlar", bare.ok && bare.meta.title === "" && bare.meta.artist === "" && bare.meta.hasCover === false);
}
{
  // eski QuickTime udta metni: uzunluk(2) + dil(2) + metin
  const qt = box("udta", box("©nam", be16(5), be16(0), latin("Hello")));
  const result = await extractAudio(blobOf(makeMp4({ metaBox: qt }).bytes));
  check("eski QuickTime ©nam metni okunur", result.ok && result.meta.title === "Hello", JSON.stringify(result.meta));
}

// ------------------------------------------------------------------ parçalı mp4: moov(mvex) + [moof mdat] x 3
// mode: "moof" (default-base-is-moof + trun ofseti), "abs" (tfhd base_data_offset mutlak), "chain" (bayrak yok: ilk traf moof başına göre
// ofsetli, ses traf'ı öncekinin verisinin sonundan başlar; ses trun'ları ofsetsiz, art arda)
function makeFragmented(mode) {
  const ftyp = box("ftyp", latin("iso6"), be32(0), latin("iso6mp41"));
  const stblEmpty = (entry) => box("stbl", full("stsd", 0, be32(1), box(entry, new Uint8Array(28))), full("stts", 0, be32(0)), full("stsc", 0, be32(0)), full("stsz", 0, be32(0), be32(0)), full("stco", 0, be32(0)));
  const trak = (id, kind, entry) => box("trak", tkhd(id), box("mdia", full("mdhd", 0, new Uint8Array(20)), hdlr(kind), box("minf", stblEmpty(entry))));
  const trex = (id, size) => full("trex", 0, be32(id), be32(1), be32(1024), be32(size), be32(0));
  const moov = box("moov", full("mvhd", 0, new Uint8Array(96)), trak(1, "vide", "avc1"), trak(2, "soun", "mp4a"), box("mvex", full("mehd", 0, be32(0)), trex(1, 0), trex(2, 50)), ilst({ title: "Parçalı" }));
  const parts = [ftyp, moov];
  const expected = [];
  let fileAt = ftyp.length + moov.length;
  for (let f = 0; f < 3; f += 1) {
    const video = new Uint8Array(400 + f * 10).fill(0x20 + f);
    const audioSizes = [30 + f, 40, 25];                                  // trun içinde boyutlu
    const audio = cat(...audioSizes.map((n, i) => new Uint8Array(n).fill(0x80 + f * 4 + i)));
    const audio2 = new Uint8Array(50 * 2).fill(0xc0 + f);                // ikinci trun: trex varsayılan boyutu (50) ile
    expected.push(audio, audio2);
    const build = (dataStartAbs) => {
      // mdat düzeni: [video][audio][audio2]
      const videoAbs = dataStartAbs;
      const audioAbs = dataStartAbs + video.length;
      const moofStart = fileAt;
      const vFlags = mode === "moof" ? 0x20000 : mode === "abs" ? 0x1 : 0;
      const vTfhd = fullF("tfhd", vFlags | 0x10, be32(1), ...(mode === "abs" ? [be64(videoAbs)] : []), be32(video.length));
      const vTrun = fullF("trun", 0x1, be32(1), be32(mode === "abs" ? 0 : videoAbs - moofStart));    // chain: ilk trun ofsetli (moof başına göre)
      const aFlags = mode === "moof" ? 0x20000 : mode === "abs" ? 0x1 : 0;
      const aTfhd = fullF("tfhd", aFlags, be32(2), ...(mode === "abs" ? [be64(audioAbs)] : []));
      const aTrun1 = mode === "chain"
        ? fullF("trun", 0x200, be32(3), ...audioSizes.map(be32))
        : fullF("trun", 0x201, be32(3), be32(mode === "abs" ? 0 : audioAbs - moofStart), ...audioSizes.map(be32));
      const aTrun2 = mode === "chain"
        ? fullF("trun", 0, be32(2))
        : fullF("trun", 0x1, be32(2), be32((mode === "abs" ? 0 : audioAbs - moofStart) + audio.length));
      return box("moof", full("mfhd", 0, be32(f + 1)),
        box("traf", vTfhd, full("tfdt", 0, be32(f * 1000)), vTrun),
        box("traf", aTfhd, full("tfdt", 0, be32(f * 3000)), aTrun1, aTrun2, full("saiz", 0, be32(0))));
    };
    const probe = build(0);
    const dataStart = fileAt + probe.length + 8;
    const moof = build(dataStart);
    const mdat = box("mdat", video, audio, audio2);
    parts.push(moof, mdat);
    fileAt += moof.length + mdat.length;
  }
  parts.push(box("mfra", new Uint8Array(16)));
  return { bytes: cat(...parts), expected };
}

function inspectFragmented(out) {
  const top = boxesIn(out, 0, out.length);
  const moov = top.find((b) => b.type === "moov");
  const moovKids = boxesIn(out, moov.o + 8, moov.o + moov.len);
  const mvex = moovKids.find((b) => b.type === "mvex");
  const trexIds = boxesIn(out, mvex.o + 8, mvex.o + mvex.len).filter((b) => b.type === "trex").map((b) => U32(out, b.o + 12));
  const pieces = [];
  let trafCount = 0;
  for (const moof of top.filter((b) => b.type === "moof")) {
    const trafs = boxesIn(out, moof.o + 8, moof.o + moof.len).filter((b) => b.type === "traf");
    trafCount += trafs.length;
    for (const traf of trafs) {
      const kids = boxesIn(out, traf.o + 8, traf.o + traf.len);
      const tfhd = kids.find((b) => b.type === "tfhd");
      const tflags = U32(out, tfhd.o + 8) & 0xffffff;
      if (!(tflags & 0x20000) || (tflags & 0x1)) return { error: "tfhd bayrakları" };
      for (const trun of kids.filter((b) => b.type === "trun")) {
        const flags = U32(out, trun.o + 8) & 0xffffff;
        const count = U32(out, trun.o + 12);
        if (!(flags & 1)) return { error: "trun ofseti yok" };
        const dataOffset = U32(out, trun.o + 16) | 0;
        let size = 0;
        for (let i = 0; i < count; i += 1) size += flags & 0x200 ? U32(out, trun.o + 20 + (flags & 4 ? 4 : 0) + i * 4) : 50;
        pieces.push(out.subarray(moof.o + dataOffset, moof.o + dataOffset + size));
      }
    }
  }
  return { top: top.map((b) => b.type), trakCount: moovKids.filter((b) => b.type === "trak").length, trexIds, trafCount, audio: cat(...pieces) };
}

for (const mode of ["moof", "abs", "chain"]) {
  const made = makeFragmented(mode);
  const result = await extractAudio(blobOf(made.bytes));
  check(`parçalı mp4 (${mode}): ayıklanır`, result.ok === true && result.chunks === 6, JSON.stringify({ ok: result.ok, reason: result.reason, detail: result.detail }));
  if (!result.ok) continue;
  const info = inspectFragmented(await readAll(result.blob));
  check(`parçalı mp4 (${mode}): tek iz, yalnız ses trex'i, moof başına tek traf`, !info.error && info.trakCount === 1 && info.trexIds.join() === "2" && info.trafCount === 3, JSON.stringify({ ...info, audio: undefined }));
  check(`parçalı mp4 (${mode}): ses baytları AYNEN, video yok, mfra atıldı`, !info.error && equal(info.audio, cat(...made.expected)) && !info.top.includes("mfra"));
  check(`parçalı mp4 (${mode}): üst veri okunur`, result.meta.title === "Parçalı");
}

// ------------------------------------------------------------------ WebM / Matroska
const ID = { EBML: [0x1a, 0x45, 0xdf, 0xa3], DocType: [0x42, 0x82], Segment: [0x18, 0x53, 0x80, 0x67], Info: [0x15, 0x49, 0xa9, 0x66], Title: [0x7b, 0xa9],
  Tracks: [0x16, 0x54, 0xae, 0x6b], TrackEntry: [0xae], TrackNumber: [0xd7], TrackType: [0x83], CodecID: [0x86], Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7], SimpleBlock: [0xa3], BlockGroup: [0xa0], Block: [0xa1], BlockDuration: [0x9b], Cues: [0x1c, 0x53, 0xbb, 0x6b], SeekHead: [0x11, 0x4d, 0x9b, 0x74],
  Tags: [0x12, 0x54, 0xc3, 0x67], Tag: [0x73, 0x73], SimpleTag: [0x67, 0xc8], TagName: [0x45, 0xa3], TagString: [0x44, 0x87], Void: [0xec] };
const sizeV = (n) => (n < 127 ? Uint8Array.of(0x80 | n) : Uint8Array.of(0x01, ...be64(n).subarray(1)));
const el = (id, ...payload) => { const body = cat(...payload); return cat(Uint8Array.from(id), sizeV(body.length), body); };
const elUnknown = (id, ...payload) => cat(Uint8Array.from(id), Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), ...payload);
const uintEl = (id, v) => el(id, Uint8Array.of(v));
const strEl = (id, s) => el(id, enc.encode(s));
const block = (track, tc, payload) => cat(Uint8Array.of(0x80 | track), be16(tc), Uint8Array.of(0x80), payload);

function makeWebm({ docType = "webm", audioCodec = "A_OPUS", unknownSizes = true, noAudio = false } = {}) {
  const header = el(ID.EBML, strEl(ID.DocType, docType));
  const info = el(ID.Info, strEl(ID.Title, "Klip Başlığı"));
  const tracks = el(ID.Tracks,
    el(ID.TrackEntry, uintEl(ID.TrackNumber, 1), uintEl(ID.TrackType, 1), strEl(ID.CodecID, "V_VP8")),
    ...(noAudio ? [] : [el(ID.TrackEntry, uintEl(ID.TrackNumber, 2), uintEl(ID.TrackType, 2), strEl(ID.CodecID, audioCodec))]));
  const audioPayloads = [];
  const clusters = [];
  for (let c = 0; c < 3; c += 1) {
    const items = [uintEl(ID.Timecode, c * 10)];
    for (let k = 0; k < 4; k += 1) {
      items.push(el(ID.SimpleBlock, block(1, k, new Uint8Array(200 + k).fill(0x10 + k))));
      const ap = new Uint8Array(20 + c + k).fill(0x90 + c * 4 + k);
      audioPayloads.push(ap);
      if (c === 1 && k === 2) items.push(el(ID.BlockGroup, el(ID.Block, block(2, k, ap)), uintEl(ID.BlockDuration, 20)));
      else items.push(el(ID.SimpleBlock, block(2, k, ap)));
    }
    clusters.push(unknownSizes && c !== 1 ? elUnknown(ID.Cluster, ...items) : el(ID.Cluster, ...items));
  }
  const tags = el(ID.Tags, el(ID.Tag, el(ID.SimpleTag, strEl(ID.TagName, "TITLE"), strEl(ID.TagString, "Etiket Adı")), el(ID.SimpleTag, strEl(ID.TagName, "ARTIST"), strEl(ID.TagString, "Sanatçı"))));
  const cues = el(ID.Cues, new Uint8Array(12));
  const segBody = [el(ID.SeekHead, new Uint8Array(10)), el(ID.Void, new Uint8Array(4)), info, tracks, ...clusters, ...(unknownSizes ? [] : [cues]), tags];
  const segment = unknownSizes ? elUnknown(ID.Segment, ...segBody) : el(ID.Segment, ...segBody);
  return { bytes: cat(header, segment), audioPayloads };
}

// bağımsız EBML okuyucu (testin kendi kodu)
function readV(buf, at, keep) {
  const first = buf[at];
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len += 1;
  let v = keep ? first : first & (0xff >> len);
  for (let i = 1; i < len; i += 1) v = v * 256 + buf[at + i];
  return { v, len };
}
function ebmlList(buf, from, to) {
  const out = [];
  for (let at = from; at < to;) {
    const id = readV(buf, at, true);
    const size = readV(buf, at + id.len, false);
    const data = at + id.len + size.len;
    out.push({ id: id.v, data, end: data + size.v });
    at = data + size.v;
  }
  return out;
}

for (const variant of [{ name: "webm, boyutu bilinmeyen Segment/Cluster", opts: {} }, { name: "mkv, bilinen boyutlar, AAC", opts: { docType: "matroska", audioCodec: "A_AAC", unknownSizes: false } }]) {
  const made = makeWebm(variant.opts);
  const result = await extractAudio(blobOf(made.bytes));
  const wantExt = variant.opts.docType === "matroska" ? "mka" : "webm";
  check(`${variant.name}: ayıklanır (.${wantExt})`, result.ok === true && result.ext === wantExt && result.chunks === 12, JSON.stringify({ ok: result.ok, reason: result.reason, ext: result.ext, chunks: result.chunks, detail: result.detail }));
  if (!result.ok) continue;
  const out = await readAll(result.blob);
  const top = ebmlList(out, 0, out.length);
  const seg = top[1];
  const kids = ebmlList(out, seg.data, seg.end);
  const ids = kids.map((k) => k.id.toString(16));
  const tracksEl = kids.find((k) => k.id === 0x1654ae6b);
  const entries = ebmlList(out, tracksEl.data, tracksEl.end).filter((k) => k.id === 0xae);
  const blocks = [];
  let videoSeen = false;
  for (const cluster of kids.filter((k) => k.id === 0x1f43b675)) {
    for (const item of ebmlList(out, cluster.data, cluster.end)) {
      let blk = null;
      if (item.id === 0xa3) blk = item;
      if (item.id === 0xa0) blk = ebmlList(out, item.data, item.end).find((k) => k.id === 0xa1);
      if (!blk) continue;
      const tn = readV(out, blk.data, false);
      if (tn.v !== 2) videoSeen = true;
      blocks.push(out.subarray(blk.data + tn.len + 3, blk.end));
    }
  }
  check(`${variant.name}: Segment = Info, Tracks(1 iz), Tags, Cluster'lar; SeekHead/Cues yok`,
    top.length === 2 && ids.join() === "1549a966,1654ae6b,1254c367,1f43b675,1f43b675,1f43b675" && entries.length === 1, ids.join());
  check(`${variant.name}: yalnız ses blokları, baytlar AYNEN (BlockGroup dahil)`, !videoSeen && blocks.length === 12 && equal(cat(...blocks), cat(...made.audioPayloads)));
  const infoEl = kids.find((k) => k.id === 0x1549a966);
  const durEl = ebmlList(out, infoEl.data, infoEl.end).find((k) => k.id === 0x4489);
  const durValue = durEl ? new DataView(out.buffer, out.byteOffset + durEl.data, 8).getFloat64(0) : null;
  check(`${variant.name}: eksik süre (Duration) son ses bloğundan eklenir`, durValue === 43, String(durValue));
  check(`${variant.name}: başlık (Info) ve sanatçı (Tags) okunur`, result.meta.title === "Klip Başlığı" && result.meta.artist === "Sanatçı", JSON.stringify(result.meta));
  check(`${variant.name}: çıktı küçük`, out.length < made.bytes.length / 2);
}
check("webm ses izi yok: 'noaudio'", (await extractAudio(blobOf(makeWebm({ noAudio: true }).bytes))).reason === "noaudio");
{
  const made = makeWebm({ unknownSizes: true });
  const cutRes = await extractAudio(blobOf(made.bytes.subarray(0, made.bytes.length - 300)));
  check("kesik webm çökmez (eldeki tam ses blokları ayıklanır)", cutRes.ok === true && cutRes.chunks >= 4 && cutRes.chunks < 12, JSON.stringify({ ok: cutRes.ok, reason: cutRes.reason, chunks: cutRes.chunks }));
}

// ------------------------------------------------------------------ hatalar, iptal, ilerleme
check("parçalı mp4 ama moof yok/örnek yok: güvenli ret", (await extractAudio(blobOf(makeMp4({ fragmented: true }).bytes))).ok === false);
check("ses izi yok: 'noaudio'", (await extractAudio(blobOf(makeMp4({ noAudio: true }).bytes))).reason === "noaudio");
check("klip olmayan dosya: 'notclip'", (await extractAudio(blobOf(enc.encode("bu bir video degil ".repeat(20))))).reason === "notclip");
check("boş / çok kısa dosya güvenli", (await extractAudio(blobOf(new Uint8Array(0)))).reason === "notclip" && (await extractAudio(blobOf(new Uint8Array(5)))).reason === "notclip");
const cut = makeMp4({}).bytes;
const broken = await extractAudio(blobOf(cut.subarray(0, cut.length - 40)));
check("kesik mp4 çökmez (moov bozuk)", broken.ok === false && typeof broken.reason === "string");
const lying = makeMp4({}).bytes;
lying.set(be32(0x7fffffff), 0);
check("başlığı yalan söyleyen kutu boyutu çökmez", (await extractAudio(blobOf(lying))).ok === false);
{
  const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) & 255);
  garbage.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  const res = await extractAudio(blobOf(garbage));
  check("bozuk EBML çökmez", res.ok === false && typeof res.reason === "string");
}
{
  const controller = new AbortController();
  controller.abort();
  check("iptal: 'cancelled'", (await extractAudio(blobOf(makeMp4({}).bytes), { signal: controller.signal })).reason === "cancelled"
    && (await extractAudio(blobOf(makeWebm().bytes), { signal: controller.signal })).reason === "cancelled");
  const seen = [];
  const res = await extractAudio(blobOf(makeFragmented("moof").bytes), { onProgress: (r) => seen.push(r) });
  check("ilerleme bildirilir ve 1'de biter", res.ok && seen.length >= 2 && seen[seen.length - 1] === 1 && seen.every((r, i) => i === 0 || r >= seen[i - 1]), JSON.stringify(seen));
}
check("her ret nedeninin kullanıcı metni var", ["notclip", "fragmented", "noaudio", "unsupported", "toolarge", "encrypted", "cancelled"].every((r) => REASON_TEXT[r]));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
