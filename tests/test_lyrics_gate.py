"""Söz (Asama 11) kapilari ve yardimcilari: yerel test, Modal/GPU yok.

SENTETIK veri kullanir: gercek sarki sozu YOK (telifli, depo public). Kapsam:
metin dogrulama, enerji maskesi, kisa/tekrar suzgecleri, "metin sesle uyusmuyor"
esigi (olculen 4 cift), sema, dil secimi, "eski ayristirmadan" isareti,
_sub_drop'un sozlere dokunmamasi, hata durumunda onceki kaydin geri konmasi.

Calistirma (numpy gerekir, .venv'de var):
    .\\.venv\\Scripts\\python.exe tests\\test_lyrics_gate.py
"""

import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_lyrics_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeVolume:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1

    def reload(self):
        pass


def tone(seconds, amplitude, rate=16000):
    t = np.arange(int(seconds * rate)) / rate
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def word(s, e, w, p=0.9):
    return {"s": s, "e": e, "w": w, "p": p}


def line(start, end, text, words=None):
    return {"start": start, "end": end, "text": text, "words": words or []}


def test_text(app):
    lines, problem = app._lyr_check_text("  bir  iki \n\n\r\nuc\t dort  \n")
    check("metin: bosluklar sadelesir, bos satirlar atilir",
          problem is None and lines == ["bir iki", "uc dort"], str(lines))
    check("metin: denetim karakteri silinir",
          app._lyr_check_text("a\x00b\x07c")[0] == ["abc"])
    check("metin: bos -> hata", app._lyr_check_text("  \n \n")[1] is not None)
    check("metin: str degil -> hata", app._lyr_check_text(None)[1] is not None
          and app._lyr_check_text(12)[1] is not None)
    check("metin: karakter siniri",
          app._lyr_check_text("a" * (app.LYRICS_MAX_CHARS + 1))[1] is not None
          and app._lyr_check_text("a" * app.LYRICS_MAX_CHARS)[1] is None)
    many = "\n".join(["x"] * (app.LYRICS_MAX_LINES + 1))
    check("metin: satir siniri", app._lyr_check_text(many)[1] is not None
          and app._lyr_check_text("\n".join(["x"] * app.LYRICS_MAX_LINES))[1] is None)
    check("metin: Japonca ve Turkce harfler korunur",
          app._lyr_check_text("うっせぇわ\nİstanbul ışık")[0] == ["うっせぇわ", "İstanbul ışık"])


def test_activity(app):
    # 10 sn ses (-20 dBFS civari) + 5 sn sessizlik + 3 sn ses + 1 sn sessizlik (kisa) + 2 sn ses
    audio = np.concatenate([tone(10, 0.14), np.zeros(5 * 16000, np.float32), tone(3, 0.14),
                            np.zeros(16000, np.float32), tone(2, 0.14)])
    levels = app._lyr_levels(audio)
    check("seviye: ses ~ -23 dBFS", -26 < float(levels[10]) < -20, str(levels[10]))
    check("seviye: sessizlik <= -50", float(levels[11 * 20]) <= -50)
    active, threshold, p95 = app._lyr_activity(levels)
    check("esik: mutlak -50 ile tepe-40'in buyugu", threshold == max(-50.0, p95 - 40.0), str(threshold))
    silences = app._lyr_silences(active)
    check("sessizlik: yalniz >= 2 sn'lik bolge (5 sn), 1 sn'lik degil",
          len(silences) == 1 and abs((silences[0][1] - silences[0][0]) * app.LYRICS_HOP - 5.0) < 0.2,
          str(silences))
    inside = [line(11.0, 13.0, "x"), line(2.0, 4.0, "y"), line(7.0, 12.0, "z")]
    check("sessizde satir sayisi: tam icerde 1, disarda 0, %40 icerde sayilmaz",
          app._lyr_lines_in_silence(inside, silences) == 1,
          str(app._lyr_lines_in_silence(inside, silences)))
    gap = app._lyr_fill_gaps(np.array([1, 0, 0, 1, 0, 0, 0, 0, 0, 1], bool), 3)
    check("nefes boslugu doldurulur, uzun bosluk korunur",
          list(gap) == [True, True, True, True, False, False, False, False, False, True], str(list(gap)))


