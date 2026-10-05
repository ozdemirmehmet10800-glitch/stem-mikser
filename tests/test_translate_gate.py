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
check("istem: ja'da hiragana okuma istenir, en'de istenmez", "hiragana" in system and "`rm`" not in system
      and "hiragana" not in app._tr_prompt("en", LINES, [0], False)[0])
check("istem: geri bildirim eklenir", "rejected: sayi" in app._tr_prompt("en", LINES, [0], False, "sayi")[1])
schema = app._tr_schema(3, True)
check("sema: minItems = maxItems = N, rd zorunlu, rm yok (sinirlar fugashi'den)", schema["minItems"] == 3 and schema["maxItems"] == 3
      and "rd" in schema["items"]["required"] and "rm" not in schema["items"]["properties"])
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
ja = app._tr_parse(json.dumps([{"i": 0, "tr": "A", "rd": "こんにちは"}, {"i": 1, "tr": "B", "rd": "今日"}, {"i": 2, "tr": "C"}]), LINES, [0, 1, 2], True)
check("parse: kanjili okuma atilir (satir kalir), kana okuma korunur", ja[0]["rd"] == "こんにちは" and "rd" not in ja[1] and "rd" not in ja[2])

# --- kana -> Hepburn (sozluksuz)
for kana, expected in [
    ("みんなが つまみやみずを", "Minnaga tsumamiyamizuo"), ("ちっちゃなころから", "Chitchanakorokara"),
    ("きっちり ぎゅうにゅう じょうだん", "Kitchiri gyuunyuu joudan"), ("かえない ぱろでぃー", "Kaenai parodii"),
    ("ライフ", "Raifu"), ("しんぶん は へ", "Shinbun wa e"), ("それもそっか", "Soremosokka"), ("ふぁいと", "Faito"),
    ("ABC あいう 123", "ABC aiu 123"), ("", None),
]:
    check(f"kana: {kana or '(bos)'} -> {expected}", app._tr_kana_romaji(kana) == expected, str(app._tr_kana_romaji(kana)))

# --- okunus: Gemini kanasi + fugashi sozcuk sinirlari (sahte jetonlarla; fugashi yerelde gerekmez)
def tok(reading, attach=False):
    return {"reading": reading, "attach": attach}


tokens = [tok("みんな"), tok("が"), tok("つまみ"), tok("や"), tok("みず"), tok("を"), tok("おにく")]
spaced, ratio = app._tr_space_kana("みんなが つまみやみずを おにく", tokens)
check("sinirlar fugashi'den: Gemini'nin birlesik kanasi sozcuklere bolunur", spaced == "みんな が つまみ や みず を おにく" and ratio > 0.99, spaced)
check("romaji: sozcuk bosluklu, parcacik wa/o", app._tr_reading_romaji("みんなが つまみやみずを おにく", tokens) == "Minna ga tsumami ya mizu o oniku")
t2 = [tok("わたし"), tok("は"), tok("いく"), tok("よ")]
check("tek basina は parcacigi wa", app._tr_reading_romaji("わたしはいくよ", t2) == "Watashi wa iku yo")
t3 = [tok("たべ"), tok("て", True), tok("いる", True), tok("よ")]
check("yapisanlar (て/いる) onceki sozcukle birlesik kalir", app._tr_reading_romaji("たべているよ", t3) == "Tabeteiru yo")
t4 = [tok("かえ"), tok("ない", True), tok("ぱろでぃー")]
check("Gemini katakana/uzatma: sozluk 'ぱろでぃー' ile hizalanir", app._tr_reading_romaji("かえない パロディー", t4) == "Kaenai parodii")
t5 = [tok("さげ"), tok("て", True), tok("わたし")]
out5 = app._tr_reading_romaji("さげて わたし", [tok("した"), tok("が"), tok("わたし")])
check("Gemini sozlukten farkli okursa (sagete vs shita) hizalama bozulmaz: harfler ayni, son sozcuk watashi",
      out5 is not None and out5.replace(" ", "").lower() == "sageteWatashi".lower() and out5.endswith("watashi"), str(out5))
check("Gemini okumasi sozlukle tutmuyorsa None (cutlet'e dusulur)", app._tr_reading_romaji("ぜんぜんちがうことば", tokens) is None)
check("jeton yoksa Gemini'nin kendi bosluklari", app._tr_reading_romaji("みんなが つまみ") == "Minnaga tsumami")
check("bos kana -> None", app._tr_reading_romaji("", tokens) is None)
check("Gemini'nin kendi bosluklari da korunur", "みんな が" in app._tr_space_kana("みんな が つまみ", [tok("みんなが")])[0])
check("katakana jeton okumasi hiraganaya cevrilir", app._tr_hira("ライフ") == "らいふ")


