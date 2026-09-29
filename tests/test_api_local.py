"""API yardimcilarinin yerel testi - Modal'a hic baglanmaz.

Kapsam: Range ayristirma, HMAC imzalama, ve _VolumeGate'in yazici/okuyucu
kilidi. Gate en riskli parca: Modal dokumani "acik dosya varken reload
'volume busy' ile patlar ve reload sirasinda volume BOS gorunur" diyor,
max_inputs=8 ile bu yaris gercek.

FastAPI baglantisi burada test EDILMIYOR; o modal serve + curl.exe ile
dogrulanacak (fastapi yerel venv'de kurulu degil).

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_api_local.py
"""

import asyncio
import importlib.util
import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location(
        "app_api_test", ROOT / "backend" / "app.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------


def test_parse_range(app):
    size = 1000
    check("bytes=0-99", app._parse_range("bytes=0-99", size) == (0, 99))
    check("bytes=100-", app._parse_range("bytes=100-", size) == (100, 999))
    check("son ek bytes=-200", app._parse_range("bytes=-200", size) == (800, 999))
    check("sonu asan aralik kirpilir",
          app._parse_range("bytes=900-5000", size) == (900, 999))
    check("bosluklu basliga dayanikli",
          app._parse_range(" bytes=0-9 ", size) == (0, 9))
    check("cok aralikli istekte ilki",
          app._parse_range("bytes=0-9,20-29", size) == (0, 9))
    check("buyuk/kucuk harf", app._parse_range("BYTES=0-9", size) == (0, 9))

    check("baslik yok -> None", app._parse_range("", size) is None)
    check("Range olmayan birim -> None", app._parse_range("items=0-9", size) is None)
    check("bozuk deger -> None", app._parse_range("bytes=abc-def", size) is None)

    for header in ("bytes=1000-1010", "bytes=2000-", "bytes=-0"):
        try:
            app._parse_range(header, size)
            check(f"karsilanamaz aralik hata verir ({header})", False)
        except ValueError:
            check(f"karsilanamaz aralik hata verir ({header})", True)


def test_signature(app):
    key = "cok-gizli-anahtar"
    exp = int(time.time()) + 600
    sig = app._sign_download(key, "abc123", "vocals", "wav", exp)
    check("imza deterministik",
          sig == app._sign_download(key, "abc123", "vocals", "wav", exp))
    check("imza sha256 uzunlugunda", len(sig) == 64, str(len(sig)))

    # Her alan imzaya giriyor mu?
    variants = {
        "song_id": ("abc124", "vocals", "wav", exp),
        "stem adi": ("abc123", "drums", "wav", exp),
        "format": ("abc123", "vocals", "flac", exp),
        "son kullanma": ("abc123", "vocals", "wav", exp + 1),
    }
    for label, args in variants.items():
        check(f"{label} degisince imza degisiyor",
              app._sign_download(key, *args) != sig)
    check("anahtar degisince imza degisiyor",
          app._sign_download("baska-anahtar", "abc123", "vocals", "wav", exp) != sig)


class StubVolume:
    """volume.reload.aio()'yu taklit eder ve cagrilari kaydeder."""

    def __init__(self, delay=0.0):
        self.delay = delay
        self.calls = []
        self.during = []
        self.reload = self._Reload(self)

    class _Reload:
        def __init__(self, parent):
            self._parent = parent

        async def aio(self):
            self._parent.calls.append(time.monotonic())
            if self._parent.delay:
                await asyncio.sleep(self._parent.delay)


def test_gate(app):
    async def scenario():
        stub = StubVolume()
        app.volume = stub  # modul globali; refresh() cagri aninda bakiyor
        gate = app._VolumeGate(ttl=10.0)

        did = await gate.refresh()
        check("ilk refresh reload yapiyor", did and len(stub.calls) == 1,
              str(len(stub.calls)))

        did = await gate.refresh()
        check("TTL icinde ikinci refresh atlaniyor", did is False and len(stub.calls) == 1,
              str(len(stub.calls)))

        did = await gate.refresh(force=True)
        check("force TTL'i gecersiz kiliyor", did and len(stub.calls) == 2,
              str(len(stub.calls)))

        # ASIL YARIS: okuma surerken reload beklemeli
        order = []

        async def reader():
            async with gate.reading():
                order.append("okuma-basladi")
                await asyncio.sleep(0.15)
                order.append("okuma-bitti")

        async def reloader():
            await asyncio.sleep(0.05)  # okuma zaten basladi
            order.append("reload-istendi")
            await gate.refresh(force=True)
            order.append("reload-bitti")

        await asyncio.gather(reader(), reloader())
        check("reload acik okumayi bekledi",
              order == ["okuma-basladi", "reload-istendi", "okuma-bitti",
                        "reload-bitti"],
              " -> ".join(order))

        # Reload sirasinda YENI okuma giremez (volume bos gorunecegi icin)
        slow = StubVolume(delay=0.15)
        app.volume = slow
        gate2 = app._VolumeGate(ttl=0.0)
        order2 = []

        async def late_reader():
            await asyncio.sleep(0.05)  # reload basladiktan sonra
            order2.append("okuma-denendi")
            async with gate2.reading():
                order2.append("okuma-girdi")

        async def first_reload():
            order2.append("reload-basladi")
            await gate2.refresh(force=True)
            order2.append("reload-bitti")

        await asyncio.gather(first_reload(), late_reader())
        check("reload sirasinda yeni okuma bekliyor",
              order2.index("okuma-girdi") > order2.index("reload-bitti"),
              " -> ".join(order2))

        # Es zamanli okumalar birbirini beklemiyor
        app.volume = StubVolume()
        gate3 = app._VolumeGate(ttl=10.0)
        started = time.monotonic()

        async def quick_reader():
            async with gate3.reading():
                await asyncio.sleep(0.1)

        await asyncio.gather(*[quick_reader() for _ in range(6)])
        elapsed = time.monotonic() - started
        check("6 es zamanli okuma paralel calisti", elapsed < 0.3,
              f"{elapsed:.2f} sn (sirayla olsaydi ~0.6)")

        # Sayac sifirlanip idle geri geliyor mu
        check("okuyucu sayaci sifirlandi", gate3._readers == 0, str(gate3._readers))
        check("idle bayragi geri geldi", gate3._idle.is_set())

    asyncio.run(scenario())


def test_constants(app):
    check("indirme linki 10 dakika", app.DOWNLOAD_TTL == 600, str(app.DOWNLOAD_TTL))
    check("formatlar m4a/flac/wav",
          set(app.DOWNLOAD_FORMATS) == {"m4a", "flac", "wav"},
          str(app.DOWNLOAD_FORMATS))
    check("localhost origin'leri var",
          any("localhost" in o for o in app.LOCAL_ORIGINS))
    check("yukleme siniri 30 MB", app.MAX_UPLOAD_BYTES == 30 * 1024 * 1024)
    check("api fonksiyonu kayitli", "api" in app.app.registered_functions)



def test_vendored_msst(app):
    """Depoya alinmis MSST dosyalari ve torch 2.5.1 yamasi.

    Bu testler GPU yolunu KOSTURMUYOR (yerelde torch yok) - onu
    `modal run backend/app.py::hifi_smoke` yapiyor. Buradaki is, yeniden
    vendor edilirken yamanin sessizce kaybolmasini yakalamak.
    """
    import ast

    vendor = pathlib.Path(app.MSST_LOCAL)
    check("vendor dizini var", vendor.is_dir(), str(vendor))
    wanted = [
        "LICENSE",
        "README.md",
        "models/__init__.py",
        "models/bs_roformer/__init__.py",
        "models/bs_roformer/attend.py",
        "models/bs_roformer/bs_roformer.py",
        "models/bs_roformer/mel_band_roformer.py",
        "utils/__init__.py",
        "utils/model_utils.py",
    ]
    missing = [name for name in wanted if not (vendor / name).is_file()]
    check("vendor dosyalarinin hepsi yerinde", not missing, str(missing))

    bad = []
    for path in sorted(vendor.rglob("*.py")):
        try:
            compile(path.read_text(encoding="utf-8"), str(path), "exec")
        except SyntaxError as error:
            bad.append(f"{path.name}: {error}")
    check("vendor .py dosyalari derleniyor", not bad, str(bad))

    license_text = (vendor / "LICENSE").read_text(encoding="utf-8")
    check("LICENSE MIT ve telif sahibi yaziyor",
          "MIT License" in license_text and "ZFTurbo" in license_text)

    attend = (vendor / "models/bs_roformer/attend.py").read_text(encoding="utf-8")
    check("attend.py'de commit hash'i yazili", app.MSST_SHA in attend)
    check("yamali cagri yerinde", "with _sdpa_kernel_compat():" in attend)
    check("yamasiz cagri kalmadi",
          "with sdpa_kernel(INFERENCE_SDPA_BACKENDS, set_priority=True):"
          not in attend)

    # Yamanin DAVRANISI: sadece metin degil, gercekten dusuyor mu?
    # Dosyanin tamami import edilemiyor (torch yok), o yuzden yalnizca
    # _sdpa_kernel_compat dugumu derlenip sahte bir sdpa_kernel'e baglaniyor.
    tree = ast.parse(attend)
    nodes = [node for node in tree.body
             if isinstance(node, ast.FunctionDef) and node.name == "_sdpa_kernel_compat"]
    check("_sdpa_kernel_compat tanimi var", len(nodes) == 1)
    if nodes:
        module = ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[]))
        code = compile(module, "attend.py", "exec")

        def old_torch(backends, **kwargs):
            if kwargs:                      # torch 2.5.1: set_priority yok
                raise TypeError("unexpected keyword argument 'set_priority'")
            return "kwargsiz"

        def new_torch(backends, set_priority=False):
            return "set_priority=%s" % set_priority

        space = {"sdpa_kernel": old_torch, "INFERENCE_SDPA_BACKENDS": ["math"]}
        exec(code, space)
        check("torch 2.5.1'de kwarg'siz cagriya dusuyor",
              space["_sdpa_kernel_compat"]() == "kwargsiz")

        space = {"sdpa_kernel": new_torch, "INFERENCE_SDPA_BACKENDS": ["math"]}
        exec(code, space)
        check("yeni torch'ta ipucu geri kazaniliyor",
              space["_sdpa_kernel_compat"]() == "set_priority=True")

    source = (ROOT / "backend" / "app.py").read_text(encoding="utf-8")
    check("build'de MSST icin curl kalmadi", "curl -sSfL" not in source)
    check("separate uretim decode'unu cagiriyor",
          "_decode_pcm(input_path, samplerate, channels)" in source)
    check("hifi_smoke entrypoint'i kayitli",
          "hifi_smoke" in app.app.registered_entrypoints)
    check("hifi_smoke_run fonksiyonu kayitli",
          "hifi_smoke_run" in app.app.registered_functions)


