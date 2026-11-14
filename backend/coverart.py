"""Gömülü kapak (Görsel yenileme 2): yüklenen dosyanın içindeki kapak resmini salt okunur çıkarır.

Bu dosya AYRI bir modül ve bilerek backend/app.py'nin DIŞINDA: app.py'nin satır sayısı Modal imajlarının (özellikle build'de beat_this
ağırlığını indiren `_warm_weights` katmanının) önbellek anahtarına giriyor (`_SELF_CHECK_LINES`), yani app.py'ye satır eklemek GPU imajının
yeniden kurulmasını tetikler. Kapak ucu için imaj yeniden kurulmasın diye kod burada; app.py yalnız `install()`'ı çağırır (satır sayısı
DEĞİŞMEDEN) ve `api_image`e bu dosyayı ekler.

Volume'a HİÇBİR ŞEY yazılmaz; GPU yok. Yerel test: tests/test_cover_api.py (sentetik mp3/m4a/flac).
"""

import asyncio
import pathlib
import shutil
import subprocess


# --------------------------------------------------------------------------
# Gömülü kapak (Görsel yenileme 2): yüklenen dosyanın içindeki kapak resmi.
# SALT OKUNUR: yalnız `input.*` dosyası okunur, Volume'a HİÇBİR ŞEY yazılmaz,
# GPU yok. ffmpeg'e bağımlı DEĞİL (mp3/ID3, m4a/covr, flac/PICTURE elle
# ayrıştırılıyor; yerelde ffmpeg olmadığı için testlenebilir), ffmpeg yalnız
# büyük resmi küçültmek için ve ELVERİRSE kullanılıyor (yoksa/patlarsa ham resim).
# --------------------------------------------------------------------------
COVER_MAX_PX = 384            # istemci liste/kilit ekranı için yeter; telefona büyük resim inmesin
COVER_RAW_MAX_BYTES = 6 * 1024 * 1024   # küçültülemeyen ham resim bundan büyükse "kapak yok" sayılır
COVER_ID3_MAX_BYTES = 16 * 1024 * 1024  # ID3 etiketi bundan büyükse okunmaz (savunma)