def test_filters(app):
    active = np.zeros(1000, bool)
    active[0:200] = True          # 0-10 sn
    active[400:600] = True        # 20-30 sn
    # kelime orta noktasi sessizde -> kelime atilir; satir araligi kalan kelimelerden
    l1 = line(1.0, 8.0, "a b c", [word(1.0, 2.0, " a"), word(2.0, 3.0, " b"), word(14.0, 15.0, " c")])
    out = app._lyr_mask_filter([l1], active)
    check("maske: sessiz kelime atilir, satir araligi daralir",
          len(out) == 1 and [w["w"] for w in out[0]["words"]] == [" a", " b"]
          and out[0]["start"] == 1.0 and out[0]["end"] == 3.0 and out[0]["text"] == "a b", str(out))
    l2 = line(12.0, 17.0, "x y", [word(12.0, 13.0, " x"), word(14.0, 15.0, " y")])
    check("maske: tum kelimeleri sessizde olan satir atilir", app._lyr_mask_filter([l2], active) == [])
    l3 = line(12.0, 16.0, "kelimesiz")
    l4 = line(21.0, 25.0, "kelimesiz sesli")
    check("maske: kelime bilgisi yoksa cerceve oranina bakilir (sessiz atilir, sesli kalir)",
          app._lyr_mask_filter([l3, l4], active) == [l4])
    ja = line(1.0, 3.0, "x", [word(1.0, 1.5, "う"), word(1.5, 2.0, "っ"), word(2.0, 2.5, "せぇ")])
    check("Japonca: kelimeler bitisik birlesir (bosluk yok)",
          app._lyr_mask_filter([ja], active)[0]["text"] == "うっせぇ")
    check("tr/en: bosluklu birlesir", app._lyr_join([word(0, 1, " hello"), word(1, 2, " world")]) == "hello world")

    lines = [line(0, 2, "tamam"), line(2, 2.1, "cok kisa"), line(3, 5, "?!"), line(5, 7, "a"),
             line(7, 9, "dokuz harf")]
    cleaned = app._lyr_clean_lines(lines)
    check("temizlik: cok kisa sureli, harfsiz ve tek harfli satirlar atilir",
          [x["text"] for x in cleaned] == ["tamam", "dokuz harf"], str([x["text"] for x in cleaned]))
    rep = [line(i * 2, i * 2 + 1.5, "tekrar") for i in range(6)] + [line(20, 22, "baska")]
    cleaned = app._lyr_clean_lines(rep)
    check("temizlik: ayni satir art arda en cok 3 kez",
          [x["text"] for x in cleaned] == ["tekrar"] * app.LYRICS_MAX_REPEATS + ["baska"],
          str([x["text"] for x in cleaned]))
    spaced = app._lyr_clean_lines([line(0, 2, "  bosluklu  ")])
    check("temizlik: metin kirpilir", spaced[0]["text"] == "bosluklu")