def test_song_id_validation(app):
    """Silme uclarinin kimlik dogrulamasi.

    Asil derdi: "../" gibi bir kimlikle sarki klasoru DISINA, ozellikle model
    agirliklarina (/data/weights) ulasilamamasi. Silme ozyinelemeli oldugu icin
    burada bir kacak pahaliya gelir.
    """
    import pathlib

    valid = "a" * 64
    check("64 hex kimlik gecerli", app._is_valid_song_id(valid))
    check("gercekci sha256 gecerli",
          app._is_valid_song_id(
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))
    check("deney eki gecerli (-cfp32)", app._is_valid_song_id(valid + "-cfp32"))

    # --- yol kacisi denemeleri: HEPSI reddedilmeli --------------------------
    escapes = [
        "..",
        "../",
        "../..",
        "../weights",
        "../../weights",
        "../weights/bs_roformer_sw.ckpt",
        f"{valid}/../../weights",
        f"{valid}/..",
        "songs/../weights",
        "/data/weights",
        "/data/songs/" + valid,
        "\\..\\weights",
        "..\\..\\weights",
        ".",
        "./" + valid,
        valid + "/",
        valid + "/.",
        # yuzde kodlu haller: uvicorn yolu cozdukten SONRA bunlar gelir
        "%2e%2e%2fweights",
        "..%2fweights",
        # null bayt ve satir sonu ile kandirma
        valid + "\x00../weights",
        valid + "\n../weights",
        valid + "\x00",
        # baska kabuller
        "",
        " ",
        " " + valid,
        valid + " ",
        valid.upper(),                      # buyuk harf yok
        "g" * 64,                           # hex olmayan harf
        "a" * 63,                           # kisa
        "a" * 65,                           # uzun
        valid + "-",                        # bos ek
        valid + "-" + "x" * 13,             # cok uzun ek
        valid + "-CFP32",                   # ekte buyuk harf
        valid + "-c.p32",                   # ekte nokta
        valid + "--cfp32",
        "weights",
        "songs",
        "*",
        "~",
        "$HOME",
    ]
    bad = [item for item in escapes if app._is_valid_song_id(item)]
    check(f"{len(escapes)} kacis denemesi reddedildi", not bad, str(bad))

    # Tip karismasi: None/int/liste/bayt dizisi de reddedilmeli.
    others = [None, 0, 1, 3.5, True, [], {}, b"a" * 64, ("a",)]
    bad = [repr(item) for item in others if app._is_valid_song_id(item)]
    check("str olmayan kimlikler reddedildi", not bad, str(bad))

    # --- _safe_song_dir: gecerli kimlikte dogru yol, digerlerinde ValueError -
    songs_root = pathlib.Path(app.DATA_DIR) / "songs"
    resolved = app._safe_song_dir(valid)
    check("gecerli kimlikte dogru klasor",
          resolved == (songs_root / valid).resolve(), str(resolved))
    check("sonuc /data/songs altinda",
          songs_root.resolve() in resolved.parents, str(resolved))

    leaked = []
    for item in escapes + others:
        try:
            got = app._safe_song_dir(item)
        except ValueError:
            continue
        leaked.append(f"{item!r} -> {got}")
    check("kacis denemelerinde _safe_song_dir ValueError atti", not leaked,
          str(leaked))

    # Agirliklara ulasan bir yol URETILEMEDIGI de ayrica soylensin: silme
    # cagrisi volume yolunu f"songs/{id}" diye kuruyor, kimlik icinde ".."
    # olmadigi icin o dize de /weights'e cikamiyor.
    weights = pathlib.Path(app.WEIGHTS_DIR).resolve()
    reachable = []
    for item in escapes:
        try:
            got = app._safe_song_dir(item)
        except ValueError:
            continue
        if got == weights or weights in got.parents or got in weights.parents:
            reachable.append(f"{item!r} -> {got}")
    check("hicbir kimlik /weights'e ulasmiyor", not reachable, str(reachable))


