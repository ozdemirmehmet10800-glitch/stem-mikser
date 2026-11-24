// Klipten ses ayıklama (js/mp4audio.js): SENTETİK mp4 (video + ses izleri iç içe), çıktı doğrulaması.   node tests\mp4audio_test.mjs

import { extractAudio, REASON_TEXT } from "../frontend/js/mp4audio.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const enc = new TextEncoder();
const be32 = (v) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const be64 = (v) => new Uint8Array([...be32(Math.floor(v / 4294967296)), ...be32(v >>> 0)]);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const box = (type, ...payload) => { const body = cat(...payload); return cat(be32(8 + body.length), enc.encode(type), body); };
const full = (type, version, ...payload) => box(type, Uint8Array.of(version, 0, 0, 0), ...payload);

// iki iz: video (iz 1) ve ses (iz 2); mdat'ta parçalar İÇ İÇE: V A V A A V ...
function makeMp4({ moovFirst = false, wide = false, fixedSampleSize = 0, fragmented = false, noAudio = false } = {}) {
  const videoChunks = [new Uint8Array(500).fill(0x11), new Uint8Array(700).fill(0x12), new Uint8Array(300).fill(0x13)];
  const audioSamples = Array.from({ length: 9 }, (_, i) => new Uint8Array(fixedSampleSize || 40 + i * 5).fill(0xa0 + i));
  // ses parçaları: [3 örnek], [4 örnek], [2 örnek]
  const audioGroups = [audioSamples.slice(0, 3), audioSamples.slice(3, 7), audioSamples.slice(7, 9)];
  const audioChunkBytes = audioGroups.map((g) => cat(...g));
  const order = [["v", 0], ["a", 0], ["v", 1], ["a", 1], ["a", 2], ["v", 2]];
  const ftyp = box("ftyp", enc.encode("isom"), be32(0), enc.encode("isomiso2mp41"));
  const mdatPayload = cat(...order.map(([kind, i]) => (kind === "v" ? videoChunks[i] : audioChunkBytes[i])));
  const mdat = box("mdat", mdatPayload);
  const moovLen = (offsets) => buildMoov(offsets).length;
  function buildMoov(audioOffsets, videoOffsets = [0, 0, 0]) {
    const hdlr = (kind) => full("hdlr", 0, be32(0), enc.encode(kind), new Uint8Array(12), enc.encode("x\0"));
    const stco = (offs) => (wide ? full("co64", 0, be32(offs.length), ...offs.map(be64)) : full("stco", 0, be32(offs.length), ...offs.map(be32)));
    const stsz = fixedSampleSize
      ? full("stsz", 0, be32(fixedSampleSize), be32(9))
      : full("stsz", 0, be32(0), be32(9), ...audioSamples.map((s) => be32(s.length)));
    const audioStbl = box("stbl", full("stsd", 0, be32(1), box("mp4a", new Uint8Array(28))), full("stts", 0, be32(1), be32(9), be32(1024)),
      full("stsc", 0, be32(3), be32(1), be32(3), be32(1), be32(2), be32(4), be32(1), be32(3), be32(2), be32(1)), stsz, stco(audioOffsets));
    const videoStbl = box("stbl", full("stsd", 0, be32(1), box("avc1", new Uint8Array(78))), full("stts", 0, be32(1), be32(3), be32(1000)),
      full("stsc", 0, be32(1), be32(1), be32(1), be32(1)), full("stsz", 0, be32(0), be32(3), be32(500), be32(700), be32(300)), stco(videoOffsets));
    const trak = (id, kind, stbl) => box("trak", full("tkhd", 0, new Uint8Array(80)), box("edts", full("elst", 0, be32(0))),
      box("mdia", full("mdhd", 0, new Uint8Array(20)), hdlr(kind), box("minf", box("dinf", full("dref", 0, be32(0))), stbl)));
    const mvex = fragmented ? box("mvex", full("trex", 0, new Uint8Array(20))) : new Uint8Array(0);
    return box("moov", full("mvhd", 0, new Uint8Array(96)), trak(1, "vide", videoStbl), ...(noAudio ? [] : [trak(2, "soun", audioStbl)]), mvex);
  }
  const mdatStart = (moovFirst ? ftyp.length + moovLen([0, 0, 0]) : ftyp.length) + 8;
  let at = mdatStart;
  const placed = { v: [], a: [] };
  for (const [kind, i] of order) {
    placed[kind][i] = at;
    at += (kind === "v" ? videoChunks[i] : audioChunkBytes[i]).length;
  }
  const moov = buildMoov(placed.a, placed.v);
  const bytes = moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
  return { bytes, audioSamples, audioPayload: cat(...audioChunkBytes) };
}

const blobOf = (bytes) => new Blob([bytes]);
const readAll = async (blob) => new Uint8Array(await blob.arrayBuffer());

