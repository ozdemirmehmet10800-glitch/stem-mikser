"""Yapistir-hizala regresyon ozeti: backend/lyrics_out/probe_*.json dosyalarini karsilastirir.

Metin ICERMEZ (yalniz satir numaralari ve saniyeler). Dosyalari uretmek icin (GPU, Volume'a yazmaz):
    modal run backend/app.py::lyrics_regress --song Zeus --ref zeus.txt --method anchored --out zeus
    modal run backend/app.py::lyrics_regress --song Zeus --ref zeus.txt --method global   --out zeus
    modal run backend/app.py::lyrics_regress --song "nothing else" --ref nem.txt --method anchored --out nem [--drop 16-19]
    modal run backend/app.py::lyrics_regress --song HAZBIN --ref hazbin__live.json --method anchored --out hazbin
(HAZBIN metni canli lyrics.json'dan alinan yerel kopyadir: backend/lyrics_out/hazbin__live.json.)

Calistirma:
    python tests\\lyrics_regress.py
"""

import importlib.util
import json
import pathlib
import statistics
import sys

OUT = pathlib.Path(__file__).resolve().parent.parent / "backend" / "lyrics_out"
FAILED = []


def load(name):
    path = OUT / f"probe_{name}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def check(name, ok, detail=""):
    if not ok:
        FAILED.append(name)
    print(f"[{'OK  ' if ok else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def starts(probe):
    return [line[0] for line in probe["lines"]]


def diffs(a, b):
    return [abs(x - y) for x, y in zip(a, b)]


def summarize(label, values):
    return (f"{label}: medyan {statistics.median(values):.2f} sn, en buyuk {max(values):.2f} sn, "
            f">0,5 sn olan {sum(v > 0.5 for v in values)}/{len(values)}")


def load_app():
    spec = importlib.util.spec_from_file_location("app_regress", pathlib.Path(__file__).resolve().parent.parent / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def judge(app, song, ref, language):
    """Hakem: otomatik cikarmanin kelime zamanlari. Satirin ILK kelimesi eslesmisse o kelimenin zamani."""
    refs = pathlib.Path(__file__).resolve().parent.parent / "backend" / "lyrics_ref" / ref
    texts = [line.strip() for line in refs.read_text(encoding="utf-8").splitlines() if line.strip()]
    auto = json.loads((OUT / f"{song}__auto.json").read_text(encoding="utf-8"))["inputs"]["vocals"]["variants"]["stable_novad"]["lines"]
    auto_tokens = app._lyr_auto_tokens([(w["s"], w["e"], w["w"]) for l in auto for w in l.get("words", [])], language)
    tokens = [app._lyr_line_tokens(t, language) for t in texts]
    flat = [x for t in tokens for x in t]
    pairs = app._lyr_match(flat, [x[0] for x in auto_tokens])
    offset, truth = 0, {}
    for index, line in enumerate(tokens):
        if line and offset in pairs:
            truth[index] = auto_tokens[pairs[offset]][1]
        offset += len(line)
    result = {}
    for method in ("anchored", "global"):
        probe = load(f"{song}_{method}")
        errors = [abs(probe["lines"][i][0] - t) for i, t in truth.items()]
        result[method] = errors
        ordered = sorted(errors)
        print(f"{song} {method:8s}: hakem satir {len(errors)}, medyan hata {statistics.median(errors):.2f} sn, "
              f"p90 {ordered[int(0.9 * len(errors))]:.2f}, >0,5 sn {sum(e > 0.5 for e in errors)}, "
              f">1 sn {sum(e > 1 for e in errors)}, en buyuk {max(errors):.1f}")
    return result


def main():
    app = load_app()
    for song, ref, language, median_limit in (("zeus", "zeus.txt", "tr", 0.2), ("nem", "nem.txt", "en", 0.6)):
        if not (load(f"{song}_anchored") and load(f"{song}_global")):
            print(f"{song}: probe dosyalari yok, atlandi")
            continue
        errors = judge(app, song, ref, language)
        new, old = errors["anchored"], errors["global"]
        check(f"{song}: yeni yontem otomatik kelime zamanlarina gore medyan hata <= {median_limit} sn",
              statistics.median(new) <= median_limit, f"{statistics.median(new):.2f} sn")
        check(f"{song}: yeni yontem eskiden kotu degil (medyan)", statistics.median(new) <= statistics.median(old) + 0.05,
              f"yeni {statistics.median(new):.2f}, eski {statistics.median(old):.2f}")
        probe = load(f"{song}_anchored")["info"]
        print(f"   yontem {probe['method']}, eslesme {probe['match_ratio']}, capa {probe['anchor_lines']}/{len(load(f'{song}_anchored')['lines'])}, "
              f"dusuk guven {probe['low_confidence_lines']}, bosluk {probe['gaps']}")

    full, drop_new, drop_old = load("nem_anchored"), load("nem_anchored_drop"), load("nem_global_drop")
    if full and drop_new and drop_old:
        kept = drop_new["kept"]
        truth = [full["lines"][i][0] for i in kept]
        first_after = next((k for k in range(1, len(kept)) if kept[k] != kept[k - 1] + 1), None)
        e_new = diffs(starts(drop_new), truth)
        e_old = diffs(starts(drop_old), truth)
        print(summarize("nem tekrar silindi: yeni yontem hata (tam metinli yeni sonuca gore)", e_new))
        print(summarize("nem tekrar silindi: ESKI yontem hata", e_old))
        after = slice(first_after, None) if first_after is not None else slice(0, 0)
        check("nem: nakarat tekrari silinince yeni yontem sonraki satirlari +-0,5 sn icinde tutar",
              max(e_new[after] or [0]) <= 0.5, f"silinen bolum sonrasi en kotu {max(e_new[after] or [0]):.2f} sn")
        check("nem: eski yontem ayni senaryoda kayiyor (karsilastirma)", max(e_old[after] or [0]) > 1.0,
              f"eski yontem en kotu {max(e_old[after] or [0]):.1f} sn")
        print(f"   metinde olmayan bolumler (yeni): {drop_new['info']['gaps']}")

    new, old = load("hazbin_anchored"), load("hazbin_global")
    if new and old:
        n, o = starts(new), starts(old)
        print("hazbin: idx 28-36 yeni yontem baslangiclari:", [round(x, 1) for x in n[28:37]])
        print("hazbin: idx 28-36 ESKI yontem baslangiclari:", [round(x, 1) for x in o[28:37]])
        check("hazbin: 28.-36. satirlar (0'dan) ~273 sn civarina gider (265-320 sn arasi)",
              all(265 <= x <= 320 for x in n[28:37]), str([round(x, 1) for x in n[28:37]]))
        check("hazbin: eski yontem bu satirlari 253 sn'den once koyuyordu (karsilastirma)", all(x < 253 for x in o[28:37]))
        steady = [i for i in range(2, 28) if new["lines"][i][2] == 1]
        d = [abs(n[i] - o[i]) for i in steady]
        check("hazbin: guvenli satirlar (2-27) eski yontemden +-1,5 sn icinde", max(d) <= 1.5, summarize("fark", d))
        low = new["info"]["low_confidence_lines"]
        print(f"   dusuk guven satirlar (0'dan): {low} | bosluk: {new['info']['gaps']} | eslesme {new['info']['match_ratio']}")
        check("hazbin: metinde olmayan buyuk bolum bulundu (189-273 sn)",
              any(g[0] < 200 and g[1] > 260 for g in new["info"]["gaps"]), str(new["info"]["gaps"]))
        check("hazbin: satir baslangiclari artan", all(n[k] < n[k + 1] for k in range(len(n) - 1)))
        check("hazbin: satirlar sarki icinde", 0 <= n[0] and n[-1] < new["duration"])
        silent = [i for i in low if 94 < n[i] < 124]
        check("hazbin: dusuk guvenli satirlar enstrumantal araliga (95-123 sn) konmaz", not silent, str(silent))

    print("\n" + ("hepsi gecti" if not FAILED else f"{len(FAILED)} HATA"))
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
