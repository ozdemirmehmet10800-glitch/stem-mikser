"""chords.json'i Moises referansiyla olcu olcu karsilastirir.

Referans: Hazbin Hotel "Addict" Turkce cover, Moises analizi.
Ton Fm, 127 BPM.

Kullanim:
    .\\.venv\\Scripts\\python.exe tests\\compare_reference.py
    .\\.venv\\Scripts\\python.exe tests\\compare_reference.py --offset 1
    .\\.venv\\Scripts\\python.exe tests\\compare_reference.py out\\<sha>\\chords.json

Onemli: ofset aramasi YALNIZCA tam olcu cinsinden yapilir. Yarim olcu ya da
vurus kaydirmasi denenmez - yoksa duzeltmeye calistigimiz 2 vurusluk kayma
gizlenir. Vurus duzeyindeki kayma ayrica olculup raporlanir.
"""

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# --------------------------------------------------------------------------
# Referans: olcu numarasi -> o olcude duyulan akorlar (yarim olcu sirasiyla)
# --------------------------------------------------------------------------
REFERENCE = {}
for _measure in range(2, 14):
    REFERENCE[_measure] = ["Fm"]
REFERENCE.update({
    14: ["Ab/C", "Db"],
    15: ["Eb", "Fm"],
    16: ["Ab/C", "Db"],
    17: ["Eb", "Ab"],
    18: ["Ab/C", "Db"],
    19: ["Eb", "Fm"],
    20: ["Ab/C", "Db"],
    21: ["Eb", "Ab"],
    22: ["Bbm"],
    23: ["Cm"],
    24: ["Fm", "Ab"],
    25: ["Db", "Dbmaj7"],
    26: ["Bbm7"],
    27: ["Cm7"],
})

REFERENCE_KEY = "Fm"
REFERENCE_BPM = 127.0
MAX_MEASURE = 55  # sarki.mp3 kesilmis montaj (~1:51); sonrasi karsilastirilmaz

# 7'li akorlar: sablon setimiz 24 triad, bunlar triad'a yuvarlanir.
SEVENTH_TO_TRIAD = {
    "Dbmaj7": "Db", "Bbm7": "Bbm", "Cm7": "Cm", "Abmaj7": "Ab",
    "Ebmaj7": "Eb", "Fm7": "Fm", "Eb7": "Eb", "C7": "C", "Ab7": "Ab",
}


def triad_of(label: str) -> str:
    """7'liyi triad'a indirir; slash'i korur."""
    base, _, bass = label.partition("/")
    base = SEVENTH_TO_TRIAD.get(base, base)
    return f"{base}/{bass}" if bass else base


def without_slash(label: str) -> str:
    return label.partition("/")[0]


# --------------------------------------------------------------------------
# Olculeri chords.json'dan cikar (app.py ile ayni mantik)
# --------------------------------------------------------------------------


