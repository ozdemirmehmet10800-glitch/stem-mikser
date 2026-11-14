// Tarayıcıda zip açma (Google Takeout için): yalnız .csv girdilerini okur. Sunucu ya da kütüphane YOK: yerel DecompressionStream
// ("deflate-raw"). Dosya adlarına/klasör yapısına BAĞIMLI DEĞİL: her .csv girdisine bakılır. node tests\zipread_test.mjs
//
// Savunma: girdi sayısı ve açılmış boyut sınırlı (zip bombası), şifreli girdi atlanır, bozuk zip anlamlı hata verir.
// Zip64 (merkezi dizin 65535'ten çok girdi / 4 GB üstü) merkezi dizin için desteklenir; veri yalnız küçük CSV'lerden okunur.

export const ZIP_MAX_ENTRIES = 5000;          // merkezi dizinde en çok bu kadar girdiye bakılır
export const CSV_MAX_FILES = 300;             // en çok bu kadar csv açılır
export const CSV_MAX_BYTES = 20 * 1024 * 1024;   // tek csv açılmış en çok 20 MB
export const CSV_TOTAL_MAX_BYTES = 120 * 1024 * 1024;

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ZipError";
    this.code = code;       // "notzip" | "unsupported" | "toolarge" | "failed"
  }
}

const u16 = (view, at) => view.getUint16(at, true);
const u32 = (view, at) => view.getUint32(at, true);
const u64 = (view, at) => Number(view.getBigUint64(at, true));

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function decodeName(bytes, utf8) {
  try {
    return new TextDecoder(utf8 ? "utf-8" : "utf-8", { fatal: utf8 }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

/** Merkezi dizinden girdiler: [{name, method, flags, csize, usize, offset}]. Dosya adı bayt gibi okunur, yol bileşenlerine bakılmaz. */
export async function listEntries(blob) {
  const size = blob.size;
  if (size < 22) throw new ZipError("notzip", "Bu bir zip dosyası değil.");
  const tailLen = Math.min(size, 22 + 65535 + 20);
  const tail = await bytesOf(blob, size - tailLen, size);
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("notzip", "Bu bir zip dosyası değil (ya da bozuk).");
  let count = u16(tv, eocd + 10);
  let cdSize = u32(tv, eocd + 12);
  let cdOffset = u32(tv, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // Zip64: EOCD'nin hemen önünde 20 baytlık bulucu, onun gösterdiği 64'lük EOCD
    const loc = eocd - 20;
    if (loc < 0 || u32(tv, loc) !== 0x07064b50) throw new ZipError("unsupported", "Zip64 yapısı okunamadı.");
    const z64Offset = u64(tv, loc + 8);
    const z64 = new DataView((await bytesOf(blob, z64Offset, z64Offset + 56)).buffer);
    if (u32(z64, 0) !== 0x06064b50) throw new ZipError("unsupported", "Zip64 yapısı okunamadı.");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  if (cdOffset + cdSize > size || cdSize > 64 * 1024 * 1024) throw new ZipError("notzip", "Zip dizini bozuk.");
  const dir = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const dv = new DataView(dir.buffer);
  const entries = [];
  let at = 0;
  for (let n = 0; n < count && n < ZIP_MAX_ENTRIES; n += 1) {
    if (at + 46 > dir.length || u32(dv, at) !== 0x02014b50) break;
    const flags = u16(dv, at + 8);
    const method = u16(dv, at + 10);
    let csize = u32(dv, at + 20);
    let usize = u32(dv, at + 24);
    const nameLen = u16(dv, at + 28);
    const extraLen = u16(dv, at + 30);
    const commentLen = u16(dv, at + 32);
    let offset = u32(dv, at + 42);
    const name = decodeName(dir.subarray(at + 46, at + 46 + nameLen), Boolean(flags & 0x0800));
    // zip64 genişletilmiş alan (0x0001): 0xFFFFFFFF olan alanlar sırayla burada
    let extra = at + 46 + nameLen;
    const extraEnd = extra + extraLen;
    while (extra + 4 <= extraEnd) {
      const id = u16(dv, extra);
      const len = u16(dv, extra + 2);
      if (id === 0x0001) {
        let p = extra + 4;
        if (usize === 0xffffffff && p + 8 <= extraEnd) { usize = u64(dv, p); p += 8; }
        if (csize === 0xffffffff && p + 8 <= extraEnd) { csize = u64(dv, p); p += 8; }
        if (offset === 0xffffffff && p + 8 <= extraEnd) { offset = u64(dv, p); p += 8; }
      }
      extra += 4 + len;
    }
    entries.push({ name, method, flags, csize, usize, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new ZipError("unsupported", "Bu tarayıcı zip açamıyor. Zip içindeki CSV dosyalarını seçerek içe aktar.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Tek girdinin açılmış baytları (sınırlı). */
export async function readEntry(blob, entry, maxBytes = CSV_MAX_BYTES) {
  if (entry.flags & 0x0001) throw new ZipError("unsupported", "Şifreli zip girdisi.");
  if (entry.usize > maxBytes) throw new ZipError("toolarge", `${entry.name}: çok büyük.`);
  const head = new DataView((await bytesOf(blob, entry.offset, entry.offset + 30)).buffer);
  if (u32(head, 0) !== 0x04034b50) throw new ZipError("notzip", "Zip girdisi bozuk.");
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const packed = await bytesOf(blob, start, start + entry.csize);
  if (entry.method === 0) return packed;
  if (entry.method === 8) {
    const out = await inflateRaw(packed);
    if (out.length > maxBytes) throw new ZipError("toolarge", `${entry.name}: çok büyük.`);
    return out;
  }
  throw new ZipError("unsupported", `Desteklenmeyen sıkıştırma (${entry.method}).`);
}

/**
 * Zip içindeki tüm .csv girdileri: [{name, text}] (klasör ve ad ne olursa olsun). Bozuk/şifreli/aşırı büyük girdiler atlanır ve
 * `skipped` sayılır. Dönen: {files, skipped}.
 */
export async function readCsvEntries(blob) {
  const entries = await listEntries(blob);
  const files = [];
  let skipped = 0;
  let total = 0;
  for (const entry of entries) {
    if (!/\.csv$/i.test(entry.name) || entry.name.endsWith("/")) continue;
    if (files.length >= CSV_MAX_FILES || total + entry.usize > CSV_TOTAL_MAX_BYTES) {
      skipped += 1;
      continue;
    }
    try {
      const bytes = await readEntry(blob, entry);
      total += bytes.length;
      let text = new TextDecoder("utf-8").decode(bytes);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      files.push({ name: entry.name, text });
    } catch (error) {
      if (error instanceof ZipError && error.code === "unsupported" && /tarayıcı/.test(error.message)) throw error;
      skipped += 1;
    }
  }
  return { files, skipped };
}

/** zip mi? (ilk iki bayt "PK") */
export async function looksLikeZip(blob) {
  if (blob.size < 4) return false;
  const head = await bytesOf(blob, 0, 4);
  return head[0] === 0x50 && head[1] === 0x4b;
}