def test_mismatch(app):
    # Olculen 4 hizalama (sentetik degil, SAYILAR): uyusan zeus 0.766 / nem 0.488; uyusmayan
    # zeus sesi+nem metni 0.153 (0 sessiz), nem sesi+zeus metni 0.052 (3/59 sessiz)
    cases = [
        ("uyusan Zeus", {"silent_lines": 0, "silent_line_ratio": 0.0, "mean_word_prob": 0.766}, False),
        ("uyusan NEM slowed+reverb", {"silent_lines": 0, "silent_line_ratio": 0.0, "mean_word_prob": 0.488}, False),
        ("uyusmayan (Zeus sesi + baska metin)",
         {"silent_lines": 0, "silent_line_ratio": 0.0, "mean_word_prob": 0.153}, True),
        ("uyusmayan (NEM sesi + baska metin)",
         {"silent_lines": 3, "silent_line_ratio": 0.0508, "mean_word_prob": 0.052}, True),
        ("olasilik eksik, 2 sessiz satir %4",
         {"silent_lines": 2, "silent_line_ratio": 0.04, "mean_word_prob": None}, True),
        ("olasilik iyi ama 3/78 sessiz (Sina cover vakasi)",
         {"silent_lines": 3, "silent_line_ratio": 0.0385, "mean_word_prob": 0.4}, True),
        ("tek sessiz satir uyari vermez",
         {"silent_lines": 1, "silent_line_ratio": 0.2, "mean_word_prob": 0.6}, False),
        ("olasilik sinirda 0.30 uyari vermez",
         {"silent_lines": 0, "silent_line_ratio": 0.0, "mean_word_prob": 0.30}, False),
    ]
    for name, quality, expected in cases:
        check(f"uyusmazlik: {name} -> {expected}", app._lyr_mismatch(quality) is expected)
    silences = [(100, 200)]            # 5 sn-10 sn
    ql = app._lyr_quality([line(5, 9, "a", [word(5, 9, "a", 0.5)]), line(1, 2, "b", [word(1, 2, "b", 0.7)])], silences)
    check("kalite: sessiz satir, oran ve ortalama olasilik",
          ql == {"silent_lines": 1, "silent_line_ratio": 0.5, "mean_word_prob": 0.6}, str(ql))
    check("kalite: bos liste cokmez", app._lyr_quality([], [])["silent_lines"] == 0)


def test_doc(app):
    lines = [line(1.234, 3.456, "merhaba dunya", [word(1.234, 2.0, " merhaba"), word(2.0, 3.456, " dunya")]),
             line(5.0, 6.0, "sozsuz")]
    doc = app._lyr_doc("auto", "tr", lines, 158.287, 1234567)
    check("sema: ust alanlar", doc["schema"] == 1 and doc["version"] == 1234567 and doc["source"] == "auto"
          and doc["language"] == "tr" and doc["duration"] == 158.29, str({k: v for k, v in doc.items() if k != "lines"}))
    check("sema: satir t/e/text/w, kelimeler [bas, bit, kelime] kirpilmis",
          doc["lines"][0] == {"t": 1.23, "e": 3.46, "text": "merhaba dunya",
                              "w": [[1.23, 2.0, "merhaba"], [2.0, 3.46, "dunya"]]}, str(doc["lines"][0]))
    check("sema: kelimesiz satir bos w", doc["lines"][1]["w"] == [])
    check("sema: JSON'a Japonca duzgun yazilir",
          "うっ" in json.dumps(app._lyr_doc("pasted", "ja", [line(0, 1, "うっせぇ")], 1, 1), ensure_ascii=False))


def test_language(app):
    scores = [{"tr": 0.9, "en": 0.05, "ko": 0.01}, {"tr": 0.2, "en": 0.7}, {"tr": 0.8, "en": 0.1}]
    lang, detail = app._lyr_pick_language(scores)
    check("dil: toplam olasilikla kazanan", lang == "tr" and detail["windows"] == 3, str(detail))
    lang, _ = app._lyr_pick_language([{"ko": 0.99, "en": 0.004, "tr": 0.003, "ja": 0.001}])
    check("dil: yalniz tr/en/ja sayilir (Korece yuksek olsa da en'e duser)", lang == "en")
    lang, _ = app._lyr_pick_language([{"ko": 1.0}])
    check("dil: desteklenen dil olasiligi sifirsa None", lang is None)
    check("dil: pencere yok -> None", app._lyr_pick_language([])[0] is None)

    rate = app.LYRICS_RATE
    quiet = np.zeros(100 * rate, np.float32)
    quiet[40 * rate:75 * rate] = 0.2          # 40-75 sn gurultulu
    windows = app._lyr_language_windows(quiet)
    check("dil pencereleri: <= 4, 30 sn'lik, enerjili bolgeyi icerir",
          1 <= len(windows) <= 4 and all(len(w) == 30 * rate for w in windows)
          and max(float(np.abs(w).max()) for w in windows) > 0.1)
    short = app._lyr_language_windows(np.ones(10 * rate, np.float32))
    check("dil pencereleri: 30 sn'den kisa ses tek pencere", len(short) == 1)


