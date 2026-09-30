"""hifi_v2 birleştirmesinin yerel testi (torch/Modal GEREKMEZ, numpy yeter).

`_hifi_v2_compose`, demucs çıkışını yerinde düzeltir: SW'nin aldığı vokal,
piyano ve davul için demucs'un aynı isimli çıkışı (artık) other'a eklenir,
sonra stem SW'nin çıkışıyla değiştirilir. Kanıtlanan: toplam korunur, artık
hiçbir yere kaybolmaz, SW stem'leri BİREBİR gelir, şekil uyuşmazlığı HATA verir.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_hifi_compose.py
"""

import importlib.util
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_hifi_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SOURCES = ["drums", "bass", "other", "vocals", "guitar", "piano"]   # htdemucs_6s sirasi


def main() -> int:
    app = load_app()
    rng = np.random.default_rng(0)
    n = 4000

    check("boru hatti sabitleri", app.PIPELINE_HIFI == "hifi_v2"
          and app.HIFI_SW_STEMS == ("vocals", "piano", "drums"))

    demucs = rng.standard_normal((6, 2, n)).astype(np.float32) * 0.1
    sw = {name: rng.standard_normal((2, n)).astype(np.float32) * 0.2
          for name in app.HIFI_SW_STEMS}
    before = demucs.copy()
    expected_total = before.sum(axis=0) + sum(sw[name] for name in app.HIFI_SW_STEMS) \
        - sum(before[SOURCES.index(name)] for name in app.HIFI_SW_STEMS)

    stems = demucs.copy()
    residues = app._hifi_v2_compose(stems, SOURCES, sw)

    for name in app.HIFI_SW_STEMS:
        check(f"{name} stem'i SW ciktisiyla BIREBIR",
              np.array_equal(stems[SOURCES.index(name)], sw[name]))
    other = SOURCES.index("other")
    expected_other = before[other] + sum(before[SOURCES.index(n_)] for n_ in app.HIFI_SW_STEMS)
    check("artik other'a eklendi (o yonu)",
          np.allclose(stems[other], expected_other, atol=1e-6))
    for name in ("bass", "guitar"):
        index = SOURCES.index(name)
        check(f"{name} dokunulmadi", np.array_equal(stems[index], before[index]))
    # Toplam: demucs toplami + SW stem'leri. Artik atilmadi (other'a tasindi),
    # cift sayilmadi (yerindeki slot SW ile degisti).
    check("toplam korunuyor: demucs toplami + SW toplami",
          np.allclose(stems.sum(axis=0),
                      before.sum(axis=0) + sum(sw[x] for x in app.HIFI_SW_STEMS), atol=1e-4))
    for name in app.HIFI_SW_STEMS:
        expected = float(np.sqrt(np.mean(before[SOURCES.index(name)].astype(np.float64) ** 2)))
        check(f"{name} artigi RMS'i dogru", abs(residues[name] - expected) < 1e-9)

    # artik, stem'i degistirmeden ONCE olculmeli (view'in uzerine yazilmasina karsi)
    check("artik RMS'i sifir degil", all(v > 0 for v in residues.values()))

    # sekil uyusmazligi HATA
    bad = {name: sw[name][:, :-1] for name in app.HIFI_SW_STEMS}
    try:
        app._hifi_v2_compose(demucs.copy(), SOURCES, bad)
        check("sekil uyusmazligi hata verir", False)
    except ValueError:
        check("sekil uyusmazligi hata verir", True)

    # eksik kaynak HATA (model beklenen isimleri tasimiyor)
    try:
        app._hifi_v2_compose(demucs.copy(), ["drums", "bass", "other", "vocals", "guitar"], sw)
        check("eksik kaynak hata verir", False)
    except ValueError:
        check("eksik kaynak hata verir", True)

    print(f"\ngecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
