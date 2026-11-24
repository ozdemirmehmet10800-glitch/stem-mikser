// Klipten ses ayıklama: GERÇEK kodlayıcı çıktılarıyla (tests/fixtures/clips). İçerik yapay: 3 sn ton + renkli kare, telif yok.
//   clip-mf.mp4    Windows Media Foundation (MediaComposition): H.264 + AAC, normal mp4 ("moov" sonda)
//   clip-rec.mp4   Chrome MediaRecorder: H.264 + AAC, PARÇALI mp4 (moof/mdat)
//   clip-rec.webm  Chrome MediaRecorder: VP8 + Opus, boyutu bilinmeyen Segment/Cluster, süre (Duration) yazılmamış
//   clip-rec.mkv   Chrome MediaRecorder: H.264 + Opus, Matroska
// Bu dosyaların ayıklanan sesi tarayıcıda klibin kendi sesiyle örnek örnek AYNI çözüldü (fark 0; GUNLUK kayıt 13). Burada o çıktının ses
// yükü (payload) özeti sabitlenir: değişirse ayıklayıcı davranışı değişmiştir, tarayıcıda yeniden doğrulanmalı.   node tests\clip_fixtures_test.mjs

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractAudio } from "../frontend/js/mp4audio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const sha = (parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex").slice(0, 16);
};

function mp4Boxes(b, from, to) {
  const out = [];
  for (let o = from; o + 8 <= to;) {
    const len = u32(b, o);
    if (len < 8) break;
    out.push({ type: String.fromCharCode(...b.subarray(o + 4, o + 8)), o, len });
    o += len;
  }
  return out;
}

function readV(buf, at, keep) {
  const first = buf[at];
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len += 1;
  let v = keep ? first : first & (0xff >> len);
  for (let i = 1; i < len; i += 1) v = v * 256 + buf[at + i];
  return { v, len };
}
function ebml(buf, from, to) {
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

/** Çıktının ses yükü: mp4'te mdat gövdeleri, EBML'de blok verileri (iz başlığı hariç). Ayrıca yapı özeti. */
function audioPayload(out) {
  if (out[0] === 0x1a) {
    const [, segment] = ebml(out, 0, out.length);
    const kids = ebml(out, segment.data, segment.end);
    const parts = [];
    const tracks = new Set();
    for (const cluster of kids.filter((k) => k.id === 0x1f43b675)) {
      for (const item of ebml(out, cluster.data, cluster.end)) {
        const blk = item.id === 0xa3 ? item : item.id === 0xa0 ? ebml(out, item.data, item.end).find((k) => k.id === 0xa1) : null;
        if (!blk) continue;
        const tn = readV(out, blk.data, false);
        tracks.add(tn.v);
        parts.push(out.subarray(blk.data + tn.len + 3, blk.end));
      }
    }
    const info = kids.find((k) => k.id === 0x1549a966);
    const durationEl = info && ebml(out, info.data, info.end).find((k) => k.id === 0x4489);
    const duration = durationEl ? new DataView(out.buffer, out.byteOffset + durationEl.data, 8).getFloat64(0) : null;
    return { parts, structure: kids.map((k) => k.id.toString(16)).filter((id, i, all) => all.indexOf(id) === i).join(), tracks: [...tracks].join(), duration };
  }
  const top = mp4Boxes(out, 0, out.length);
  const moov = top.find((b) => b.type === "moov");
  const traks = mp4Boxes(out, moov.o + 8, moov.o + moov.len).filter((b) => b.type === "trak").length;
  return {
    parts: top.filter((b) => b.type === "mdat").map((b) => out.subarray(b.o + 8, b.o + b.len)),
    structure: [...new Set(top.map((b) => b.type))].join(),
    tracks: String(traks),
    duration: null,
  };
}

const EXPECT = {
  "clip-mf.mp4": { ext: "m4a", chunks: 9, structure: "ftyp,moov,mdat", tracks: "1", payload: "96c717635b961a7a" },
  "clip-rec.mp4": { ext: "m4a", chunks: 4, structure: "ftyp,moov,moof,mdat", tracks: "1", payload: "dee4e4625a2586cd" },
  "clip-rec.webm": { ext: "webm", chunks: 50, structure: "1549a966,1654ae6b,1f43b675", tracks: "1", payload: "24b7eba3babcc5ac", duration: true },
  "clip-rec.mkv": { ext: "mka", chunks: 50, structure: "1549a966,1654ae6b,1f43b675", tracks: "1", payload: "24b7eba3babcc5ac", duration: true },
};

for (const [name, want] of Object.entries(EXPECT)) {
  const bytes = readFileSync(path.join(here, "fixtures", "clips", name));
  const result = await extractAudio(new Blob([bytes]));
  check(`${name}: ayıklanır (.${want.ext}, ${want.chunks} parça)`, result.ok && result.ext === want.ext && result.chunks === want.chunks, JSON.stringify({ ok: result.ok, reason: result.reason, ext: result.ext, chunks: result.chunks, detail: result.detail }));
  if (!result.ok) continue;
  const out = new Uint8Array(await result.blob.arrayBuffer());
  const info = audioPayload(out);
  check(`${name}: yapı ${want.structure}, tek ses izi`, info.structure === want.structure && info.tracks === want.tracks, `${info.structure} | iz ${info.tracks}`);
  check(`${name}: ses yükü sabit (tarayıcıda doğrulanan çıktı)`, sha(info.parts) === want.payload, sha(info.parts));
  check(`${name}: çıktı girdiden küçük`, out.length < bytes.length);
  if (want.duration) check(`${name}: eksik süre eklendi (~3 sn)`, info.duration > 2900 && info.duration < 3100, String(info.duration));
}

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