def test_stale_and_drop(app):
    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()
    song = "a" * 64
    base = pathlib.Path(tmp) / "songs" / song
    (base / "master" / "sub").mkdir(parents=True)
    (base / "stems" / "sub").mkdir(parents=True)
    (base / "master" / "sub" / "lead.flac").write_bytes(b"x")
    (base / "lyrics.json").write_text('{"schema":1}', encoding="utf-8")
    status = {"id": song, "state": "done", "stems_version": 7, "sub": {"state": "done"},
              "lyrics": {"state": "done", "source": "pasted", "parent_stems_version": 7}}
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")

    check("stale: ayni surum -> degil", app._lyr_stale(status) is False)
    check("stale: ana sarki yeniden islendi (surum arttı) -> eski",
          app._lyr_stale(dict(status, stems_version=8)) is True)
    check("stale: durum done degilse hic", app._lyr_stale(
        {"stems_version": 9, "lyrics": {"state": "running", "parent_stems_version": 1}}) is False)
    check("stale: soz yoksa degil", app._lyr_stale({"stems_version": 1}) is False)

    app._sub_drop(song)
    after = json.loads((base / "status.json").read_text(encoding="utf-8"))
    check("_sub_drop: alt parcalar silinir", "sub" not in after and not (base / "master" / "sub").exists())
    check("_sub_drop: SOZLER silinmez (status.lyrics ve lyrics.json yerinde)",
          after["lyrics"]["source"] == "pasted" and (base / "lyrics.json").is_file())

    # hata -> onceki tamam kayit geri konur
    previous = {"state": "done", "source": "pasted", "version": 5}
    app._lyr_restore(song, previous, "patladi", "error")
    restored = json.loads((base / "status.json").read_text(encoding="utf-8"))["lyrics"]
    check("hata: onceki tamam kayit korunur + last_attempt",
          restored["state"] == "done" and restored["version"] == 5
          and restored["last_attempt"]["state"] == "error" and "patladi" in restored["last_attempt"]["message"],
          str(restored))
    app._lyr_restore(song, None, "yok", "error")
    fresh = json.loads((base / "status.json").read_text(encoding="utf-8"))["lyrics"]
    check("hata: onceki yoksa state=error", fresh["state"] == "error" and "last_attempt" not in fresh)
    app._lyr_restore(song, None, "sonuc yok", "no_lyrics")
    check("sonuc yok: state=no_lyrics",
          json.loads((base / "status.json").read_text(encoding="utf-8"))["lyrics"]["state"] == "no_lyrics")

    now = __import__("time").time()
    check("running: taze -> calisiyor",
          app._lyrics_is_running({"lyrics": {"state": "running", "started": int(now)}}) is True)
    check("running: takilmis (eski) -> degil",
          app._lyrics_is_running({"lyrics": {"state": "running", "started": int(now) - 99999}}) is False)
    check("running: kayit yok -> degil", app._lyrics_is_running({}) is False)
    check("silme engeli: sozler hazirlanirken",
          "Sozler" in (app._delete_block_reason(
              {"state": "done", "lyrics": {"state": "running", "started": int(now)}}) or ""))
    shutil.rmtree(tmp, ignore_errors=True)


def test_constants(app):
    check("kapi: vokal yok esigi alt parcayla ayni (-50 dBFS)", app.LYRICS_SILENT_DBFS == app.SUB_SILENT_DBFS == -50.0)
    check("dil kumesi tr/en/ja, modlar auto/pasted",
          app.LYRICS_LANGS == ("tr", "en", "ja") and app.LYRICS_MODES == ("auto", "pasted"))
    check("imaj ayri: separate_image ve sub_image'dan farkli nesne",
          app.lyrics_image is not app.separate_image and app.lyrics_image is not app.sub_image)


def main():
    app = load_app()
    for name, fn in (("metin", test_text), ("etkinlik", test_activity), ("suzgecler", test_filters),
                     ("uyusmazlik", test_mismatch), ("sema", test_doc), ("dil", test_language),
                     ("stale+drop", test_stale_and_drop), ("sabitler", test_constants)):
        print(f"\n--- {name}")
        fn(app)
    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
