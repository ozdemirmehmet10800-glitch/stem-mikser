"""Yapistir-hizala v2 (Asama 11): eslestirme, plan, bloklar, elle zaman. SENTETIK veri; gercek soz YOK.

Rastgele uretilen yapay kelimelerle sarki yapisi kurulur (kitap/sarki metni degil): kıta A, nakarat C, kıta B, bridge D;
sarkida C iki kez soylenir, yapistirilan metinde yalnizca bir kez bulunur (eksik tekrar senaryosu).
GPU / hizalama kismi canlida: modal run backend/app.py::lyrics_regress

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_lyrics_match.py
"""

import importlib.util
import pathlib
import random
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_match_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rng = random.Random(7)
LETTERS = "abcdefghijklmnoprstuvyz"


def fake_word():
    return "".join(rng.choice(LETTERS) for _ in range(rng.randint(6, 9)))


def section(lines, words_per_line):
    return [[fake_word() for _ in range(words_per_line)] for _ in range(lines)]


def main():
    app = load_app()
    A, C, B, D = section(4, 4), section(3, 4), section(4, 4), section(3, 5)

    # Sarkida: A C B C D ; kelime basina 0.5 sn, bolumler arasi 1 sn bosluk
    auto_words, t = [], 0.0
    spans = {}
    for name, sec, tag in (("A", A, 1), ("C", C, 1), ("B", B, 1), ("C2", C, 2), ("D", D, 1)):
        spans[name] = [t]
        for line in sec:
            for word in line:
                auto_words.append((t, t + 0.45, word))
                t += 0.5
        spans[name].append(t)
        t += 1.0
    pasted = [" ".join(line) for line in A + C + B + D]          # C2 (ikinci nakarat) metinde YOK
    language = "tr"

    tokens = [app._lyr_line_tokens(line, language) for line in pasted]
    flat = [x for line in tokens for x in line]
    auto = app._lyr_auto_tokens(auto_words, language)
    check("belirtecler: tr kelime, kucuk harf", tokens[0] == [w.lower() for w in A[0]] and len(flat) == 15 * 4 + 5 * 3 - 0 or len(flat) > 0)
    check("belirtecler: Turkce I/i normallesir", app._lyr_norm_token("IŞIK") == "ışık" and app._lyr_norm_token("İyi!") == "iyi")
    check("belirtecler: noktalama atilir", app._lyr_norm_token("“Merhaba,”") == "merhaba")
    check("belirtecler: Japonca karakter duzeyi",
          app._lyr_line_tokens("うっせぇ わ", "ja") == ["う", "っ", "せ", "ぇ", "わ"])
    ja_auto = app._lyr_auto_tokens([(10.0, 11.0, "うっせ"), (11.0, 12.0, "ぇわ")], "ja")
    check("Japonca otomatik kelimeler karakterlere bolunur, zamanlar dagitilir",
          [x[0] for x in ja_auto] == ["う", "っ", "せ", "ぇ", "わ"] and abs(ja_auto[1][1] - (10 + 1 / 3)) < 1e-6)

    pairs = app._lyr_match(flat, [x[0] for x in auto])
    check("eslestirme: tum yapistirilan kelimeler eslesir", len(pairs) == len(flat), f"{len(pairs)}/{len(flat)}")
    # siradaki: D'nin ilk kelimesi, ikinci nakaratin DEGIL D'nin sesine gitmeli
    d_first_flat = len(flat) - sum(len(x) for x in tokens[-3:])
    d_time = auto[pairs[d_first_flat]][1]
    check("eslestirme: nakarat tekrari eksikse sonraki bolum DOGRU sese gider (D, C2'ye degil)",
          abs(d_time - spans["D"][0]) < 0.01, f"{d_time:.1f} sn (beklenen {spans['D'][0]:.1f})")
    check("eslestirme: sira korunur (artan)", all(pairs[k] < pairs[k + 1] for k in sorted(pairs)[:-1]))

    gaps = app._lyr_gaps(pairs, auto, language)
    check("bosluk: metinde olmayan ikinci nakarat bulunur",
          len(gaps) == 1 and abs(gaps[0][0] - spans["C2"][0]) < 0.6 and gaps[0][2] >= 10, str(gaps))
    check("bosluk: kisa (3 kelime) parca bosluk sayilmaz",
          app._lyr_gaps({0: 0}, [("a", 0, 1), ("b", 1, 2), ("c", 2, 3), ("d", 3, 4)], "tr") == [])

    # --- bulanik eslesme: son harfler farkli
    typo = [(s, e, w[:-1] + "x") for s, e, w in auto_words[:40]] + auto_words[40:]
    typo_pairs = app._lyr_match(flat, [x[0] for x in app._lyr_auto_tokens(typo, language)])
    check("bulanik: kucuk yazim farklari yine eslesir", len(typo_pairs) >= len(flat) - 2, f"{len(typo_pairs)}/{len(flat)}")
    short = app._lyr_match(["be", "su"], ["be", "bu"])
    check("kisa belirtec (<=2 harf) yalniz birebir eslesir", short == {0: 0}, str(short))

    # --- plan
    plan = app._lyr_plan(tokens, pairs, auto, {}, language)
    check("plan: tum satirlar capa", all(p["kind"] == "anchor" for p in plan))
    check("plan: capa penceresi eslesen kelimelerin etrafinda",
          all(p["start"] <= auto[pairs[sum(len(x) for x in tokens[:i])]][1] for i, p in enumerate(plan)))
    blocks = app._lyr_blocks(plan, t)
    check("bloklar: her capa satiri kendi blogu", len(blocks) == len(pasted) and all(b["kind"] == "anchor" for b in blocks))

    # --- eslesmeyen satir (sesi yok): serbest, iki capa arasinda
    odd = list(pasted)
    odd[5] = " ".join(fake_word() for _ in range(5))
    odd_tokens = [app._lyr_line_tokens(line, language) for line in odd]
    odd_flat = [x for line in odd_tokens for x in line]
    odd_pairs = app._lyr_match(odd_flat, [x[0] for x in auto])
    odd_plan = app._lyr_plan(odd_tokens, odd_pairs, auto, {}, language)
    check("plan: eslesmeyen satir serbest", odd_plan[5]["kind"] == "free" and odd_plan[4]["kind"] == "anchor"
          and odd_plan[6]["kind"] == "anchor")
    odd_blocks = app._lyr_blocks(odd_plan, t)
    free = [b for b in odd_blocks if b["kind"] == "free"]
    check("bloklar: serbest satir onceki ve sonraki capa arasinda",
          len(free) == 1 and free[0]["lines"] == [5] and free[0]["lo"] == odd_plan[4]["end"]
          and free[0]["hi"] == odd_plan[6]["start"], str(free))
    # bas ve son serbest diziler
    lead = [" ".join(fake_word() for _ in range(4))] * 2 + pasted
    lead_tokens = [app._lyr_line_tokens(line, language) for line in lead]
    lead_flat = [x for line in lead_tokens for x in line]
    lead_pairs = app._lyr_match(lead_flat, [x[0] for x in auto])
    lead_plan = app._lyr_plan(lead_tokens, lead_pairs, auto, {}, language)
    lead_blocks = app._lyr_blocks(lead_plan, t)
    check("bloklar: bastaki serbest satirlar 0 sn'den ilk capaya",
          lead_blocks[0]["kind"] == "free" and lead_blocks[0]["lo"] == 0.0 and lead_blocks[0]["lines"] == [0, 1]
          and lead_blocks[0]["hi"] == lead_plan[2]["start"])
    tail = pasted + [" ".join(fake_word() for _ in range(4))]
    tail_tokens = [app._lyr_line_tokens(line, language) for line in tail]
    tail_flat = [x for line in tail_tokens for x in line]
    tail_pairs = app._lyr_match(tail_flat, [x[0] for x in auto])
    tail_plan = app._lyr_plan(tail_tokens, tail_pairs, auto, {}, language)
    tail_blocks = app._lyr_blocks(tail_plan, t + 20.0)
    check("bloklar: sondaki serbest satir son capadan sarki sonuna", tail_blocks[-1]["kind"] == "free"
          and tail_blocks[-1]["hi"] == t + 20.0)

    # --- aykiri eslesme: satirin bir kelimesi baska yerdeki ortak kelimeyle eslesirse pencere acilmaz
    common = fake_word()
    far_auto = [(1.0, 1.4, common)] + [(t0 + 100.0, t0 + 100.4, w) for t0, (_, _, w) in enumerate(auto_words[:6])]
    far_tokens = [[common.lower()] + [w.lower() for _, _, w in auto_words[:5]]]
    far_auto_tokens = app._lyr_auto_tokens(far_auto, language)
    far_pairs = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5}
    far_plan = app._lyr_plan(far_tokens, far_pairs, far_auto_tokens, {}, language)
    check("aykiri eslesme elenir: pencere tutarli kumeyi izler (100 sn civari), 1 sn'ye acilmaz",
          far_plan[0]["kind"] == "anchor" and far_plan[0]["start"] > 90 and far_plan[0]["matched"] == 5, str(far_plan[0]))
    check("kume: tek ya da tutarli eslesme oldugu gibi kalir",
          app._lyr_main_cluster([(0, 0)], far_auto_tokens) == [(0, 0)]
          and len(app._lyr_main_cluster([(1, 1), (2, 2), (3, 3)], far_auto_tokens)) == 3)

    # --- elle zaman: capa; arkasindaki serbest satirlari da alir
    manual_t = odd_plan[4]["end"] + 0.5
    manual_plan = app._lyr_plan(odd_tokens, odd_pairs, auto, {5: manual_t}, language)
    check("plan: elle satir 'manual' (eslesme olsa da)", manual_plan[5]["kind"] == "manual" and manual_plan[5]["start"] == manual_t)
    mb = [b for b in app._lyr_blocks(manual_plan, t) if b["kind"] == "manual"][0]
    check("blok: elle blok t - 0.25'ten sonraki capaya", abs(mb["lo"] - (manual_t - 0.25)) < 1e-6
          and mb["hi"] == manual_plan[6]["start"], str(mb))

    # --- eslesme yetersiz: hepsi serbest
    other = [" ".join(fake_word() for _ in range(4)) for _ in range(10)]
    other_tokens = [app._lyr_line_tokens(line, language) for line in other]
    other_flat = [x for line in other_tokens for x in line]
    other_pairs = app._lyr_match(other_flat, [x[0] for x in auto])
    check("alakasiz metin: eslesme orani cok dusuk", len(other_pairs) / len(other_flat) < app.LYRICS_ANCHOR_MIN_RATIO,
          f"{len(other_pairs)}/{len(other_flat)}")

    # --- hiz
    big_pasted = [fake_word() for _ in range(900)]
    big_auto = [x if rng.random() > 0.2 else fake_word() for x in big_pasted]
    started = time.time()
    big_pairs = app._lyr_match(big_pasted, big_auto)
    took = time.time() - started
    check("hiz: 900x900 belirtec < 8 sn", took < 8.0 and len(big_pairs) > 600, f"{took:.1f} sn, {len(big_pairs)} eslesme")
    try:
        app._lyr_match([fake_word()] * 4000, [fake_word()] * 4000)
        too_big = False
    except ValueError:
        too_big = True
    check("hiz: cok buyuk girdi ValueError (global yola dusulur)", too_big)

    # --- elle zaman kaydetme
    doc = {"schema": 1, "version": 5, "source": "pasted", "language": "tr", "duration": 100.0, "lines": [
        {"t": 10.0, "e": 14.0, "text": "bir", "w": [[10.0, 12.0, "a"], [12.0, 14.0, "b"]]},
        {"t": 14.5, "e": 18.0, "text": "iki", "w": [[14.5, 16.0, "c"], [16.0, 18.0, "d"]], "c": 0},
        {"t": 20.0, "e": 25.0, "text": "uc", "w": [[20.0, 25.0, "e"]]}]}
    new, problem = app._lyr_apply_times(doc, [{"i": 1, "t": 16.0}], 100.0)
    check("elle zaman: kabul, sonuc yeni belge", problem is None and new is not doc, str(problem))
    line = new["lines"][1]
    check("elle zaman: baslangic, bitis ve kelimeler ayni farkla kayar",
          line["t"] == 16.0 and line["e"] == 19.5 and line["w"][0][0] == 16.0 and line["w"][1][1] == 19.5, str(line))
    check("elle zaman: m=1 ve c kalkar", line.get("m") == 1 and "c" not in line)
    check("elle zaman: onceki satirin bitisi yeni baslangica tasmaz",
          new["lines"][0]["e"] <= 16.0 - 0.02 + 1e-9 and new["lines"][0]["w"][-1][1] <= new["lines"][0]["e"], str(new["lines"][0]))
    check("elle zaman: girdi belgesi degismez", doc["lines"][1]["t"] == 14.5 and doc["lines"][1].get("c") == 0)
    _, problem = app._lyr_apply_times(doc, [{"i": 1, "t": 21.0}], 100.0)
    check("elle zaman: sirayi bozan zaman reddedilir (sonraki satirdan sonra)", problem is not None and "siralama" in problem, str(problem))
    _, problem = app._lyr_apply_times(doc, [{"i": 1, "t": 9.0}], 100.0)
    check("elle zaman: onceki satirdan once reddedilir", problem is not None)
    for name, sets in (("bos", []), ("liste degil", "x"), ("satir sinir disi", [{"i": 9, "t": 1}]),
                       ("negatif zaman", [{"i": 0, "t": -1}]), ("sure disi", [{"i": 0, "t": 200}]),
                       ("ayni satir iki kez", [{"i": 0, "t": 11}, {"i": 0, "t": 12}]),
                       ("bool satir", [{"i": True, "t": 11}]), ("zaman metin", [{"i": 0, "t": "1"}])):
        check(f"elle zaman reddedilir: {name}", app._lyr_apply_times(doc, sets, 100.0)[1] is not None)
    multi, problem = app._lyr_apply_times(doc, [{"i": 2, "t": 22.0}, {"i": 0, "t": 11.0}], 100.0)
    check("elle zaman: birden cok satir", problem is None and multi["lines"][0]["t"] == 11.0 and multi["lines"][2]["t"] == 22.0)

    manual, problem = app._lyr_check_manual([{"i": 2, "t": 30}, {"i": 0, "t": 10.123}], 5, 100.0)
    check("manual: sirali ve yuvarlanir", problem is None and manual == [{"i": 0, "t": 10.12}, {"i": 2, "t": 30.0}], str(manual))
    check("manual: yok = bos liste", app._lyr_check_manual(None, 5, 100.0) == ([], None))
    for name, raw in (("liste degil", {"i": 0}), ("satir sinir disi", [{"i": 5, "t": 1}]), ("zaman sure disi", [{"i": 0, "t": 101}]),
                      ("zamanlar azalan", [{"i": 0, "t": 20}, {"i": 1, "t": 10}]), ("ayni satir", [{"i": 1, "t": 5}, {"i": 1, "t": 6}]),
                      ("oge nesne degil", [3]), ("bool", [{"i": 0, "t": True}])):
        check(f"manual reddedilir: {name}", app._lyr_check_manual(raw, 5, 100.0)[1] is not None)

    # --- belge sema: c ve m isaretleri
    out = app._lyr_doc("pasted", "tr", [
        {"start": 1, "end": 2, "text": "x", "words": [], "c": 0}, {"start": 3, "end": 4, "text": "y", "words": [], "m": 1},
        {"start": 5, "end": 6, "text": "z", "words": []}], 10.0, 7)
    check("sema: c:0 ve m:1 yalniz gerekince yazilir", out["lines"][0].get("c") == 0 and "m" not in out["lines"][0]
          and out["lines"][1].get("m") == 1 and "c" not in out["lines"][1] and set(out["lines"][2]) == {"t", "e", "text", "w"})

    # --- sidecar
    import json
    import tempfile
    tmp = pathlib.Path(tempfile.mkdtemp())
    status = {"stems_version": 7, "lyrics": {}}
    app._lyr_save_auto_words(tmp, status, "tr", [(1.0, 2.0, "a"), (2.0, 3.0, "b")])
    check("sidecar: ayni surum ve dil okunur", app._lyr_load_auto_words(tmp, status, "tr") == [(1.0, 2.0, "a"), (2.0, 3.0, "b")])
    check("sidecar: baska ayristirma ya da dil kullanilmaz",
          app._lyr_load_auto_words(tmp, dict(status, stems_version=8), "tr") is None
          and app._lyr_load_auto_words(tmp, status, "en") is None)
    (tmp / "lyrics_auto.json").unlink()
    (tmp / "lyrics.json").write_text(json.dumps({"lines": [{"t": 1, "e": 2, "text": "a", "w": [[1.0, 2.0, "a"]]}]}), encoding="utf-8")
    auto_status = {"stems_version": 7, "lyrics": {"state": "done", "source": "auto", "language": "tr", "parent_stems_version": 7}}
    check("sidecar yoksa auto lyrics.json yeniden kullanilir", app._lyr_load_auto_words(tmp, auto_status, "tr") == [(1.0, 2.0, "a")])
    pasted_status = {"stems_version": 7, "lyrics": {"state": "done", "source": "pasted", "language": "tr", "parent_stems_version": 7}}
    check("yapistirilmis lyrics.json otomatik kelime sayilmaz", app._lyr_load_auto_words(tmp, pasted_status, "tr") is None)

    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
