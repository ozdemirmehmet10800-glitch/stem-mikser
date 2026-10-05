"""Soz cevirisi (Asama 14): istem, dogrulama, eslestirme, yeniden deneme, model gecisi, parcalama.

Yerel test, Modal/ağ YOK: Gemini sahte HTTP ile taklit edilir. SENTETIK satirlar (gercek soz yok).
Gercek cikti kalitesi canlida: tests/translate_live.py
Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_translate_gate.py
"""

import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_translate_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


app = load_app()
LINES = [f"Sentetik satir {i}" for i in range(8)]


def good(indices, rd=False):
    return json.dumps([{"i": i, "tr": f"Çeviri {i}", **({"rd": "せんてい"} if rd else {})} for i in indices])


def gemini_body(text, reason="STOP"):
    return json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": reason}]}).encode()


def raises(fn, kind):
    try:
        fn()
    except kind as error:
        return error
    except Exception as error:   # beklenmeyen tur
        return None if False else type(error)
    return None


# --- hash ve eksik satirlar
check("hash: buyuk/kucuk harf ve bosluk onemsiz", app._tr_hash("  Hello   World ") == app._tr_hash("hello world"))
check("hash: farkli metin farkli hash", app._tr_hash("a") != app._tr_hash("b"))
lines = ["a", "b", "a", "c"]
check("eksik: tekrar eden satir TEK kez (ilk dizin)", app._tr_missing(lines, {}) == [0, 1, 3])
items = {app._tr_hash("a"): {"tr": "A"}}
check("eksik: cevirisi olan atlanir", app._tr_missing(lines, items) == [1, 3])
check("eksik: bos tr eksik sayilir", app._tr_missing(["a"], {app._tr_hash("a"): {"tr": ""}}) == [0])
view, missing = app._tr_lines_view(lines, {**items, app._tr_hash("b"): {"tr": "B", "ro": "bi"}})
check("gorunum: satirlara hizali, tekrar ayni ceviri, eksik None", [v and v["tr"] for v in view] == ["A", "B", "A", None] and missing == 1
      and view[1]["ro"] == "bi")
reordered, miss2 = app._tr_lines_view(["c", "b", "a"], {**items, app._tr_hash("b"): {"tr": "B"}})
check("sozler yeniden siralanir/zaman degisir: ceviri korunur, yeni metin eksik", [v and v["tr"] for v in reordered] == [None, "B", "A"] and miss2 == 1)

# --- istem ve sema
system, user = app._tr_prompt("ja", LINES, [2, 5], True)
check("istem: tum sarki numarali baglam", all(f"{i}: {t}" in user for i, t in enumerate(LINES)))
check("istem: yalniz istenen dizinler ve sayi", "exactly 2 objects" in user and "2, 5" in user)
check("istem: ja'da hiragana okuma ve romaji istenir, en'de istenmez", "hiragana" in system and "`rm`" in system
      and "hiragana" not in app._tr_prompt("en", LINES, [0], False)[0])
check("istem: geri bildirim eklenir", "rejected: sayi" in app._tr_prompt("en", LINES, [0], False, "sayi")[1])
schema = app._tr_schema(3, True)
check("sema: minItems = maxItems = N, rd ve rm zorunlu", schema["minItems"] == 3 and schema["maxItems"] == 3
      and "rd" in schema["items"]["required"] and "rm" in schema["items"]["required"])
check("sema: okunussuz rd yok", "rd" not in app._tr_schema(3, False)["items"]["properties"])

