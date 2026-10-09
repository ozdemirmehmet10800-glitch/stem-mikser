"""Hedef melodi (Mikrofon paketi 9, 1. oturum): saf yardimcilar ve is akisi, Modal/GPU yok.

SENTETIK ses kullanir (gercek sarki / vokal YOK). Kapsam: kaynak secimi (lead / vocals), sesli parca bulma, pYIN ciktisi temizleme
(kisa parca, kare seviyesi kapisi, oktav sicramasi duzeltme, aykiri), melody.bin kodlama/cozme ve bozuk dosya reddi, gercek pYIN ile
uctan uca is (FLAC -> melody.bin + status.melody), vokal yok kapisi, lead kaynagi, hata olunca onceki tamam kaydin geri konmasi.

Calistirma (numpy, soundfile, librosa gerekir; .venv'de var):
    .\\.venv\\Scripts\\python.exe tests\\test_melody_gate.py
"""

import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile

import numpy as np
import soundfile as sf

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED, FAILED = [], []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


class FakeVolume:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1

    def reload(self):
        pass


def load_app():
    spec = importlib.util.spec_from_file_location("app_melody_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def voice(seconds, freq_start, freq_end, rate=44100, amplitude=0.3, harmonics=6):
    """Sentetik 'sesli' ses: kayan perde + harmonikler (vokal gibi)."""
    t = np.arange(int(seconds * rate)) / rate
    freq = np.linspace(freq_start, freq_end, len(t))
    phase = 2 * np.pi * np.cumsum(freq) / rate
    y = sum(np.sin(h * phase) / h for h in range(1, harmonics + 1))
    return (amplitude * y / 1.8).astype(np.float32)


def make_song(root, song_id, audio=None, rate=44100, status_extra=None, lead=None):
    base = pathlib.Path(root) / "songs" / song_id
    (base / "master").mkdir(parents=True, exist_ok=True)
    if audio is not None:
        sf.write(str(base / "master" / "vocals.flac"), audio, rate, format="FLAC")
    if lead is not None:
        (base / "master" / "sub").mkdir(parents=True, exist_ok=True)
        sf.write(str(base / "master" / "sub" / "lead.flac"), lead, rate, format="FLAC")
    status = {"id": song_id, "title": "Test", "state": "done", "stems": ["vocals"], "stems_version": 7, "pipeline": "hifi_v2",
              "created_at": "2026-10-01T00:00:00Z", "duration": 4.0}
    status.update(status_extra or {})
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    return base


def read_status(root, song_id):
    return json.loads((pathlib.Path(root) / "songs" / song_id / "status.json").read_text("utf-8"))


def main():
    os.environ.setdefault("API_TOKEN", "x")
    os.environ.setdefault("SIGNING_KEY", "x")
    os.environ.setdefault("ALLOWED_ORIGINS", "http://localhost:8000")
    app = load_app()
    tmp = tempfile.mkdtemp()
    app.DATA_DIR = tmp
    app.volume = FakeVolume()

    # --- kaynak secimi
    pick = app._melody_pick_source
    check("auto: alt parca yok -> vocals", pick({}, "auto")[0] == "vocals")
    check("auto: alt parca hazir + guvenilir (ok) -> lead", pick({"sub": {"state": "done", "reliability": "ok"}}, "auto")[0] == "lead")
    check("auto: alt parca hazir ama 'warn' -> vocals (guvenilmez ayrim)", pick({"sub": {"state": "done", "reliability": "warn"}}, "auto")[0] == "vocals")
    check("auto: alt parca guvenilmez/calisiyor -> vocals", pick({"sub": {"state": "unreliable"}}, "auto")[0] == "vocals"
          and pick({"sub": {"state": "running"}}, "auto")[0] == "vocals")
    check("vocals istenirse her zaman vocals", pick({"sub": {"state": "done", "reliability": "ok"}}, "vocals")[0] == "vocals")
    check("lead istenir ama alt parca yok -> None + aciklama", pick({}, "lead")[0] is None and "Ana vokal" in pick({}, "lead")[1])
    check("lead istenir, alt parca hazir ('warn' olsa da kullanici istedi) -> lead", pick({"sub": {"state": "done", "reliability": "warn"}}, "lead")[0] == "lead")

    # --- sesli parca bulma
    check("_melody_runs: parcalar", app._melody_runs([0, 1, 1, 0, 1, 1, 1]) == [(1, 3), (4, 7)] and app._melody_runs([]) == [] and app._melody_runs([1, 1]) == [(0, 2)])

    # --- temizleme
    n = 120
    f0 = np.full(n, 220.0)
    voiced = np.ones(n, dtype=bool)
    rms = np.full(n, -20.0)
    f0[40] = 440.0                       # tek karelik oktav sicramasi (yukari)
    f0[41] = 110.0                       # ve asagi
    f0[60:63] = 261.63                   # 3 karelik kisa parca...
    voiced[57:60] = False; voiced[63:70] = False   # ...sessizlikle cevrili: atilmali
    voiced[80:90] = False                # sessiz boslu
    rms[100:110] = -70.0                 # kare seviyesi kapisinin altinda (nefes / artik)
    f0[20] = np.nan                      # pYIN NaN verirse
    cents, stats = app._melody_postprocess(f0, voiced, rms)
    a3 = 5700
    check("cikti int16, n kare", cents.dtype == np.int16 and len(cents) == n)
    check("oktav sicramalari (yukari ve asagi) komsulara kaydirildi (A3 = 5700 +-5 cent)", abs(int(cents[40]) - a3) <= 5 and abs(int(cents[41]) - a3) <= 5, f"{cents[40]} {cents[41]}")
    check("kararli parca A3'te (medyan 3 sonrasi +-2 cent)", all(abs(int(cents[i]) - a3) <= 2 for i in (5, 30, 45, 75)))
    check("3 karelik kisa parca atildi", int(cents[60:63].sum()) == 0 and stats["short_dropped"] >= 3)
    check("pYIN sessiz dedigi ve kare kapisinin altindaki kareler 0", int(cents[80:90].sum()) == 0 and int(cents[100:110].sum()) == 0)
    check("NaN perde sessiz sayilir", int(cents[20]) == 0)
    check("istatistik: sesli oran, oktav duzeltme >= 2, sicrama yok", stats["octave_fixes"] >= 2 and stats["jumps12"] == 0 and 0 < stats["voiced_ratio"] < 1, str(stats))
    check("istatistik: perde dagilimi (p50 = 57)", abs(stats["midi_p50"] - 57.0) < 0.05)

    # kalici (pencereden uzun) farkli perde aykiri sayilmaz; yavas kayma oktav sanilmaz
    f0b = np.concatenate([np.full(60, 220.0), np.full(60, 440.0)])
    cents_b, stats_b = app._melody_postprocess(f0b, np.ones(120, dtype=bool), np.full(120, -20.0))
    check("kalici oktav degisimi (gercek melodi) bozulmaz", abs(int(cents_b[10]) - 5700) <= 2 and abs(int(cents_b[110]) - 6900) <= 2)
    ramp = np.linspace(220.0, 330.0, 120)
    cents_c, stats_c = app._melody_postprocess(ramp, np.ones(120, dtype=bool), np.full(120, -20.0))
    check("yavas kayma korunur (duzeltme / atma yok)", stats_c["octave_fixes"] == 0 and stats_c["outliers_dropped"] == 0 and int(cents_c[0]) < int(cents_c[-1]))
    far = np.full(80, 220.0)
    far[40] = 233.08 * 2 ** 1.5          # oktav degil, ~1.5 oktav sapma: oturmuyor -> atilir
    cents_d, stats_d = app._melody_postprocess(far, np.ones(80, dtype=bool), np.full(80, -20.0))
    check("oktava oturmayan aykiri kare atilir", int(cents_d[40]) == 0 and stats_d["outliers_dropped"] == 1, str(stats_d))
    empty_cents, empty_stats = app._melody_postprocess(np.array([]), np.array([], dtype=bool), np.array([]))
    check("bos girdi patlamaz", len(empty_cents) == 0 and empty_stats["voiced"] == 0)

    # --- kodlama / cozme
    header = {"v": 1, "method": "pyin", "source": "vocals", "n": 120, "hop_s": 0.02321995}
    blob = app._melody_encode(cents, header)
    back_header, back = app._melody_decode(blob)
    check("kodlama gidis-donus: baslik ve kareler birebir", back_header == header and np.array_equal(back, cents))
    check("biçim: MEL1 + u32 + JSON + 2 bayt/kare", blob[:4] == b"MEL1" and len(blob) == 8 + int.from_bytes(blob[4:8], "little") + 2 * len(cents))
    for name, bad in (("kesik", blob[:-1]), ("sihirli bayt", b"XXXX" + blob[4:]), ("bos", b""), ("baslik uzunlugu", blob[:4] + (10 ** 6).to_bytes(4, "little") + blob[8:])):
        try:
            app._melody_decode(bad)
            check(f"bozuk dosya reddedilir: {name}", False)
        except ValueError:
            check(f"bozuk dosya reddedilir: {name}", True)

    # --- uctan uca is (gercek pYIN, sentetik ses)
    SONG, QUIET, LEADS, MISSING, PREV = "a" * 64, "b" * 64, "c" * 64, "d" * 64, "e" * 64
    audio = voice(4.0, 220.0, 330.0)
    make_song(tmp, SONG, audio=audio)
    result = app._extract_melody_impl(SONG, "auto", None)
    check("is: state=done, kaynak vocals", result["state"] == "done" and result["source"] == "vocals", str(result)[:160])
    header_out, frames = app._melody_decode((pathlib.Path(tmp) / "songs" / SONG / "melody.bin").read_bytes())
    check("melody.bin basligi: yontem pyin, parametreler, kaynak, kare suresi yazili",
          header_out["method"] == "pyin" and header_out["source"] == "vocals" and header_out["params"]["switch_prob"] == 0.01
          and abs(header_out["hop_s"] - 512 / 22050) < 1e-7 and header_out["sr"] == 22050 and header_out["n"] == len(frames), json.dumps(header_out)[:200])
    voiced_frames = frames[frames > 0]
    check("sentetik kayan perde: cogu kare sesli", len(voiced_frames) / len(frames) > 0.8, f"{len(voiced_frames) / len(frames):.2f}")
    expected = 69 + 12 * np.log2(np.linspace(220.0, 330.0, len(frames)) / 440.0)
    mask = frames > 0
    error = np.abs(frames[mask] / 100.0 - expected[mask])
    check("perde dogrulugu: medyan hata < 0,3 yarim ses, p95 < 1 (kayan sentetik ses)", np.median(error) < 0.3 and np.percentile(error, 95) < 1.0,
          f"medyan {np.median(error):.3f} p95 {np.percentile(error, 95):.3f}")
    saved = read_status(tmp, SONG)
    mel = saved["melody"]
    check("status.melody: done, surum, yontem, kaynak, ust surum, sure kirilimi, sesli oran",
          mel["state"] == "done" and mel["version"] > 0 and mel["method"] == "pyin" and mel["source"] == "vocals"
          and mel["parent_stems_version"] == 7 and mel["parent_pipeline"] == "hifi_v2" and set(mel["seconds"]) == {"decode", "pyin", "post", "total"}
          and mel["voiced_ratio"] > 0.8 and mel["bytes"] == len((pathlib.Path(tmp) / "songs" / SONG / "melody.bin").read_bytes()), str(mel)[:200])
    check("ana alanlara dokunulmadi (state, stems_version)", saved["state"] == "done" and saved["stems_version"] == 7)
    check("maliyet tahmini var ve kucuk", 0 < result["cost_usd_estimate"] < 0.01, str(result["cost_usd_estimate"]))
    check("gecici dosya kalmadi", not (pathlib.Path(tmp) / "songs" / SONG / "melody.bin.tmp").exists())

    # vokal yok
    make_song(tmp, QUIET, audio=(voice(3.0, 220.0, 330.0) * 1e-5))
    quiet = app._extract_melody_impl(QUIET, "auto", None)
    check("vokal yok: no_vocals, melody.bin YAZILMADI", quiet["state"] == "no_vocals" and read_status(tmp, QUIET)["melody"]["state"] == "no_vocals"
          and not (pathlib.Path(tmp) / "songs" / QUIET / "melody.bin").exists())

    # lead kaynagi
    make_song(tmp, LEADS, audio=voice(3.0, 220.0, 330.0), lead=voice(3.0, 262.0, 392.0),
              status_extra={"sub": {"state": "done", "reliability": "ok", "lead_share": 0.9}})
    lead = app._extract_melody_impl(LEADS, "auto", None)
    header_lead, frames_lead = app._melody_decode((pathlib.Path(tmp) / "songs" / LEADS / "melody.bin").read_bytes())
    check("alt parca guvenilirse ana vokal (lead.flac) kullanilir ve basliga yazilir", lead["source"] == "lead" and header_lead["source"] == "lead"
          and read_status(tmp, LEADS)["melody"]["source"] == "lead")
    check("lead perdesi okundu (262-392 Hz: ilk kareler ~ MIDI 60)", abs(np.median(frames_lead[:20][frames_lead[:20] > 0]) / 100.0 - 60.0) < 1.0)

    # hata -> onceki tamam kayit geri gelir (Modal sarmalayicisi .local ile)
    make_song(tmp, MISSING, audio=None)                       # vocals.flac yok
    done_prev = {"state": "done", "version": 5, "method": "pyin", "source": "vocals", "parent_stems_version": 7}
    base = pathlib.Path(tmp) / "songs" / MISSING
    status = read_status(tmp, MISSING)
    status["melody"] = dict(done_prev)
    (base / "status.json").write_text(json.dumps(status), encoding="utf-8")
    try:
        app.extract_melody.local(MISSING, "auto")
        raised = False
    except FileNotFoundError:
        raised = True
    after = read_status(tmp, MISSING)["melody"]
    check("dosya yoksa FileNotFoundError, onceki tamam kayit korunur + last_attempt", raised and after["state"] == "done" and after["version"] == 5
          and after["last_attempt"]["state"] == "error", str(after)[:200])
    make_song(tmp, PREV, audio=None)
    try:
        app.extract_melody.local(PREV, "auto")
    except FileNotFoundError:
        pass
    check("onceki kayit yoksa durum error + mesaj", read_status(tmp, PREV)["melody"]["state"] == "error" and "vocals.flac" in read_status(tmp, PREV)["melody"]["message"])

    # yeniden uretimde surum artar
    first = read_status(tmp, SONG)["melody"]["version"]
    again = app._extract_melody_impl(SONG, "vocals", read_status(tmp, SONG)["melody"])
    check("yeniden uretim: surum artar", again["version"] > first)

    # bayat isareti
    check("_melody_stale: ayni ayristirma degil / tamam degil", app._melody_stale({"stems_version": 7, "melody": {"state": "done", "parent_stems_version": 7}}) is False
          and app._melody_stale({"stems_version": 8, "melody": {"state": "done", "parent_stems_version": 7}}) is True
          and app._melody_stale({"stems_version": 8, "melody": {"state": "running"}}) is False and app._melody_stale({}) is False)
    now = 1_000_000.0
    real_time = app.time.time
    app.time.time = lambda: now
    check("_melody_is_running: taze running = true, takilmis = false", app._melody_is_running({"melody": {"state": "running", "started": now - 10}}) is True
          and app._melody_is_running({"melody": {"state": "running", "started": now - 99999}}) is False and app._melody_is_running({"melody": {"state": "done"}}) is False)
    app.time.time = real_time

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{len(PASSED)} gecti, {len(FAILED)} basarisiz")
    if FAILED:
        print("BASARISIZ:", *FAILED, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