class FakeWord:
    def __init__(self, surface, kana, pos1, pos2=""):
        self.surface = surface
        self.feature = type("F", (), {"kana": kana, "pos1": pos1, "pos2": pos2})()


def fake_tagger(text):
    return [FakeWord("食べ", "タベ", "動詞", "一般"), FakeWord("て", "テ", "助詞", "接続助詞"), FakeWord("い", "イ", "動詞", "非自立可能"),
            FakeWord("ます", "マス", "助動詞"), FakeWord("が", "ガ", "助詞", "格助詞"), FakeWord("♪", "*", "補助記号")]


jt = app._tr_tokens(fake_tagger, "x")
check("fugashi jetonlari: okuma hiragana, て/い/ます ONCEKINE yapisir, が ayri, kanasiz jeton yuzeyi",
      [t["reading"] for t in jt] == ["たべ", "て", "い", "ます", "が", "♪"] and [t["attach"] for t in jt] == [False, True, True, True, False, False])
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
items = app._tr_apply({}, ["今日", "boom"], [{"i": 0, "tr": "Bugün", "rd": "きょう"}, {"i": 1, "tr": "Patlama", "rd": "ぼーむ"}], "ja", FakeKatsu())
check("ja: ro = cutlet(metin) yedek, rg = Gemini okumasi, rd saklanir", items[app._tr_hash("今日")] == {"tr": "Bugün", "rd": "きょう", "ro": "ro(今日)", "rg": "Kyou"})
check("ja: cutlet patlarsa ceviri kalir, ro yok, rg kanadan", items[app._tr_hash("boom")] == {"tr": "Patlama", "rd": "ぼーむ", "rg": "Boomu"})


class TaggerKatsu(FakeKatsu):
    tagger = staticmethod(lambda text: [FakeWord("きょう", "キョウ", "名詞")] if "今日" in text else [FakeWord("zzz", "ゼンゼン", "名詞")])


items = app._tr_apply({}, ["今日", "別"], [{"i": 0, "tr": "Bugün", "rd": "きょう"}, {"i": 1, "tr": "Ayrı", "rd": "ちがうことばです"}], "ja", TaggerKatsu())
check("ja: fugashi varsa sinirlar oradan; kanasi sozlukle tutmayan satirda rg YOK (cutlet'e duser)",
      items[app._tr_hash("今日")]["rg"] == "Kyou" and "rg" not in items[app._tr_hash("別")] and items[app._tr_hash("別")]["ro"] == "ro(別)")
v, _ = app._tr_lines_view(["今日", "別", "x"], {**items, app._tr_hash("x"): {"tr": "X"}})
check("gorunum: tek 'ro' alani: rg esas, rg yoksa cutlet, hicbiri yoksa ro yok; rd/rg sizmaz",
      v[0] == {"tr": "Bugün", "ro": "Kyou"} and v[1] == {"tr": "Ayrı", "ro": "ro(別)"} and v[2] == {"tr": "X"})


# --- Ingilizce okunus: Turkce harfli telaffuz (pr)
sys_en, user_en = app._tr_prompt("en", LINES, [1], True)
check("en istemi: pr kurali, tek kelime-tek kelime, ayni yazim kurali, sentetik ornek", "`pr`" in sys_en and "ONE pronunciation word per English word" in sys_en
      and "SAME way every time" in sys_en and app.TRANSLATE_PRON_EXAMPLE[0] in sys_en and '"pr"' in user_en and '"tr"' in user_en)
