"""Gomulu kapak (Gorsel yenileme 2): dosya icindeki kapagi cikarma + GET /songs/{id}/cover.

Yerel test, Modal/ffmpeg YOK: mp3 (ID3 v2.2/2.3/2.4), m4a (covr) ve flac (PICTURE) kapaklari SENTETIK dosyalarla
elle kuruluyor (gercek sarki yok). Uc nokta TestClient ile; Volume sahte. Salt okunur oldugu da dogrulaniyor:
sarki klasorunde hicbir dosya olusmuyor/degismiyor.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_cover_api.py
"""

import hashlib
import importlib.util
import json
import os
import pathlib
import struct
import sys
import tempfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def png(width=2, height=2, color=(200, 30, 30)):
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + bytes(range(64)) + b"\xff\xd9"
PNG = png()


def syncsafe(value):
    return bytes([(value >> 21) & 0x7F, (value >> 14) & 0x7F, (value >> 7) & 0x7F, value & 0x7F])


def apic_body(image, mime=b"image/jpeg", picture_type=3, desc=b"", encoding=0):
    if encoding in (1, 2):
        text = desc.decode("latin1").encode("utf-16-le") if desc else b""
        return bytes([encoding]) + mime + b"\x00" + bytes([picture_type]) + text + b"\x00\x00" + image
    return bytes([encoding]) + mime + b"\x00" + bytes([picture_type]) + desc + b"\x00" + image


def id3(frames, major=3, flags=0, ext=b"", padding=0):
    """frames: [(id, govde)] -> ID3 etiketi baytlari (+ sahte ses)."""
    out = b""
    for frame_id, body in frames:
        if major == 2:
            out += frame_id.encode() + len(body).to_bytes(3, "big") + body
        elif major == 4:
            out += frame_id.encode() + syncsafe(len(body)) + b"\x00\x00" + body
        else:
            out += frame_id.encode() + len(body).to_bytes(4, "big") + b"\x00\x00" + body
    out = ext + out + b"\x00" * padding
    return b"ID3" + bytes([major, 0, flags]) + syncsafe(len(out)) + out + b"\xff\xfb\x90\x00" + b"\x00" * 64


def box(kind, payload):
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def m4a(image, indicator=13):
    data_box = box(b"data", struct.pack(">II", indicator, 0) + image)
    ilst = box(b"ilst", box(b"covr", data_box))
    meta = box(b"meta", b"\x00\x00\x00\x00" + box(b"hdlr", b"\x00" * 24) + ilst)
    moov = box(b"moov", box(b"mvhd", b"\x00" * 100) + box(b"udta", meta))
    return box(b"ftyp", b"M4A \x00\x00\x00\x00M4A mp42isom") + moov + box(b"mdat", b"\x00" * 32)


def flac(pictures):
    """pictures: [(image, tip)] -> fLaC + STREAMINFO + PICTURE bloklari."""
    out = b"fLaC" + bytes([0x00]) + (34).to_bytes(3, "big") + b"\x00" * 34
    for index, (image, picture_type) in enumerate(pictures):
        body = (struct.pack(">I", picture_type) + struct.pack(">I", 10) + b"image/jpeg" + struct.pack(">I", 0)
                + struct.pack(">IIII", 2, 2, 24, 0) + struct.pack(">I", len(image)) + image)
        last = 0x80 if index == len(pictures) - 1 else 0
        out += bytes([last | 6]) + len(body).to_bytes(3, "big") + body
    return out + b"\xff\xf8" + b"\x00" * 32


class AioCallable:
    def __call__(self, *a, **k):
        pass

    async def aio(self, *a, **k):
        pass


class FakeVolume:
    def __init__(self):
        self.commit = AioCallable()
        self.reload = AioCallable()


def make_song(root, song_id, filename, content):
    base = pathlib.Path(root) / "songs" / song_id
    base.mkdir(parents=True, exist_ok=True)
    (base / "status.json").write_text(json.dumps({"id": song_id, "title": "Sentetik", "state": "done", "duration": 10.0,
                                                  "stems": ["vocals"], "stems_version": 1}), encoding="utf-8")
    if filename:
        (base / filename).write_bytes(content)
    return base


def snapshot(base):
    return sorted((p.name, hashlib.sha256(p.read_bytes()).hexdigest()) for p in base.rglob("*") if p.is_file())


