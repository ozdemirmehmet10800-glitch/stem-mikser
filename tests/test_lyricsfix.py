"""Tekrar eden kıtada sıkışan kopya düzeltmesi (backend/lyricsfix.py), app.py'nin GERÇEK _lyr_plan'ıyla. SENTETİK satırlar (gerçek söz yok).

Senaryo ("холод по спине" hatasının yapısı): metinde 4 satırlık nakarat art arda iki kez; seste o noktada bir kez söyleniyor ve sıralı
eşleştirme onu İKİNCİ kopyaya bağlamış -> birinci kopya iki çapa arasındaki ~1,5 sn'ye sıkışıyor.

    python tests/test_lyricsfix.py
"""

import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import lyricsfix  # noqa: E402

failed = 0


def check(name, ok, detail=""):
    global failed
    print(f"[{'OK  ' if ok else 'FAIL'}] {name}{('  ' + str(detail)) if detail else ''}")
    if not ok:
        failed += 1


def load_app():
    spec = importlib.util.spec_from_file_location("app_lyricsfix_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


app = load_app()
LANG = "en"
verse = [f"verse line {i} alpha beta" for i in range(4)]
chorus = ["night is dark", "shadows dance around", "and this winter", "will be colder still"]
outro = ["final words here now"]
texts = verse + chorus + chorus + outro            # nakarat İKİ kez yazılı
line_tokens = [app._lyr_line_tokens(t, LANG) for t in texts]

# Otomatik kelimeler (sesten): dize 0-3 her biri ~4 sn; nakarat YALNIZ BİR KEZ (16-30 sn); son satır 60 sn'de.
auto = []
t = 0.0
for i in range(4):
    for w in verse[i].split():
        auto.append((app._lyr_norm_token(w), t, t + 0.6))
        t += 0.8
t = 16.2
for line in chorus:
    for w in line.split():
        auto.append((app._lyr_norm_token(w), t, t + 0.7))
        t += 0.9
for w in outro[0].split():
    auto.append((app._lyr_norm_token(w), 60.0 + len(auto) * 0.01, 60.6 + len(auto) * 0.01))

offsets = []
o = 0
for toks in line_tokens:
    offsets.append(o)
    o += len(toks)


def pairs_for(lines_to_auto):
    """{satır: otomatik başlangıç indeksi} -> belirteç eşleşmeleri."""
    pairs = {}
    for line, start in lines_to_auto.items():
        for pos in range(len(line_tokens[line])):
            pairs[offsets[line] + pos] = start + pos
    return pairs


verse_auto = {i: sum(len(verse[k].split()) for k in range(i)) for i in range(4)}
chorus_start = sum(len(v.split()) for v in verse)
chorus_auto = {}
cursor = chorus_start
for k, line in enumerate(chorus):
    chorus_auto[k] = cursor
    cursor += len(line.split())
outro_auto = cursor

# HATALI eşleşme (NW'nin verdiği): nakarat İKİNCİ kopyaya (satır 8-11) bağlı
bad = pairs_for({**verse_auto, **{8 + k: v for k, v in chorus_auto.items()}, 12: outro_auto})
duration = 70.0
plan_fn = lambda p: app._lyr_plan(line_tokens, p, auto, {}, LANG)

plan = plan_fn(bad)
check("hata yeniden üretildi: birinci kopya (4-7) serbest ve SIKIŞIK", [plan[i]["kind"] for i in range(4, 8)] == ["free"] * 4
      and lyricsfix.squeezed_lines(plan, duration) == 4, lyricsfix.squeezed_lines(plan, duration))

fixed, notes = lyricsfix.reassign_squeezed(line_tokens, bad, plan_fn, duration)
plan2 = plan_fn(fixed)
check("düzeltme: eşleşmeler birinci kopyaya taşındı (4-7 çapa)", [plan2[i]["kind"] for i in range(4, 8)] == ["anchor"] * 4)
check("ikinci kopya (8-11) serbest, geniş pencerede (sıkışma yok)", [plan2[i]["kind"] for i in range(8, 12)] == ["free"] * 4
      and lyricsfix.squeezed_lines(plan2, duration) == 0)
check("eşleşen belirteç sayısı değişmedi (yalnız yer değişti)", len(fixed) == len(bad))
check("not kaydı: hangi satırlar, öncesi/sonrası", notes and notes[0]["squeezed"] == [4, 8] and notes[0]["from"] == [8, 12]
      and notes[0]["squeezed_before"] == 4 and notes[0]["squeezed_after"] == 0, notes)
check("birinci kopya çapası nakaratın sesteki zamanında (16-30 sn)", 15.0 <= plan2[4]["start"] <= 17.0 and plan2[7]["end"] <= 31.0,
      (plan2[4]["start"], plan2[7]["end"]))

# Dokunulmaması gerekenler
good = pairs_for({**verse_auto, **{4 + k: v for k, v in chorus_auto.items()}, 12: outro_auto})
same, notes_good = lyricsfix.reassign_squeezed(line_tokens, good, plan_fn, duration)
check("zaten doğru eşleşmeye dokunmaz", same == good and notes_good == [])

texts_u = verse + chorus + ["different words entirely here", "nothing alike in this", "another unique line", "last unique one"] + outro
lt_u = [app._lyr_line_tokens(t, LANG) for t in texts_u]
off_u, o = [], 0
for toks in lt_u:
    off_u.append(o)
    o += len(toks)
pairs_u = {}
for line, start in {**verse_auto, **{8 + k: v for k, v in chorus_auto.items()}, 12: outro_auto}.items():
    for pos in range(min(len(lt_u[line]), 3)):
        pairs_u[off_u[line] + pos] = start + pos
res_u, notes_u = lyricsfix.reassign_squeezed(lt_u, pairs_u, lambda p: app._lyr_plan(lt_u, p, auto, {}, LANG), duration)
check("metni AYNI olmayan komşuya taşımaz (yalnız birebir tekrar)", res_u == pairs_u and notes_u == [])

check("app.py bağlantısı: yalnız çapalı yolda, plan öncesi, bilgiye yazılır",
      'reassign_squeezed(line_tokens, pairs, lambda p: _lyr_plan(line_tokens, p, auto, manual, language), duration)'
      in (ROOT / "backend" / "app.py").read_text(encoding="utf-8")
      and '"squeeze_fix": fixes,' in (ROOT / "backend" / "app.py").read_text(encoding="utf-8"))
check("lyrics imajına dosya eklenmiş", '.add_local_file(str(pathlib.Path(__file__).with_name("lyricsfix.py")), "/root/lyricsfix.py")'
      in (ROOT / "backend" / "app.py").read_text(encoding="utf-8"))

print(f"\n{'hepsi geçti' if not failed else str(failed) + ' test BAŞARISIZ'}")
sys.exit(1 if failed else 0)