// çıktıyı bağımsız çözümle: tek 'soun' izi, ofsetler gerçek ses baytlarına gidiyor
async function inspect(bytes) {
  const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  const t = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  const find = (type, from, to) => { for (let o = from; o + 8 <= to;) { const len = u32(o); if (t(o + 4) === type) return { o, len }; if (len < 8) break; o += len; } return null; };
  const top = [];
  for (let o = 0; o + 8 <= bytes.length;) { const len = u32(o); top.push(t(o + 4)); o += len; }
  const moov = find("moov", 0, bytes.length);
  const traks = [];
  for (let o = moov.o + 8; o + 8 <= moov.o + moov.len;) { const len = u32(o); if (t(o + 4) === "trak") traks.push({ o, len }); o += len; }
  const deep = (node, path) => { let cur = node; for (const type of path) { cur = find(type, cur.o + 8, cur.o + cur.len); if (!cur) return null; } return cur; };
  const trak = traks[0];
  const hdlr = deep(trak, ["mdia", "hdlr"]);
  const stbl = deep(trak, ["mdia", "minf", "stbl"]);
  const co = find("stco", stbl.o + 8, stbl.o + stbl.len) || find("co64", stbl.o + 8, stbl.o + stbl.len);
  const count = u32(co.o + 12);
  const wide = t(co.o + 4) === "co64";
  const offsets = Array.from({ length: count }, (_, i) => (wide ? u32(co.o + 16 + i * 8) * 4294967296 + u32(co.o + 20 + i * 8) : u32(co.o + 16 + i * 4)));
  return { top, trakCount: traks.length, handler: t(hdlr.o + 16), offsets, wide };
}

for (const variant of [{ name: "moov sonda", opts: {} }, { name: "moov başta", opts: { moovFirst: true } }, { name: "64-bit ofset (co64)", opts: { wide: true } }, { name: "sabit örnek boyutu", opts: { fixedSampleSize: 64 } }]) {
  const { bytes, audioPayload } = makeMp4(variant.opts);
  const result = await extractAudio(blobOf(bytes));
  check(`${variant.name}: ayıklanır`, result.ok === true && result.chunks === 3, JSON.stringify({ ok: result.ok, reason: result.reason }));
  if (!result.ok) continue;
  const out = await readAll(result.blob);
  const info = await inspect(out);
  check(`${variant.name}: çıktı ftyp + moov + mdat, tek iz, ses (soun)`, info.top.join() === "ftyp,moov,mdat" && info.trakCount === 1 && info.handler === "soun", JSON.stringify(info.top));
  check(`${variant.name}: ses baytları AYNEN ve ofsetler doğru`, (() => {
    const sizes = variant.opts.fixedSampleSize ? [3, 4, 2].map((n) => n * variant.opts.fixedSampleSize) : null;
    let expectedChunkLens = sizes;
    if (!expectedChunkLens) { expectedChunkLens = [[0, 3], [3, 7], [7, 9]].map(([a, b]) => { let s = 0; for (let i = a; i < b; i += 1) s += 40 + i * 5; return s; }); }
    const pieces = info.offsets.map((o, i) => out.subarray(o, o + expectedChunkLens[i]));
    const joined = new Uint8Array(pieces.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of pieces) { joined.set(p, at); at += p.length; }
    const expected = makeMp4(variant.opts).audioPayload;
    return joined.length === expected.length && joined.every((v, i) => v === expected[i]) && info.wide === Boolean(variant.opts.wide);
  })());
  check(`${variant.name}: çıktı videodan çok küçük (video baytı yok)`, out.length < bytes.length - 1400);
}

check("parçalı (mvex) mp4: 'fragmented' reddi", (await extractAudio(blobOf(makeMp4({ fragmented: true }).bytes))).reason === "fragmented");
check("ses izi yok: 'noaudio'", (await extractAudio(blobOf(makeMp4({ noAudio: true }).bytes))).reason === "noaudio");
check("mp4 olmayan dosya: 'notmp4'", (await extractAudio(blobOf(enc.encode("bu bir video degil ".repeat(20))))).reason === "notmp4");
check("boş / çok kısa dosya güvenli", (await extractAudio(blobOf(new Uint8Array(0)))).reason === "notmp4" && (await extractAudio(blobOf(new Uint8Array(5)))).reason === "notmp4");
const cut = makeMp4({}).bytes;
const broken = await extractAudio(blobOf(cut.subarray(0, cut.length - 40)));
check("kesik dosya çökmez (moov bozuk)", broken.ok === false && typeof broken.reason === "string");
const lying = makeMp4({}).bytes;
lying.set(be32(0x7fffffff), 0);
check("başlığı yalan söyleyen kutu boyutu çökmez", (await extractAudio(blobOf(lying))).ok === false);
check("her ret nedeninin kullanıcı metni var", ["notmp4", "fragmented", "noaudio", "unsupported", "toolarge"].every((r) => REASON_TEXT[r]));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