def main():
    os.environ["API_TOKEN"] = "test-token"
    os.environ["SIGNING_KEY"] = "test-key"
    os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"
    spec = importlib.util.spec_from_file_location("app_cover_api", ROOT / "backend" / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)

    tmp = tempfile.mkdtemp()
    work = pathlib.Path(tmp)

    def extract(name, content):
        path = work / name
        path.write_bytes(content)
        return app._embedded_cover(path)

    # ---------------- bicim ayrıştırıcıları (saf)
    check("jpeg/png/webp/gif sihirli baytlari taninir",
          app._image_kind(JPEG) == "image/jpeg" and app._image_kind(PNG) == "image/png"
          and app._image_kind(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp" and app._image_kind(b"GIF89a....") == "image/gif")
    check("bilinmeyen baytlar resim sayilmaz", app._image_kind(b"%PDF-1.4") is None and app._image_kind(b"") is None)
    check("syncsafe", app._syncsafe(syncsafe(123456)) == 123456)

    check("mp3 ID3v2.3 APIC (jpeg)", extract("a.mp3", id3([("TIT2", b"\x00Sentetik"), ("APIC", apic_body(JPEG))], 3)) == JPEG)
    check("mp3 ID3v2.3 APIC (png)", extract("b.mp3", id3([("APIC", apic_body(PNG, b"image/png"))], 3)) == PNG)
    check("mp3 ID3v2.4 (syncsafe boyut)", extract("c.mp3", id3([("TPE1", b"\x03Sanatci"), ("APIC", apic_body(JPEG, encoding=3))], 4)) == JPEG)
    check("mp3 ID3v2.2 (PIC)", extract("d.mp3", id3([("PIC", b"\x00JPG\x03\x00" + JPEG)], 2)) == JPEG)
    check("mp3 aciklama UTF-16 (iki baytlik sonlandirici)", extract("e.mp3", id3([("APIC", apic_body(JPEG, desc=b"Kapak", encoding=1))], 3)) == JPEG)
    check("mp3 dolgu (padding) sonrasi cerceve aranmaz, onceki bulunur",
          extract("f.mp3", id3([("APIC", apic_body(JPEG))], 3, padding=64)) == JPEG)
    check("mp3 genisletilmis baslik (v2.3) atlanir",
          extract("g.mp3", id3([("APIC", apic_body(JPEG))], 3, flags=0x40, ext=(6).to_bytes(4, "big") + b"\x00" * 6)) == JPEG)
    check("mp3 iki resim: on kapak (tip 3) tercih edilir",
          extract("h.mp3", id3([("APIC", apic_body(PNG, b"image/png", picture_type=0)), ("APIC", apic_body(JPEG, picture_type=3))], 3)) == JPEG)
    check("mp3 yalniz arka kapak (tip 4): yine de ilk resim", extract("i.mp3", id3([("APIC", apic_body(JPEG, picture_type=4))], 3)) == JPEG)
    check("mp3 kapaksiz -> None", extract("j.mp3", id3([("TIT2", b"\x00Sentetik")], 3)) is None)
    check("mp3 APIC icinde resim degil -> None", extract("k.mp3", id3([("APIC", apic_body(b"yazi degil, resim yok"))], 3)) is None)
    check("mp3 bozuk/kesik etiket cokmez", extract("l.mp3", b"ID3\x03\x00\x00\x00\x00\x00\x40APIC\x00\x00") is None)
    check("mp3 etiketsiz (ham cerceve) -> None", extract("m.mp3", b"\xff\xfb\x90\x00" + b"\x00" * 200) is None)
    check("ID3 surum 5 (gecersiz) -> None", extract("n.mp3", b"ID3\x05\x00\x00\x00\x00\x00\x10" + b"\x00" * 32) is None)
    check("ID3 boyutu savunma siniri uzeri -> None", extract("o.mp3", b"ID3\x03\x00\x00" + syncsafe(app.COVER_ID3_MAX_BYTES + 1) + b"\x00" * 8) is None)
    # senkronizasyonsuz (unsync) etiket: 0xFF 0x00 -> 0xFF
    plain = id3([("APIC", apic_body(JPEG))], 3)
    frames_len = (plain[6] << 21) | (plain[7] << 14) | (plain[8] << 7) | plain[9]
    frames = plain[10:10 + frames_len].replace(b"\xff", b"\xff\x00")        # tum etiket senkronsuzlastirilir
    unsynced = b"ID3\x03\x00\x80" + syncsafe(len(frames)) + frames + b"\xff\xfb\x90\x00"
    check("mp3 unsynchronisation bayragi (v2.3) cozulur", extract("p.mp3", unsynced) == JPEG)

    check("m4a covr/data (jpeg)", extract("a.m4a", m4a(JPEG, 13)) == JPEG)
    check("m4a covr/data (png)", extract("b.m4a", m4a(PNG, 14)) == PNG)
    check("m4a kapaksiz (covr yok) -> None", extract("c.m4a", box(b"ftyp", b"M4A \x00\x00\x00\x00") + box(b"moov", box(b"mvhd", b"\x00" * 100))) is None)
    check("m4a kesik dosya cokmez", extract("d.m4a", m4a(JPEG)[:60]) is None)
    check("m4a uzanti olmadan da ftyp'ten taninir", extract("input.bin", m4a(JPEG)) == JPEG)

    check("flac PICTURE", extract("a.flac", flac([(JPEG, 3)])) == JPEG)
    check("flac iki resim: tip 3 secilir", extract("b.flac", flac([(PNG, 0), (JPEG, 3)])) == JPEG)
    check("flac resimsiz -> None", extract("c.flac", b"fLaC" + bytes([0x80]) + (34).to_bytes(3, "big") + b"\x00" * 34) is None)
    check("flac kesik PICTURE cokmez", extract("d.flac", flac([(JPEG, 3)])[:80]) is None)

    check("bilinmeyen biçim (wav) -> None", extract("a.wav", b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 64) is None)
    check("bos dosya -> None", extract("e.mp3", b"") is None)

    # ---------------- küçültme: ffmpeg yoksa ham resim
    real_which = app.shutil.which
    app.shutil.which = lambda name: None
    check("ffmpeg yoksa kucultme ham resmi doner", app._scale_cover(JPEG) is JPEG)
    app.shutil.which = real_which

    # ---------------- uç nokta (TestClient)
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    app.shutil.which = lambda name: None      # ffmpeg'e bagimli degil: ham resim
    from fastapi.testclient import TestClient
    client = TestClient(app.api.get_raw_f()())
    H = {"Authorization": "Bearer test-token"}

    MP3, M4A, NOCOVER, NOINPUT, HUGE = "a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64
    base_mp3 = make_song(tmp, MP3, "input.mp3", id3([("APIC", apic_body(JPEG))], 3))
    make_song(tmp, M4A, "input.m4a", m4a(PNG, 14))
    make_song(tmp, NOCOVER, "input.mp3", id3([("TIT2", b"\x00x")], 3))
    make_song(tmp, NOINPUT, None, b"")
    make_song(tmp, HUGE, "input.mp3", id3([("APIC", apic_body(JPEG + b"\x00" * (app.COVER_RAW_MAX_BYTES + 10)))], 3))

    before = snapshot(base_mp3)
    check("auth yok -> 401", client.get(f"/songs/{MP3}/cover").status_code == 401)
    check("yanlis token -> 401", client.get(f"/songs/{MP3}/cover", headers={"Authorization": "Bearer yanlis"}).status_code == 401)
    r = client.get(f"/songs/{MP3}/cover", headers=H)
    check("mp3 kapagi 200 + image/jpeg + ayni baytlar", r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content == JPEG,
          f"{r.status_code} {r.headers.get('content-type')}")
    check("Cache-Control private", "private" in r.headers.get("cache-control", ""))
    r = client.get(f"/songs/{M4A}/cover", headers=H)
    check("m4a kapagi 200 + image/png", r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content == PNG)
    r = client.get(f"/songs/{NOCOVER}/cover", headers=H)
    check("kapaksiz dosya -> 204 (bos govde)", r.status_code == 204 and r.content == b"")
    r = client.get(f"/songs/{NOINPUT}/cover", headers=H)
    check("input dosyasi yoksa -> 204 (hata degil)", r.status_code == 204)
    r = client.get(f"/songs/{HUGE}/cover", headers=H)
    check("kucultulemeyen devasa ham resim -> 204", r.status_code == 204)
    check("bilinmeyen sarki -> 404", client.get(f"/songs/{'9' * 64}/cover", headers=H).status_code == 404)
    check("gecersiz kimlik (../) -> 400/404, dosya sistemine inilmez",
          client.get("/songs/..%2f..%2fweights/cover", headers=H).status_code in (400, 404)
          and client.get("/songs/not-a-hash/cover", headers=H).status_code == 400)
    check("SALT OKUNUR: sarki klasoru ayni (dosya eklenmedi/degismedi)", snapshot(base_mp3) == before)
    check("kimlik deseni kapak ucunda da zorunlu", client.get(f"/songs/{MP3.upper()}/cover", headers=H).status_code == 400)

    print()
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