# --- dogrulama
parsed = app._tr_parse(good([1, 3]), LINES, [1, 3], False)
check("parse: dogru cikti", [p["tr"] for p in parsed] == ["Çeviri 1", "Çeviri 3"])
check("parse: sarmalayici nesne kabul", len(app._tr_parse(json.dumps({"translations": json.loads(good([1]))}), LINES, [1], False)) == 1)
for name, text, indices in [
    ("JSON degil", "merhaba", [1]),
    ("eksik oge", good([1]), [1, 2]),
    ("fazla oge", good([1, 2]), [1]),
    ("sira bozuk", good([2, 1]), [1, 2]),
    ("bos tr", json.dumps([{"i": 1, "tr": "  "}]), [1]),
    ("tr yok", json.dumps([{"i": 1}]), [1]),
    ("numarali", json.dumps([{"i": 1, "tr": "1. Çeviri"}]), [1]),
    ("cok uzun", json.dumps([{"i": 1, "tr": "x" * 500}]), [1]),
]:
    err = raises(lambda t=text, ix=indices: app._tr_parse(t, LINES, ix, False), app.TranslateInvalid)
    check(f"parse reddeder: {name}", isinstance(err, app.TranslateInvalid), repr(err))
check("parse: kaynak numarayla basliyorsa numara serbest", len(app._tr_parse(json.dumps([{"i": 0, "tr": "1. Cadde"}]), ["1. Street"], [0], False)) == 1)
ja = app._tr_parse(json.dumps([{"i": 0, "tr": "A", "rd": "こんにちは", "rm": "konnichi wa"}, {"i": 1, "tr": "B", "rd": "今日"}, {"i": 2, "tr": "C"}]), LINES, [0, 1, 2], True)
check("parse: kanjili okuma atilir (satir kalir), kana okuma ve rm korunur", ja[0]["rd"] == "こんにちは" and ja[0]["rm"] == "konnichi wa"
      and "rd" not in ja[1] and "rd" not in ja[2])

# --- kana -> Hepburn (sozluksuz)
for kana, expected in [
    ("みんなが つまみやみずを", "Minnaga tsumamiyamizuo"), ("ちっちゃなころから", "Chitchanakorokara"),
    ("きっちり ぎゅうにゅう じょうだん", "Kitchiri gyuunyuu joudan"), ("かえない ぱろでぃー", "Kaenai parodii"),
    ("ライフ", "Raifu"), ("しんぶん は へ", "Shinbun wa e"), ("それもそっか", "Soremosokka"), ("ふぁいと", "Faito"),
    ("ABC あいう 123", "ABC aiu 123"), ("", None),
]:
    check(f"kana: {kana or '(bos)'} -> {expected}", app._tr_kana_romaji(kana) == expected, str(app._tr_kana_romaji(kana)))
check("okunus: rm kanayla ortusuyorsa (kelime boslukli) kullanilir", app._tr_reading_romaji("みんなが つまみやみずを", "minna ga tsumami ya mizu o") == "Minna ga tsumami ya mizu o")
check("okunus: rm uyusmuyorsa kana Hepburn'u", app._tr_reading_romaji("みんなが つまみやみずを", "baska seyler") == "Minnaga tsumamiyamizuo")
check("okunus: rm yoksa kana Hepburn'u", app._tr_reading_romaji("ライフ", None) == "Raifu")

# --- Gemini cevabi
check("gemini metni: normal", app._tr_gemini_text(gemini_body("[]")) == "[]")
check("gemini metni: dusunce parcasi atlanir", app._tr_gemini_text(json.dumps({"candidates": [{"content": {"parts": [
    {"text": "dusunuyor", "thought": True}, {"text": "[1]"}]}, "finishReason": "STOP"}]}).encode()) == "[1]")
check("gemini: blockReason -> reddetti", isinstance(raises(lambda: app._tr_gemini_text(json.dumps({"promptFeedback": {"blockReason": "SAFETY"}}).encode()), app.TranslateRefused), app.TranslateRefused))
check("gemini: RECITATION ve bos -> reddetti", isinstance(raises(lambda: app._tr_gemini_text(gemini_body("", "RECITATION")), app.TranslateRefused), app.TranslateRefused))
check("gemini: MAX_TOKENS -> gecersiz (parcalara duser)", isinstance(raises(lambda: app._tr_gemini_text(gemini_body("[", "MAX_TOKENS")), app.TranslateInvalid), app.TranslateInvalid))