def load_app():
    spec = __import__("importlib.util", fromlist=["util"]).spec_from_file_location(
        "app_under_test", ROOT / "backend" / "app.py"
    )
    module = __import__("importlib.util", fromlist=["util"]).module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def measure_beat_offset(data: dict) -> dict:
    """Downbeat'lerin beat gridindeki konumunu olcer.

    Referansla degil, kendi icinde: downbeat'ler beat listesinin kacinci
    elemanlarina denk geliyor ve bu fazin 4'e boluminden kalani ne. 2 vurusluk
    kayma varsa faz tutarli sekilde 2 cikar.
    """
    beats = data.get("beats") or []
    downbeats = data.get("downbeats") or []
    if not beats or not downbeats:
        return {"ok": False}

    index_of = {round(float(t), 3): i for i, t in enumerate(beats)}
    indices = [index_of[round(float(t), 3)] for t in downbeats
               if round(float(t), 3) in index_of]
    if len(indices) < 2:
        return {"ok": False}

    gaps = [indices[i + 1] - indices[i] for i in range(len(indices) - 1)]
    phases = sorted({i % 4 for i in indices})
    return {
        "ok": True,
        "matched": len(indices),
        "of": len(downbeats),
        "median_gap": sorted(gaps)[len(gaps) // 2],
        "phases": phases,
        "first_index": indices[0],
    }


def compare(data: dict, offset: int) -> dict:
    """offset: bizim 1. olcumuz referansin (1 + offset). olcusu."""
    app = load_app()
    bars = app._bars_from_chords(data)

    exact = 0
    triad_only = 0
    root_only = 0
    miss = 0
    rows = []

    for index, (start, labels) in enumerate(bars):
        measure = index + 1 + offset
        if measure > MAX_MEASURE:
            break
        expected = REFERENCE.get(measure)
        if expected is None:
            continue

        got = [triad_of(l) for l in labels]
        want = [triad_of(l) for l in expected]

        if got == want:
            verdict = "TAM"
            exact += 1
        elif [without_slash(l) for l in got] == [without_slash(l) for l in want]:
            verdict = "slash-fark"
            triad_only += 1
        elif set(without_slash(l) for l in got) & set(
            without_slash(l) for l in want
        ):
            verdict = "kismi"
            root_only += 1
        else:
            verdict = "YANLIS"
            miss += 1

        rows.append((measure, start, expected, labels, verdict))

    total = exact + triad_only + root_only + miss
    return {
        "rows": rows, "exact": exact, "slash": triad_only,
        "partial": root_only, "wrong": miss, "total": total,
    }


def score(result: dict) -> tuple:
    return (result["exact"] + result["slash"], result["partial"], -result["wrong"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("chords", nargs="?", help="chords.json yolu")
    parser.add_argument("--offset", type=int, default=None,
                        help="olcu ofseti (verilmezse tam olcu cinsinden aranir)")
    args = parser.parse_args()

    if args.chords:
        path = pathlib.Path(args.chords)
    else:
        candidates = sorted(ROOT.glob("out/*/chords.json"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        if not candidates:
            print("out/*/chords.json bulunamadi. Once analyze_only calistir.")
            return 1
        path = candidates[0]

    data = json.loads(path.read_text(encoding="utf-8"))
    print(f"dosya: {path}")
    print(f"ton  : {data.get('key')}   (referans: {REFERENCE_KEY})")
    print(f"bpm  : {data.get('bpm')}   (referans: {REFERENCE_BPM})")
    print(f"beat kaynagi: {data.get('beats_source')} / "
          f"downbeat: {data.get('downbeats_source')}")

    # --- vurus duzeyinde kayma (referanstan bagimsiz) ---
    beat_info = measure_beat_offset(data)
    print("\n--- vurus duzeyi olcum ---")
    if beat_info["ok"]:
        print(f"downbeat -> beat eslesmesi: {beat_info['matched']}/{beat_info['of']}")
        print(f"downbeat'ler arasi medyan vurus: {beat_info['median_gap']} "
              f"(4/4 icin 4 beklenir)")
        print(f"downbeat'lerin beat indeksi mod 4: {beat_info['phases']} "
              f"(tek deger = tutarli faz)")
        print(f"ilk downbeat'in beat indeksi: {beat_info['first_index']}")
    else:
        print("beat/downbeat verisi olcum icin yetersiz")

    # --- olcu hizalamasi: YALNIZCA tam olcu ---
    if args.offset is None:
        best = None
        for offset in range(-4, 9):  # tam olcu adimlariyla
            result = compare(data, offset)
            if result["total"] == 0:
                continue
            if best is None or score(result) > score(best[1]):
                best = (offset, result)
        if best is None:
            print("\nkarsilastirilacak olcu yok")
            return 1
        offset, result = best
        print(f"\nen iyi TAM OLCU ofseti: {offset:+d} "
              f"(yarim olcu/vurus kaydirmasi DENENMEDI)")
    else:
        offset = args.offset
        result = compare(data, offset)
        print(f"\nverilen ofset: {offset:+d}")

    print("\n--- olcu olcu ---")
    print(f"{'olcu':>4} {'zaman':>7}  {'referans':<22} {'bizim':<24} sonuc")
    for measure, start, expected, labels, verdict in result["rows"]:
        stamp = f"{int(start) // 60}:{int(start) % 60:02d}"
        print(f"{measure:>4} {stamp:>7}  {' '.join(expected):<22} "
              f"{' '.join(labels):<24} {verdict}")

    total = result["total"] or 1
    print("\n--- ozet ---")
    print(f"karsilastirilan olcu : {result['total']}")
    print(f"tam dogru            : {result['exact']:>3}  "
          f"({100 * result['exact'] / total:.0f}%)")
    print(f"akor dogru slash fark: {result['slash']:>3}  "
          f"({100 * result['slash'] / total:.0f}%)")
    print(f"kismi                : {result['partial']:>3}  "
          f"({100 * result['partial'] / total:.0f}%)")
    print(f"yanlis               : {result['wrong']:>3}  "
          f"({100 * result['wrong'] / total:.0f}%)")
    print(f"\nnot: 7'li akorlar triad'a indirilerek karsilastirildi "
          f"(sablon setimiz 24 triad).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