def test_delete_block_reason(app):
    """Islenmekte olan sarki silinemez, biten silinebilir."""
    check("queued engelli", bool(app._delete_block_reason({"state": "queued"})))
    check("separating engelli",
          bool(app._delete_block_reason({"state": "separating"})))
    check("analyzing engelli",
          bool(app._delete_block_reason({"state": "analyzing"})))
    check("done serbest", app._delete_block_reason({"state": "done"}) is None)
    check("error serbest", app._delete_block_reason({"state": "error"}) is None)
    check("durum yoksa serbest", app._delete_block_reason(None) is None)
    check("bos sozluk serbest", app._delete_block_reason({}) is None)
    check("bilinmeyen durum serbest",
          app._delete_block_reason({"state": "zamazingo"}) is None)

    message = app._delete_block_reason({"state": "separating"})
    check("engel mesaji anlasilir",
          "silinemez" in message.lower() and "bekle" in message.lower(),
          message)

    check("BUSY_STATES done/error icermiyor",
          "done" not in app.BUSY_STATES and "error" not in app.BUSY_STATES)
    check("coklu silme siniri makul",
          isinstance(app.MAX_DELETE_IDS, int) and 1 < app.MAX_DELETE_IDS <= 1000,
          str(app.MAX_DELETE_IDS))