check("en istemi: ja'nin hiragana kurali YOK", "hiragana" not in sys_en and '"rd"' not in user_en)
sys_ro, user_ro = app._tr_prompt("en", LINES, [1, 2], True, "", True)
check("yalniz okunus istemi: ceviri istenmez", "Do NOT translate" in sys_ro and '"tr"' not in user_ro and '"pr"' in user_ro and "translator" not in sys_ro)
sch = app._tr_schema(2, True, "en")
check("en semasi: pr zorunlu, rd yok", "pr" in sch["items"]["required"] and "rd" not in sch["items"]["properties"] and "tr" in sch["items"]["required"])
sch = app._tr_schema(2, True, "en", True)
check("yalniz okunus semasi: tr yok, pr zorunlu", "tr" not in sch["items"]["properties"] and sch["items"]["required"] == ["i", "pr"])
en_ok = app._tr_parse(json.dumps([{"i": 0, "tr": "Merhaba", "pr": "Vi vır vokin"}]), ["We were walking"], [0], True, "en")
check("en parse: pr saklanir", en_ok == [{"i": 0, "tr": "Merhaba", "pr": "Vi vır vokin"}], str(en_ok))
en_bad = app._tr_parse(json.dumps([{"i": 0, "tr": "Merhaba", "pr": "x" * 200}]), ["We were walking"], [0], True, "en")
check("en parse: gecersiz (cok uzun) pr yalniz okunusu atar, ceviri kalir", en_bad == [{"i": 0, "tr": "Merhaba"}])
check("en parse: pr yoksa ceviri kalir", app._tr_parse(json.dumps([{"i": 0, "tr": "Merhaba"}]), ["We were walking"], [0], True, "en") == [{"i": 0, "tr": "Merhaba"}])
ro_ok = app._tr_parse(json.dumps([{"i": 1, "pr": "Vi vır"}]), LINES, [1], True, "en", True)
check("yalniz okunus parse: tr aranmaz", ro_ok == [{"i": 1, "pr": "Vi vır"}])
err = raises(lambda: app._tr_parse(json.dumps([{"i": 1}]), LINES, [1], True, "en", True), app.TranslateInvalid)
check("yalniz okunus parse: pr yoksa gecersiz (yeniden denenir)", isinstance(err, app.TranslateInvalid))

# --- yalniz Turk alfabesi
check("telaffuz temizligi: ê -> e, w -> v, x -> ks, rakam/noktalama atilir", app._tr_clean_pron("Forêvır, wan 2 ekxit!") == "Forevır van ekksit", app._tr_clean_pron("Forêvır, wan 2 ekxit!"))
check("telaffuz temizligi: Turk harfleri aynen", app._tr_clean_pron("Nevır kerd vat şey çok ğü") == "Nevır kerd vat şey çok ğü")
check("telaffuz temizligi: ê -> e", app._tr_clean_pron("Forêvır") == "Forevır")
check("telaffuz temizligi: w/x/q", app._tr_clean_pron("wan ex qu") == "van eks ku")
check("telaffuz temizligi: kesme/tire korunur, bosluk toplanir", app._tr_clean_pron("dont   it's  a-b") == "dont it's a-b")
check("telaffuz temizligi: buyuk harf korunur", app._tr_clean_pron("Wan Êt") == "Van Et")
cleaned = app._tr_parse(json.dumps([{"i": 0, "tr": "x", "pr": "Forêvır wan"}]), ["Forever one"], [0], True, "en")
check("en parse: pr Turk alfabesine indirgenir", cleaned[0]["pr"] == "Forevır van", str(cleaned))
sys_en2 = app._tr_prompt("en", LINES, [0], True)[0]
check("en istemi: yalniz Turk alfabesi kurali", "ONLY letters of the Turkish alphabet" in sys_en2 and "no w, x, q" in sys_en2)

# --- eksik okunus
src = ["We were walking down", "We were walking down", "Home again", "No pron yet"]
its = {app._tr_hash(src[0]): {"tr": "A", "pr": "Vi vır"}, app._tr_hash(src[2]): {"tr": "B"}, app._tr_hash(src[3]): {"tr": "C"}}
check("eksik okunus: ceviri var pr yok, ilk gecis, tekrar bedava", app._tr_missing_reading(src, its) == [2, 3])
check("eksik okunus: cevirisi olmayan satir sayilmaz", app._tr_missing_reading(["x"], {}) == [] and app._tr_missing_reading(["x"], {app._tr_hash("x"): {"tr": ""}}) == [])

# --- tutarlilik: ayni kelime hep ayni yazim
lines_c = ["We were walking down", "Walking down the road", "We walking down"]
items_c = {
    app._tr_hash(lines_c[0]): {"tr": "a", "pr": "Vi vır vokin dawn"},
    app._tr_hash(lines_c[1]): {"tr": "b", "pr": "Vokin davn dı rod"},
    app._tr_hash(lines_c[2]): {"tr": "c", "pr": "Vi vokin dawn"},
}
fixed = app._tr_unify_pron(lines_c, items_c)
check("tutarlilik: 'walking' ve 'down' hep ayni (en sik yazim), satir basi buyuk harf korunur",
      items_c[app._tr_hash(lines_c[1])]["pr"] == "Vokin dawn dı rod" and items_c[app._tr_hash(lines_c[0])]["pr"] == "Vi vır vokin dawn"
      and items_c[app._tr_hash(lines_c[2])]["pr"] == "Vi vokin dawn" and fixed == 1, str(items_c))
