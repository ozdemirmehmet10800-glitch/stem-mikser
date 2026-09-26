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


def main():
    app = load_app()
    for test in (test_parse_range, test_signature, test_gate, test_constants):
        print(f"\n--- {test.__name__} ---")
        test(app)
    print(f"\n{'=' * 60}")
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
