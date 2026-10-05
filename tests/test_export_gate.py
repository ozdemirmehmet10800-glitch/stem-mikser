"""Miks disa aktarma (Asama 12): dogrulama, hash, dosya adi, ffmpeg komutu, temizlik.

Yerel test, Modal/ffmpeg YOK. Gercek ses ve ffmpeg olcumleri canlida:
    modal run backend/app.py::export_validate
Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_export_gate.py
"""

import importlib.util
import os
import pathlib
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_export_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STATUS = {
    "id": "a" * 64, "title": "Test Sarkisi", "state": "done", "duration": 120.0,
    "stems": ["drums", "bass", "other", "vocals", "guitar", "piano"],
    "stems_version": 7,
    "sub": {"state": "done", "version": 11, "reliability": "ok"},
    "sub_drums": {"state": "unreliable"},
}


def body(**over):
    base = {"format": "m4a", "gains": {"drums": 1, "bass": 1, "other": 1, "backing": 1}}
    base.update(over)
    return base


def main():
    app = load_app()
    chk = lambda payload, status=STATUS: app._export_check(payload, status)

    # --- gecerli istek ve normalize
    spec, problem = chk(body(master=1.2, rate=0.8, semitones=2, label="  Karaoke   (arka vokal kalsin) ",
                             region={"a": 10, "b": 20.5}))
    check("gecerli istek kabul", problem is None and spec is not None, str(problem))
    check("kanallar sirali ve yuvarlanmis", list(spec["gains"]) == ["backing", "bass", "drums", "other"])
    check("etiket bosluklari sadelesir", spec["label"] == "Karaoke (arka vokal kalsin)")
    check("bolge/hiz/ton/ana ses normalize", spec["region"] == {"a": 10.0, "b": 20.5} and spec["rate"] == 0.8
          and spec["semitones"] == 2 and spec["master"] == 1.2)
    check("kaynak surumleri spec'te (bayat onbellek olmasin)",
          spec["stems_version"] == 7 and spec["sub_versions"]["sub"] == 11)
    spec0, _ = chk(body())
    check("varsayilanlar: m4a, ana ses 1, hiz 1, ton 0, bolge yok",
          spec0["format"] == "m4a" and spec0["master"] == 1.0 and spec0["rate"] == 1.0
          and spec0["semitones"] == 0 and spec0["region"] is None and spec0["label"] == "")
    zero, _ = chk(body(gains={"drums": 1, "bass": 0, "vocals": 0.0}))
    check("sifir kazancli kanallar atilir", list(zero["gains"]) == ["drums"])

    # --- reddedilenler
    bad = {
        "govde nesne degil": [1, 2],
        "gecersiz format (mp3)": body(format="mp3"),
        "flac yok": body(format="flac"),
        "gains yok": {"format": "m4a"},
        "gains bos": body(gains={}),
        "gains liste": body(gains=[1]),
        "bilinmeyen kanal": body(gains={"yok": 1}),
        "yol gecisi adi": body(gains={"../x": 1}),
        "alt parca ama grup done degil (kick)": body(gains={"kick": 1}),
        "kazanc > 2": body(gains={"drums": 2.5}),
        "kazanc negatif": body(gains={"drums": -0.1}),
        "kazanc metin": body(gains={"drums": "1"}),
        "kazanc bool": body(gains={"drums": True}),
        "kazanc NaN": body(gains={"drums": float("nan")}),
        "kazanc sonsuz": body(gains={"drums": float("inf")}),
        "hicbir kanal duyulmuyor": body(gains={"drums": 0, "bass": 0}),
        "ana kanal + alt parcasi birlikte": body(gains={"vocals": 1, "backing": 1}),
        "ana ses > 1.5": body(master=1.6),
        "ana ses 0": body(master=0),
        "hiz < 0.5": body(rate=0.4),
        "hiz > 1.5": body(rate=1.6),
        "hiz metin": body(rate="0.8"),
        "ton > 6": body(semitones=7),
        "ton < -6": body(semitones=-7),
        "ton kesirli": body(semitones=1.5),
        "bolge nesne degil": body(region=[1, 2]),
        "bolge b < a": body(region={"a": 20, "b": 10}),
        "bolge cok kisa": body(region={"a": 10, "b": 10.05}),
        "bolge sarki disinda (a)": body(region={"a": 130, "b": 140}),
        "bolge eksik alan": body(region={"a": 1}),
        "etiket metin degil": body(label=5),
    }
    for name, payload in bad.items():
        _, problem = chk(payload)
        check(f"reddedilir: {name}", problem is not None, str(problem))
    spec, problem = chk(body(region={"a": 100, "b": 120.03}))
    check("bolge sonu sarki suresine kirpilir", problem is None and spec["region"]["b"] == 120.0, str(problem))
    spec, _ = chk(body(label="x" * 500))
    check("etiket 60 karakterle sinirli", len(spec["label"]) == app.EXPORT_LABEL_MAX)
    spec, _ = chk(body(label="a\x00b\nc"))
    check("etiketteki denetim karakterleri bosluga", spec["label"] == "a b c", repr(spec["label"]))

    # alt parca kurallari
    ok, problem = chk(body(gains={"lead": 1, "backing": 0.5, "drums": 1}))
    check("alt parcalar done grupta kabul (ana kanal yok)", problem is None and "lead" in ok["gains"])
    _, problem = chk(body(gains={"drums": 1, "kick": 1}), dict(STATUS, sub_drums={"state": "done", "version": 3}))
    check("davul + kick birlikte reddedilir", problem is not None)
    ok, problem = chk(body(gains={"kick": 1, "snare": 1, "vocals": 1}), dict(STATUS, sub_drums={"state": "done", "version": 3}))
    check("davul alt parcalari + vokal ana kanal kabul", problem is None)

    # --- hash
    a, _ = chk(body())
    b, _ = chk(body(gains={"backing": 1, "other": 1, "bass": 1, "drums": 1}))
    check("hash: kanal sirasi onemsiz", app._export_hash(a) == app._export_hash(b))
    check("hash: 32 hex", len(app._export_hash(a)) == 32 and app.EXPORT_HASH_RE.match(app._export_hash(a)))
    variants = [body(master=0.9), body(rate=0.9), body(semitones=1), body(format="wav"), body(label="x"),
                body(region={"a": 1, "b": 5}), body(gains={"drums": 0.9, "bass": 1, "other": 1, "backing": 1})]
    hashes = {app._export_hash(chk(v)[0]) for v in variants} | {app._export_hash(a)}
    check("hash: her ayar farkli hash", len(hashes) == len(variants) + 1)
    c, _ = chk(body(), dict(STATUS, stems_version=8))
    d, _ = chk(body(), dict(STATUS, sub={"state": "done", "version": 12}))
    check("hash: kaynak surumu degisince degisir", app._export_hash(c) != app._export_hash(a)
          and app._export_hash(d) != app._export_hash(a))

    # --- dosya adi
    name = app._export_filename("Zeus Kabadayı & Rota - Çok Mutlu Bir Şarkı",
                                chk(body(label="Karaoke (arka vokal kalsın)"))[0])
    check("dosya adi: sarki - etiket.m4a", name == "Zeus Kabadayı & Rota - Çok Mutlu Bir Şarkı - Karaoke (arka vokal kalsın).m4a", name)
    check("dosya adi: etiket yoksa 'Miks'", app._export_filename("S", chk(body())[0]) == "S - Miks.m4a")
    full = chk(body(label="Miks", rate=0.8, semitones=2, region={"a": 80, "b": 105}, format="wav"))[0]
    check("dosya adi: hiz, ton ve dongu eklenir",
          app._export_filename("S", full) == "S - Miks - 0.8x - +2 - döngü 1m20-1m45.wav",
          app._export_filename("S", full))
    check("dosya adi: negatif ton", "-3" in app._export_filename("S", chk(body(semitones=-3))[0]))
    bad_name = app._export_filename('A<B>:"C"/D|E?F*', chk(body(label='x/y:z'))[0])
    check("dosya adi: yasak karakterler temizlenir",
          not any(ch in bad_name.rsplit(".", 1)[0] for ch in '<>:"/|?*\\'), bad_name)
    check("dosya adi: cok uzun baslik sinirlanir", len(app._export_filename("a" * 400, chk(body(label="b" * 60))[0])) <= 200)
    check("dosya adi: bos baslik yedek", app._export_filename("", chk(body())[0]).startswith("sarki - "))

    # --- ffmpeg komutu
    paths = {n: f"/w/{n}.flac" for n in ("backing", "bass", "drums", "other")}
    cmd = app._export_command(chk(body(master=1.25))[0], paths, "/w/out.m4a", "Baslik")
    graph = cmd[cmd.index("-filter_complex") + 1]
    check("komut: girdiler sirali (-i x4)", cmd.count("-i") == 4 and cmd[cmd.index("-i") + 1].endswith("backing.flac"))
    check("komut: dosya basina volume", graph.count("volume=1.0000[") == 4, graph)
    check("komut: amix normalize=0 inputs=4", "amix=inputs=4:normalize=0" in graph)
    check("komut: ana ses", "volume=1.2500," in graph)
    check("komut: esnetici yok (hiz/ton orijinal)", "rubberband" not in graph and "atrim=start=" not in graph)
    check("komut: limiter m4a -1 dBFS + gecikme telafisi",
          "alimiter=limit=0.8913" in graph and f"atrim=start_sample={app.EXPORT_LIMITER_DELAY_SAMPLES}" in graph
          and graph.index("alimiter") < graph.index("atrim=start_sample"), graph)
    check("komut: gecikme telafisi 219 ornek", app.EXPORT_LIMITER_DELAY_SAMPLES == 219)
    check("komut: m4a kodek", "aac" in cmd and "256k" in cmd and "+faststart" in cmd and cmd[-1] == "/w/out.m4a")
    check("komut: etiketler (title/album/comment)", "title=Baslik" in cmd and "album=Stem Mikser" in cmd
          and any(x.startswith("comment=") for x in cmd))
    check("komut: kaynak metadata atilir", "-map_metadata" in cmd and cmd[cmd.index("-map_metadata") + 1] == "-1")

    one = app._export_command(chk(body(gains={"drums": 0.5}))[0], {"drums": "/w/d.flac"}, "/w/o.m4a")
    check("komut: tek kanal amix yerine anull", "anull[mix]" in one[one.index("-filter_complex") + 1]
          and "amix" not in one[one.index("-filter_complex") + 1])

    full_spec = chk(body(rate=0.8, semitones=3, region={"a": 10.5, "b": 20.25}, format="wav"))[0]
    wav = app._export_command(full_spec, paths, "/w/out.wav")
    g = wav[wav.index("-filter_complex") + 1]
    check("komut: A-B kirpma ESNETMEDEN once", g.index("atrim=start=10.500:end=20.250") < g.index("rubberband"), g)
    check("komut: A-B uclarinda 15 ms fade", "afade=t=in:d=0.015" in g and "afade=t=out:st=9.735:d=0.015" in g, g)
    check("komut: rubberband hiz/ton/smooth/together", "rubberband=tempo=0.8000:pitch=1.189207" in g
          and "transients=smooth" in g and "channels=together" in g and "pitchq=quality" in g, g)
    check("komut: ton varken vokal tinisi korunur (formant)", "formant=preserved" in g)
    only_tempo = app._export_command(chk(body(rate=1.25))[0], paths, "/w/o.m4a")
    check("komut: yalniz hizda formant yok, pitch=1", "formant" not in only_tempo[only_tempo.index("-filter_complex") + 1]
          and "pitch=1.000000" in only_tempo[only_tempo.index("-filter_complex") + 1])
    check("komut: wav 16-bit pcm + dither + limiter -0.1",
          "pcm_s16le" in wav and "dither_method=triangular" in g and "alimiter=limit=0.9886" in g)
    check("komut: sinirlayici hiz/ton'dan SONRA", g.index("rubberband") < g.index("alimiter"))
    check("komut: ses ornekleme 44100", wav[wav.index("-ar") + 1] == "44100")

    # --- plak gibi (vinyl): rubberband yok, asetrate+aresample
    vspec, vproblem = chk(body(rate=0.85, vinyl=True, region={"a": 10, "b": 20}, format="wav"))
    check("vinyl: kabul, spec'te vinyl", vproblem is None and vspec["vinyl"] is True and vspec["rate"] == 0.85 and vspec["semitones"] == 0, str(vproblem))
    vcmd = app._export_command(vspec, paths, "/w/out.wav")
    vg = vcmd[vcmd.index("-filter_complex") + 1]
    check("vinyl komutu: rubberband YOK, asetrate = 44100 x oran + aresample", "rubberband" not in vg and "asetrate=37485.0000,aresample=44100" in vg, vg)
    check("vinyl komutu: bolge kirpma asetrate'ten ONCE, limiter SONRA", vg.index("atrim=start=10.000") < vg.index("asetrate") < vg.index("alimiter"), vg)
    check("vinyl: ton ayri verilirse 400", chk(body(rate=0.85, vinyl=True, semitones=2))[1] is not None)
    check("vinyl: bool degilse 400", chk(body(rate=0.85, vinyl="evet"))[1] is not None)
    plain = chk(body(rate=0.85))[0]
    check("vinyl kapaliyken anahtar YOK (eski hash'ler korunur)", "vinyl" not in plain and app._export_hash(plain) != app._export_hash(vspec))
    check("vinyl + oran 1: etkisiz, anahtar yok", "vinyl" not in chk(body(vinyl=True))[0])
    check("dosya adi kuyrugu: '0.85x plak'", "0.85x plak" in app._export_filename("Sarki", dict(vspec, label="Miks")))

    # --- ölçüm ayrıştırma
    m = app._VOLUMEDETECT_MAX.search("[Parsed_volumedetect_0] max_volume: -0.7 dB\nmean_volume: -17.2 dB")
    check("volumedetect ayristirma", m and m.group(1) == "-0.7")

    # --- çalışıyor mu / temizlik
    now = int(time.time())
    check("running: taze", app._export_is_running({"export": {"state": "running", "started": now}}))
    check("running: takilmis degil", not app._export_is_running(
        {"export": {"state": "running", "started": now - app.EXPORT_RUNNING_STALE_SECONDS - 5}}))
    check("running: done/yok degil", not app._export_is_running({"export": {"state": "done"}})
          and not app._export_is_running({}))
    check("silme engeli: disa aktarma surerken", "Disa aktarma" in (
        app._delete_block_reason({"state": "done", "export": {"state": "running", "started": now}}) or ""))

    tmp = pathlib.Path(tempfile.mkdtemp())
    folder = tmp / "exports"
    folder.mkdir()
    old, new = folder / ("a" * 32 + ".m4a"), folder / ("b" * 32 + ".m4a")
    for path in (old, new, folder / ("a" * 32 + ".json"), folder / ("b" * 32 + ".json")):
        path.write_bytes(b"x")
    long_ago = time.time() - app.EXPORT_TTL_SECONDS - 60
    for path in (old, folder / ("a" * 32 + ".json")):
        os.utime(path, (long_ago, long_ago))
    removed = app._export_cleanup(tmp)
    check("temizlik: 24 saatten eski dosya ve yan json silinir", removed == 2 and not old.exists()
          and new.exists() and (folder / ("b" * 32 + ".json")).exists())
    check("temizlik: exports klasoru yoksa sorun degil", app._export_cleanup(tmp / "yok") == 0)
    check("sabitler: m4a + wav (mp3 yok)", app.EXPORT_FORMATS == ("m4a", "wav"))
    check("sabitler: hiz/ton sinirlari uygulamayla ayni (0.5..1.5, +-6)",
          (app.EXPORT_MIN_RATE, app.EXPORT_MAX_RATE, app.EXPORT_MAX_SEMITONES) == (0.5, 1.5, 6))
    check("sabitler: TTL 24 saat", app.EXPORT_TTL_SECONDS == 86400)

    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