tie = {app._tr_hash("go go"): {"tr": "x", "pr": "Go gou"}}
check("tutarlilik: esitlikte ilk gorulen kalir", app._tr_unify_pron(["go go"], tie) in (0, 1) and tie[app._tr_hash("go go")]["pr"].split()[0] == "Go")
off = {app._tr_hash("one two three"): {"tr": "x", "pr": "van tu"}}
check("tutarlilik: kelime sayisi tutmayan satira DOKUNMAZ", app._tr_unify_pron(["one two three"], off) == 0 and off[app._tr_hash("one two three")]["pr"] == "van tu")
punct = {app._tr_hash("Hey, you"): {"tr": "x", "pr": "Hey, yu"}}
check("tutarlilik: noktalama telaffuzdan ayiklanir", app._tr_unify_pron(["Hey, you"], punct) == 0 and punct[app._tr_hash("Hey, you")]["pr"] == "Hey yu")
items_old = {app._tr_hash("Run away"): {"tr": "k", "pr": "Ran evey"}}
items_old = app._tr_apply(items_old, ["Run away", "Run again"], [{"i": 1, "tr": "T", "pr": "Rin egen"}], "en")
check("yeni satir ESKI satirlarin yazimina uyar (Run -> Ran)", items_old[app._tr_hash("Run again")]["pr"] == "Ran egen", str(items_old))

# --- apply (en) ve yalniz okunus birlestirme
en_items = app._tr_apply({}, ["Hello world", "Hello world", "Bye"], [{"i": 0, "tr": "Selam dünya", "pr": "Helo vörld"}, {"i": 2, "tr": "Hoşça kal"}], "en")
check("en isleme: pr saklanir, olmayan satir pr'siz", en_items[app._tr_hash("hello world")] == {"tr": "Selam dünya", "pr": "Helo vörld"} and en_items[app._tr_hash("bye")] == {"tr": "Hoşça kal"})
merged = app._tr_apply(dict(en_items), ["Hello world", "Hello world", "Bye"], [{"i": 2, "pr": "Bay"}], "en")
check("yalniz okunus: ceviri AYNEN kalir, pr eklenir", merged[app._tr_hash("bye")] == {"tr": "Hoşça kal", "pr": "Bay"} and merged[app._tr_hash("hello world")]["tr"] == "Selam dünya")
orphan = app._tr_apply({}, ["Solo"], [{"i": 0, "pr": "Solo"}], "en")
check("yalniz okunus: cevirisi olmayan satir olusturulmaz", orphan == {})
view_en, miss_en = app._tr_lines_view(["Hello world", "Bye"], merged)
check("gorunum: en telaffuzu 'ro' olarak gelir", view_en[0] == {"tr": "Selam dünya", "ro": "Helo vörld"} and view_en[1] == {"tr": "Hoşça kal", "ro": "Bay"})
view_ja, _ = app._tr_lines_view(["x"], {app._tr_hash("x"): {"tr": "T", "ro": "cut", "rg": "gem", "pr": "yok"}})
check("gorunum: ja'da rg > ro > pr onceligi", view_ja[0]["ro"] == "gem")

# --- akis: yalniz okunus
def run_reading(responses):
    seen = []

    def fake_call(system, user, schema):
        seen.append((system, user))
        return responses.pop(0)

    try:
        return app._tr_run("en", LINES, [1, 2], True, fake_call, True), seen, None
    except app.TranslateError as error:
        return None, seen, error


out, seen, err = run_reading([json.dumps([{"i": 1, "pr": "A"}, {"i": 2, "pr": "B"}])])
check("akis (yalniz okunus): tek istek, ciktida tr yok", err is None and out == [{"i": 1, "pr": "A"}, {"i": 2, "pr": "B"}] and len(seen) == 1 and "Do NOT translate" in seen[0][0])
out, seen, err = run_reading([json.dumps([{"i": 1, "pr": "A"}]), json.dumps([{"i": 1, "pr": "A"}, {"i": 2, "pr": "B"}])])
check("akis (yalniz okunus): eksik oge -> geri bildirimle yeniden", err is None and len(seen) == 2 and "rejected" in seen[1][1])

# --- durum
now = __import__("time").time()
check("calisiyor: taze evet, bayat hayir", app._tr_is_running({"translation": {"state": "running", "started": now}})
      and not app._tr_is_running({"translation": {"state": "running", "started": now - 1000}})
      and not app._tr_is_running({"translation": {"state": "done"}}) and not app._tr_is_running({}))
check("silme engeli: ceviri surerken", "ceviri" in (app._delete_block_reason({"state": "done", "translation": {"state": "running", "started": now}}) or "").lower())

print(f"\n{len(PASSED)} gecti, {len(FAILED)} basarisiz")
raise SystemExit(1 if FAILED else 0)