# --- HTTP: yeniden deneme ve model gecisi
class FakeHttp:
    def __init__(self, script):
        self.script = list(script)       # [(model alt dizgisi, durum)] siradaki cevaplar
        self.calls = []

    def __call__(self, url, headers, body, timeout=0):
        model = url.split("/models/")[1].split(":")[0]
        self.calls.append((model, headers))
        status = self.script.pop(0) if self.script else 200
        return status, (gemini_body("OK") if status == 200 else b'{"error":{"message":"x"}}')


def call(script, models=("big", "lite")):
    http, waits, used = FakeHttp(script), [], []
    try:
        text = app._tr_call("KEY", list(models), "s", "u", {}, http=http, sleep=waits.append, used=used)
        return text, http, waits, used, None
    except app.TranslateError as error:
        return None, http, waits, used, error


text, http, waits, used, err = call([200])
check("istek: basarili, anahtar BASLIKTA (URL'de degil)", text == "OK" and http.calls[0][1]["x-goog-api-key"] == "KEY" and "KEY" not in str(http.calls[0][0]))
text, http, waits, used, err = call([429, 200])
check("429: kisa bekle, ayni modelde yeniden", text == "OK" and waits == [3.0] and [c[0] for c in http.calls] == ["big", "big"] and used == ["big"])
text, http, waits, used, err = call([503, 503, 200])
check("503 iki kez: iki bekleme, ucuncu denemede ayni model", waits == [3.0, 8.0] and [c[0] for c in http.calls] == ["big"] * 3 and used == ["big"])
text, http, waits, used, err = call([503, 503, 503, 200])
check("ana model 3 kez basarisiz -> hafif modele gecer", text == "OK" and used == ["lite"] and [c[0] for c in http.calls] == ["big", "big", "big", "lite"])
text, http, waits, used, err = call([429, 503, 500] + [503, 429, 0])
check("ikisi de basarisiz -> TranslateBusy ve net mesaj", isinstance(err, app.TranslateBusy) and err.message == "Çeviri servisi şu an meşgul, biraz sonra tekrar dene.")
text, http, waits, used, err = call([404, 200])
check("404 (model yok): beklemeden sonraki modele", text == "OK" and used == ["lite"] and waits == [])
text, http, waits, used, err = call([0, 200])
check("ag hatasi (0) de yeniden denenir", text == "OK" and waits == [3.0])
text, http, waits, used, err = call([403])
check("403: anahtar hatasi, yeniden denemez", isinstance(err, app.TranslateAuth) and waits == [] and len(http.calls) == 1)
text, http, waits, used, err = call([400])
check("400 (anahtar disi): gecersiz istek", isinstance(err, app.TranslateInvalid) and len(http.calls) == 1)
check("tek model verilirse yedek yok", app._tr_models() == [app.TRANSLATE_DEFAULT_MODEL, app.TRANSLATE_DEFAULT_FALLBACK])


# --- cevirme akisi: yeniden deneme ve parcalama
def run(responses, indices=None, lang="en"):
    seen = []

    def fake_call(system, user, schema):
        seen.append(user)
        value = responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value(user) if callable(value) else value

    idx = list(range(len(LINES))) if indices is None else indices
    try:
        return app._tr_run(lang, LINES, idx, lang == "ja", fake_call), seen, None
    except app.TranslateError as error:
        return None, seen, error


out, seen, err = run([good(range(8))])
check("akis: tek istekte tamam", err is None and len(out) == 8 and len(seen) == 1)
out, seen, err = run([good(range(7)), good(range(8))])
check("akis: eksik satir -> geri bildirimle yeniden dener", err is None and len(seen) == 2 and "rejected" in seen[1] and "8 oge" in seen[1] or "beklendi" in seen[1])
long_lines = [f"Sentetik satir {i}" for i in range(45)]
LINES_BACKUP = LINES


