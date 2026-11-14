// Zip okuma (js/zipread.js): Takeout benzeri zip'ten .csv girdileri, dosya adlarına bağımlı olmadan. SENTETİK zip'ler bu testte üretilir.
//   node tests\zipread_test.mjs

import zlib from "node:zlib";
import { listEntries, readCsvEntries, looksLikeZip, ZipError, CSV_MAX_FILES } from "../frontend/js/zipread.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const enc = new TextEncoder();
function le(value, bytes) {
  const out = Buffer.alloc(bytes);
  if (bytes === 8) out.writeBigUInt64LE(BigInt(value));
  else if (bytes === 4) out.writeUInt32LE(value >>> 0);
  else out.writeUInt16LE(value);
  return out;
}

/** entries: [{name, data (string|Buffer), method: 8|0, flags?, utf8?}] -> Buffer (isteğe bağlı zip64 EOCD). */
function makeZip(entries, { zip64 = false, junkBefore = 0 } = {}) {
  const parts = [Buffer.alloc(junkBefore)];
  const central = [];
  let offset = junkBefore;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const packed = e.method === 0 ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const flags = (e.flags || 0) | (e.utf8 === false ? 0 : 0x0800);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const local = Buffer.concat([le(0x04034b50, 4), le(20, 2), le(flags, 2), le(e.method ?? 8, 2), le(0, 2), le(0, 2), le(crc, 4), le(packed.length, 4),
      le(raw.length, 4), le(name.length, 2), le(0, 2), name, packed]);
    central.push(Buffer.concat([le(0x02014b50, 4), le(20, 2), le(20, 2), le(flags, 2), le(e.method ?? 8, 2), le(0, 2), le(0, 2), le(crc, 4),
      le(packed.length, 4), le(e.fakeUsize ?? raw.length, 4), le(name.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4), name]));
    parts.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  parts.push(cd);
  if (zip64) {
    const z64 = Buffer.concat([le(0x06064b50, 4), le(44, 8), le(45, 2), le(45, 2), le(0, 4), le(0, 4), le(entries.length, 8), le(entries.length, 8), le(cd.length, 8), le(offset, 8)]);
    const loc = Buffer.concat([le(0x07064b50, 4), le(0, 4), le(offset + cd.length, 8), le(1, 4)]);
    parts.push(z64, loc, Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(0xffff, 2), le(0xffff, 2), le(0xffffffff, 4), le(0xffffffff, 4), le(0, 2)]));
  } else {
    parts.push(Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(entries.length, 2), le(entries.length, 2), le(cd.length, 4), le(offset, 4), le(0, 2)]));
  }
  return Buffer.concat(parts);
}
const blobOf = (buffer) => new Blob([buffer]);

const csvA = "Video ID,Playlist Video Creation Timestamp\r\nabcdefghijk,2024-01-02T00:00:00+00:00\r\nbcdefghijkl,2024-01-03T00:00:00+00:00\r\n";
const csvB = "Song title,Album title,Artist name 1\nSentetik Şarkı,Albüm,Sentetik Sanatçı\n";
const zip = makeZip([
  { name: "Takeout/YouTube ve YouTube Müzik/müzik (kitaplık ve yüklemeler)/müzik kitaplığı şarkıları.csv", data: csvB, method: 8 },
  { name: "Takeout/YouTube ve YouTube Müzik/çalma listeleri/Beğendiğim videolar-videolar.csv", data: csvA, method: 0 },
  { name: "Takeout/arşiv_tarayıcısı.html", data: "<html></html>", method: 8 },
  { name: "Takeout/klasör/", data: "", method: 0 },
  { name: "Takeout/çalma listeleri/çalma listeleri.CSV", data: "Playlist ID,Title\nPL1,Liste\n", method: 8 },
]);