def _image_kind(data: bytes):
    """Sihirli bayttan mime ya da None: yalnız tarayıcının çizebileceği biçimler."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def _syncsafe(raw: bytes) -> int:
    value = 0
    for byte in raw:
        value = (value << 7) | (byte & 0x7F)
    return value


def _id3_text_end(data: bytes, start: int, encoding: int) -> int:
    """Sonlandırıcıyı (bir ya da iki sıfır bayt) atlayıp metnin SONRASININ indeksini döndürür."""
    if encoding in (1, 2):           # UTF-16: 2 baytlık sıfır, 2'ye hizalı
        index = start
        while index + 1 < len(data):
            if data[index] == 0 and data[index + 1] == 0:
                return index + 2
            index += 2
        return len(data)
    index = data.find(b"\x00", start)
    return len(data) if index < 0 else index + 1


def _id3_apic(frame_id: str, body: bytes):
    """APIC/PIC çerçevesinden (resim_baytı, resim_tipi) ya da None."""
    if len(body) < 4:
        return None
    encoding = body[0]
    if frame_id == "PIC":            # v2.2: 3 bayt biçim (JPG/PNG), sonra tip
        position = 4
    else:                            # APIC: mime sıfır sonlu latin1
        end = body.find(b"\x00", 1)
        if end < 0:
            return None
        position = end + 1
    if position >= len(body):
        return None
    picture_type = body[position]
    after_desc = _id3_text_end(body, position + 1, encoding)
    image = body[after_desc:]
    return (image, picture_type) if _image_kind(image) else None


def _cover_from_id3(head: bytes):
    """ID3v2 (v2.2/2.3/2.4) etiketinden kapak baytları. Ön kapak (tip 3) yoksa ilk resim."""
    if len(head) < 10 or head[:3] != b"ID3":
        return None
    major = head[3]
    if major not in (2, 3, 4):
        return None
    flags = head[5]
    size = _syncsafe(head[6:10])
    if size > COVER_ID3_MAX_BYTES:
        return None
    tag = head[10:10 + size]
    if flags & 0x80 and major != 4:  # tüm etiket "unsynchronisation" (v2.2/2.3)
        tag = tag.replace(b"\xff\x00", b"\xff")
    position = 0
    if flags & 0x40 and major in (3, 4):   # genişletilmiş başlık
        if len(tag) < 4:
            return None
        if major == 4:
            position = _syncsafe(tag[:4])
        else:
            position = int.from_bytes(tag[:4], "big") + 4
    found = []
    header_len = 6 if major == 2 else 10
    while position + header_len <= len(tag):
        if tag[position] == 0:       # dolgu (padding)
            break
        if major == 2:
            frame_id = tag[position:position + 3].decode("latin1")
            length = int.from_bytes(tag[position + 3:position + 6], "big")
            frame_flags = 0
        else:
            frame_id = tag[position:position + 4].decode("latin1")
            raw_len = tag[position + 4:position + 8]
            length = _syncsafe(raw_len) if major == 4 else int.from_bytes(raw_len, "big")
            frame_flags = int.from_bytes(tag[position + 8:position + 10], "big")
        body_start = position + header_len
        if length <= 0 or body_start + length > len(tag):
            break
        body = tag[body_start:body_start + length]
        if frame_id in ("APIC", "PIC"):
            if major == 4 and frame_flags & 0x0002:   # çerçeve düzeyinde unsynchronisation
                body = body.replace(b"\xff\x00", b"\xff")
            picture = _id3_apic(frame_id, body)
            if picture:
                found.append(picture)
        position = body_start + length
    if not found:
        return None
    for image, picture_type in found:
        if picture_type == 3:
            return image
    return found[0][0]


def _mp4_boxes(data: bytes, start: int, end: int):
    """[start, end) aralığındaki kutular: (tür, gövde_başı, gövde_sonu)."""
    position = start
    while position + 8 <= end:
        size = int.from_bytes(data[position:position + 4], "big")
        kind = data[position + 4:position + 8]
        header = 8
        if size == 1 and position + 16 <= end:
            size = int.from_bytes(data[position + 8:position + 16], "big")
            header = 16
        elif size == 0:
            size = end - position
        if size < header or position + size > end:
            break
        yield kind, position + header, position + size
        position += size


def _cover_from_mp4(data: bytes):
    """m4a/mp4: moov > udta > meta > ilst > covr > data."""
    def find(kind: bytes, start: int, end: int, skip: int = 0):
        for box_kind, body_start, body_end in _mp4_boxes(data, start, end):
            if box_kind == kind:
                return body_start + skip, body_end
        return None

    moov = find(b"moov", 0, len(data))
    if not moov:
        return None
    udta = find(b"udta", *moov)
    meta = find(b"meta", *udta, skip=4) if udta else None      # meta tam kutu: 4 bayt sürüm/bayrak
    ilst = find(b"ilst", *meta) if meta else None
    covr = find(b"covr", *ilst) if ilst else None
    if not covr:
        return None
    for box_kind, body_start, body_end in _mp4_boxes(data, *covr):
        if box_kind == b"data" and body_end - body_start > 8:
            image = data[body_start + 8:body_end]
            if _image_kind(image):
                return image
    return None


def _cover_from_flac(data: bytes):
    """flac: METADATA_BLOCK_PICTURE (tür 6). Ön kapak (tip 3) tercih edilir."""
    if data[:4] != b"fLaC":
        return None
    position = 4
    found = []
    while position + 4 <= len(data):
        header = data[position]
        last = bool(header & 0x80)
        kind = header & 0x7F
        length = int.from_bytes(data[position + 1:position + 4], "big")
        body = data[position + 4:position + 4 + length]
        position += 4 + length
        if kind == 6 and len(body) >= 32:
            picture_type = int.from_bytes(body[0:4], "big")
            cursor = 4
            mime_len = int.from_bytes(body[cursor:cursor + 4], "big")
            cursor += 4 + mime_len
            desc_len = int.from_bytes(body[cursor:cursor + 4], "big")
            cursor += 4 + desc_len + 16          # genişlik, yükseklik, derinlik, renk sayısı
            data_len = int.from_bytes(body[cursor:cursor + 4], "big")
            cursor += 4
            image = body[cursor:cursor + data_len]
            if _image_kind(image):
                found.append((image, picture_type))
        if last:
            break
    if not found:
        return None
    for image, picture_type in found:
        if picture_type == 3:
            return image
    return found[0][0]


def _embedded_cover(path: pathlib.Path):
    """Dosyadaki gömülü kapağın HAM baytları ya da None. Salt okunur; bilinmeyen biçim -> None."""
    suffix = path.suffix.lower()
    with path.open("rb") as handle:
        head = handle.read(10)
        if head[:3] == b"ID3":
            size = _syncsafe(head[6:10])
            if size > COVER_ID3_MAX_BYTES:
                return None
            return _cover_from_id3(head + handle.read(size))
        if head[:4] == b"fLaC":
            return _cover_from_flac(head + handle.read())
        if suffix in (".m4a", ".mp4", ".m4b", ".aac") or head[4:8] == b"ftyp":
            return _cover_from_mp4(head + handle.read())
    return None


def _scale_cover(image: bytes) -> bytes:
    """Büyük resmi ffmpeg ile COVER_MAX_PX'e küçültür (JPEG). ffmpeg yoksa ya da patlarsa ham resim."""
    exe = shutil.which("ffmpeg")
    if exe is None:
        return image
    try:
        proc = subprocess.run(
            [exe, "-nostdin", "-v", "error", "-i", "pipe:0", "-frames:v", "1",
             "-vf", f"scale='min({COVER_MAX_PX},iw)':-2", "-q:v", "4", "-f", "mjpeg", "pipe:1"],
            input=image, capture_output=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return image
    if proc.returncode != 0 or not proc.stdout.startswith(b"\xff\xd8"):
        return image
    return proc.stdout


def _cover_for_song(find_input, song_id: str):
    """(baytlar, mime) ya da None. Salt okunur: input.* okunur, hiçbir dosya yazılmaz."""
    path = find_input(song_id)
    raw = _embedded_cover(path)
    if not raw:
        return None
    scaled = _scale_cover(raw)
    if scaled is raw and len(raw) > COVER_RAW_MAX_BYTES:
        return None                    # küçültülemedi ve telefona indirilemeyecek kadar büyük
    return scaled, _image_kind(scaled) or "image/jpeg"


def install(web, auth, gate, require_status, find_input, Response):
    """api() içinden çağrılır: GET /songs/{song_id}/cover. Kapak yoksa 204 (istemci "kapak yok" diye hatırlar); bu uç eski sürümde hiç
    yoktu, istemci 404'ü "sunucu bilmiyor" sayar. Salt okunur."""

    @web.get("/songs/{song_id}/cover")
    async def get_cover(song_id: str, _=auth):
        await gate.refresh()
        await require_status(song_id)
        try:
            async with gate.reading():
                found = await asyncio.to_thread(_cover_for_song, find_input, song_id)
        except FileNotFoundError:
            found = None                    # input.* silinmiş: kapak çıkarılamaz
        except Exception as error:          # bozuk etiket vb.: şarkı oynatmayı etkilemesin
            print(f"[cover] {song_id[:12]}: {type(error).__name__}: {str(error)[:200]}")
            found = None
        if not found:
            return Response(status_code=204, headers={"Cache-Control": "private, max-age=3600"})
        body, media = found
        return Response(content=body, media_type=media,
                        headers={"Cache-Control": "private, max-age=86400", "Content-Length": str(len(body))})