def run_long(responses):
    seen = []

    def fake_call(system, user, schema):
        seen.append(user)
        value = responses.pop(0)
        return value(user) if callable(value) else value

    try:
        return app._tr_run("en", long_lines, list(range(45)), False, fake_call), seen, None
    except app.TranslateError as error:
        return None, seen, error


def echo(user):
    # istenen satir numaralarini cevaba cevir
    wanted = user.split("in this order: ")[1].split(".\n")[0]
    return json.dumps([{"i": int(n), "tr": f"Çeviri {n}"} for n in wanted.split(", ")])


bad = "[]"
out, seen, err = run_long([bad, bad, bad, echo, echo, echo])
check("akis: 3 gecersiz tam deneme sonra 20'serlik parcalar (20+20+5)", err is None and len(out) == 45 and len(seen) == 6
      and [int(s.split("exactly ")[1].split(" ")[0]) for s in seen[3:]] == [20, 20, 5])
check("akis: parcalarda da tum sarki baglam", all("44: Sentetik satir 44" in s for s in seen))
check("akis: sonuc sirali ve eksiksiz", [o["i"] for o in out] == list(range(45)))
out, seen, err = run_long([bad] * 3 + [bad] * 3)
check("akis: parca da olmazsa net hata (satir sayisi)", isinstance(err, app.TranslateInvalid) and "satır sayısını" in err.message)
out, seen, err = run([good(range(3))] * 3, indices=[0, 1, 2, 3])
check("akis: kisa liste (<=20) parcalama yok, 3 denemeden sonra hata", isinstance(err, app.TranslateInvalid) and len(seen) == 3)
out, seen, err = run([app.TranslateBusy(app.TRANSLATE_BUSY_MESSAGE)])
check("akis: Busy aynen yukari", isinstance(err, app.TranslateBusy))
out, seen, err = run([app.TranslateRefused("x")])
check("akis: Refused aynen yukari", isinstance(err, app.TranslateRefused))

# --- sonuclari isleme ve okunus
class FakeKatsu:
    def romaji(self, text):
        if "boom" in text:
            raise RuntimeError("x")
        return f"ro({text})"


items = app._tr_apply({}, ["Hello", "Hello", "World"], [{"i": 0, "tr": "Merhaba"}, {"i": 2, "tr": "Dünya"}], "en")
check("isleme: hash'e yazilir, en'de okunus yok", items[app._tr_hash("hello")] == {"tr": "Merhaba"} and len(items) == 2)
items = app._tr_apply({}, ["今日", "boom"], [{"i": 0, "tr": "Bugün", "rd": "きょう", "rm": "kyou"}, {"i": 1, "tr": "Patlama", "rd": "ぼーむ"}], "ja", FakeKatsu())
check("ja: ro = cutlet(metin), rg = Gemini okumasi (rm dogrulanmis), rd saklanir", items[app._tr_hash("今日")] == {"tr": "Bugün", "rd": "きょう", "ro": "ro(今日)", "rg": "Kyou"})
check("ja: cutlet patlarsa ceviri kalir, ro yok, rg kanadan", items[app._tr_hash("boom")] == {"tr": "Patlama", "rd": "ぼーむ", "rg": "Boomu"})

# --- durum
now = __import__("time").time()
check("calisiyor: taze evet, bayat hayir", app._tr_is_running({"translation": {"state": "running", "started": now}})
      and not app._tr_is_running({"translation": {"state": "running", "started": now - 1000}})
      and not app._tr_is_running({"translation": {"state": "done"}}) and not app._tr_is_running({}))
check("silme engeli: ceviri surerken", "ceviri" in (app._delete_block_reason({"state": "done", "translation": {"state": "running", "started": now}}) or "").lower())

print(f"\n{len(PASSED)} gecti, {len(FAILED)} basarisiz")
raise SystemExit(1 if FAILED else 0)