check("looksLikeZip: PK imzası", (await looksLikeZip(blobOf(zip))) && !(await looksLikeZip(blobOf(Buffer.from("Song title,Artist\n")))));
const entries = await listEntries(blobOf(zip));
check("merkezi dizin: 5 girdi, Türkçe (UTF-8) ad doğru", entries.length === 5 && entries[0].name.includes("müzik kitaplığı şarkıları.csv"), entries.map((e) => e.name).join(" | "));
const result = await readCsvEntries(blobOf(zip));
check("yalnız .csv girdileri (büyük/küçük harf, klasör, html atlanır) ve dosya adından BAĞIMSIZ okunur", result.files.length === 3
  && result.files.some((f) => f.text === csvB) && result.files.some((f) => f.text === csvA) && result.skipped === 0, result.files.map((f) => f.name.slice(-30)).join(" | "));
check("deflate ve stored (sıkıştırmasız) içerik aynen", result.files.find((f) => f.text === csvA) && result.files.find((f) => f.text === csvB));

// başında gereksiz bayt (kendiliğinden açılan arşivler) ve zip64 merkezi dizin
const junk = makeZip([{ name: "a.csv", data: csvB }], { junkBefore: 7 });
check("zip başında ek bayt olsa da (offset kayması) bozulmadan okunur ya da anlamlı atlanır", await (async () => {
  try {
    const r = await readCsvEntries(blobOf(junk));
    return r.files.length + r.skipped === 1;
  } catch (e) {
    return e instanceof ZipError;
  }
})());
const z64 = makeZip([{ name: "x/y.csv", data: csvB }, { name: "x/z.csv", data: csvA }], { zip64: true });
const r64 = await readCsvEntries(blobOf(z64));
check("zip64 merkezi dizin (0xFFFF alanları) okunur", r64.files.length === 2);

// savunma
const bomb = makeZip([{ name: "buyuk.csv", data: "a,b\n1,2\n", method: 8, fakeUsize: 64 * 1024 * 1024 }, { name: "iyi.csv", data: csvB }]);
const rb = await readCsvEntries(blobOf(bomb));
check("açılmış boyutu sınırı aşan girdi atlanır (zip bombası), diğeri okunur", rb.files.length === 1 && rb.files[0].name === "iyi.csv" && rb.skipped === 1);
const enc1 = makeZip([{ name: "gizli.csv", data: csvB, flags: 1 }, { name: "iyi.csv", data: csvA }]);
const re = await readCsvEntries(blobOf(enc1));
check("şifreli girdi atlanır", re.files.length === 1 && re.files[0].name === "iyi.csv" && re.skipped === 1);
const many = makeZip(Array.from({ length: CSV_MAX_FILES + 5 }, (_, i) => ({ name: `d/${i}.csv`, data: "a,b\n1,2\n" })));
const rm = await readCsvEntries(blobOf(many));
check(`en çok ${CSV_MAX_FILES} csv açılır, fazlası atlanır`, rm.files.length === CSV_MAX_FILES && rm.skipped === 5);
const weird = makeZip([{ name: "k.csv", data: csvB, method: 99 }]);
check("desteklenmeyen sıkıştırma: atlanır, çökmez", (await readCsvEntries(blobOf(weird))).skipped === 1);

let code = "";
try { await readCsvEntries(blobOf(Buffer.from("bu bir zip degil, düz metin ".repeat(10)))); } catch (e) { code = e.code; }
check("zip olmayan dosya: ZipError(notzip)", code === "notzip");
code = "";
try { await readCsvEntries(blobOf(Buffer.alloc(5))); } catch (e) { code = e.code; }
check("çok küçük dosya: ZipError(notzip)", code === "notzip");
const truncated = zip.subarray(0, zip.length - 30);
code = "";
try { await readCsvEntries(blobOf(truncated)); } catch (e) { code = e.code; }
check("kesik zip (EOCD yok): ZipError(notzip), çökme yok", code === "notzip");

// UTF-8 BOM'lu csv: BOM atılır
const bom = makeZip([{ name: "b.csv", data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvB)]) }]);
check("UTF-8 BOM atılır", (await readCsvEntries(blobOf(bom))).files[0].text === csvB);

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