def test_stem_encoding(app):
    """Telefona giden m4a'lar: 256k, 48 kHz, mumkunse soxr.

    ffmpeg yerelde yok; `_run` degistirilip KOMUTUN kendisi sinaniyor.
    """
    import pathlib

    check("oynatma bit hizi 256k", app.AAC_BITRATE == "256k", app.AAC_BITRATE)
    check("stem ornekleme hizi 48 kHz", app.STEM_SAMPLE_RATE == 48000,
          str(app.STEM_SAMPLE_RATE))
    check("FLAC asillar 24-bit kaldi", app.FLAC_SUBTYPE == "PCM_24",
          app.FLAC_SUBTYPE)

    calls = []
    original_run = app._run

    class Fake:
        returncode = 0
        stdout = b""

    def record(cmd):
        calls.append(list(cmd))
        return Fake()

    # --- soxr'in oldugu durum -------------------------------------------
    app._run = record
    app._SOXR_OK = None
    try:
        used = app._encode_stem_m4a(pathlib.Path("a.flac"), pathlib.Path("a.m4a"), 2)
    finally:
        app._run = original_run
    check("soxr varsa soxr kullaniliyor", used == "soxr", used)
    check("tek ffmpeg cagrisi", len(calls) == 1, str(len(calls)))
    cmd = " ".join(calls[0]) if calls else ""
    check("aresample soxr filtresi var",
          "resampler=soxr" in cmd and "precision=28" in cmd, cmd[:160])
    check("cikis hizi 48000", "-ar" in calls[0]
          and calls[0][calls[0].index("-ar") + 1] == "48000", cmd[:160])
    check("bit hizi 256k", "256k" in calls[0], cmd[:160])
    check("aac kodlayici", "aac" in calls[0])
    check("faststart var", "+faststart" in calls[0])
    check("kanal sayisi veriliyor",
          "-ac" in calls[0] and calls[0][calls[0].index("-ac") + 1] == "2")
    check("kaynak FLAC asil", "a.flac" in cmd and "a.m4a" in cmd)
    # "-i" kendinden sonraki ilk belirteci girdi sayiyor: filtre ARAYA
    # girerse ffmpeg "-af"i dosya adi sanip patlar. Bu test onu yakaladi.
    check("-i'den hemen sonra girdi dosyasi geliyor",
          calls[0][calls[0].index("-i") + 1] == "a.flac",
          calls[0][calls[0].index("-i") + 1])
    check("-af girdiden SONRA",
          calls[0].index("-af") > calls[0].index("a.flac"),
          f"-af {calls[0].index('-af')} / a.flac {calls[0].index('a.flac')}")

    # --- soxr'in olmadigi durum: swr'ye dusmeli -------------------------
    calls.clear()
    attempts = {"n": 0}

    def failing(cmd):
        calls.append(list(cmd))
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("ffmpeg basarisiz: Unknown resampler soxr")
        return Fake()

    app._run = failing
    app._SOXR_OK = None
    try:
        used = app._encode_stem_m4a(pathlib.Path("b.flac"), pathlib.Path("b.m4a"), 2)
    finally:
        app._run = original_run
        app._SOXR_OK = None
    check("soxr yoksa swr'ye dusuluyor", used == "swr", used)
    check("iki deneme yapildi", len(calls) == 2, str(len(calls)))
    check("yedek komutta soxr yok", "soxr" not in " ".join(calls[1]),
          " ".join(calls[1])[:160])
    check("yedek komutta da 48000 var",
          calls[1][calls[1].index("-ar") + 1] == "48000")

    check("reencode entrypoint'i kayitli",
          "reencode" in app.app.registered_entrypoints)
    check("reencode_stems fonksiyonu kayitli",
          "reencode_stems" in app.app.registered_functions)

def main():
    app = load_app()
    for test in (test_parse_range, test_signature, test_gate, test_constants,
                 test_vendored_msst, test_song_id_validation,
                 test_delete_block_reason, test_stem_encoding):
        print(f"\n--- {test.__name__} ---")
        test(app)
    print(f"\n{'=' * 60}")
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
