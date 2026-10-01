"""Alt parca (Asama 10) kapilari ve durum yardimcilari: yerel test, Modal yok.

Kapsam: "vokal yok" ve lead payi kapilari (olculen sarkilarla), astats
ayristirma, 'running' takilma suresi, _sub_drop ve silme engeli. GPU/model
kismi (separate_sub) burada YOK: o canlida Zeus ve Final Duet ile dogrulanir.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\test_sub_gate.py
"""

import importlib.util
import json
import pathlib
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_sub_test", ROOT / "backend" / "app.py")
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


def test_gates(app):
    # Olculen sarkilar (stem yolu): lead / arka dB (vokale gore)
    measured = {
        "Zeus": (-0.16, -16.9, "ok"),
        "Usseewa": (-0.24, -14.1, "ok"),
        "HAZBIN": (-1.56, -6.57, "ok"),
        "NEM slowed": (-4.59, -2.2, "warn"),
        "Ado 8D": (-6.29, -1.51, "warn"),
        "Below The Surface": (-17.13, -0.1, "unreliable"),
    }
    for name, (lead, back, expected) in measured.items():
        share = app._sub_lead_share(lead, back)
        check(f"{name}: lead payi {share:.3f} -> {expected}",
              app._sub_lead_gate(share) == expected)
    check("lead payi: esit guc 0.5", abs(app._sub_lead_share(0.0, 0.0) - 0.5) < 1e-9)
    check("lead payi: HAZBIN ~0.76", abs(app._sub_lead_share(-1.56, -6.57) - 0.76) < 0.01)

    # Sinir degerleri: < 0.10 guvenilmez, < 0.50 uyari, >= 0.50 temiz
    check("0.0999 guvenilmez", app._sub_lead_gate(0.0999) == "unreliable")
    check("0.10 uyari (guvenilmez DEGIL)", app._sub_lead_gate(0.10) == "warn")
    check("0.4999 uyari", app._sub_lead_gate(0.4999) == "warn")
    check("0.50 temiz", app._sub_lead_gate(0.50) == "ok")
    check("1.0 temiz", app._sub_lead_gate(1.0) == "ok")

    # Vokal yok: -50 dBFS
    check("Final Duet -118.7 dBFS vokal yok", app._sub_vocal_gate(-118.7) == "no_vocals")
    check("-200 (sessiz) vokal yok", app._sub_vocal_gate(-200.0) == "no_vocals")
    check("-50.01 vokal yok", app._sub_vocal_gate(-50.01) == "no_vocals")
    check("-50.0 tam sinir: vokal VAR", app._sub_vocal_gate(-50.0) == "ok")
    for level in (-17.5, -18.8, -20.7, -22.4, -24.9, -25.1):
        check(f"gercek vokal {level} dBFS var", app._sub_vocal_gate(level) == "ok")
    check("sabitler", app.SUB_SILENT_DBFS == -50.0 and app.SUB_LEAD_UNRELIABLE == 0.10
          and app.SUB_LEAD_WARN == 0.50)


ASTATS_SAMPLE = """\
[Parsed_astats_0 @ 0x55] Channel: 1
[Parsed_astats_0 @ 0x55] DC offset: 0.000012
[Parsed_astats_0 @ 0x55] RMS level dB: -23.100000
[Parsed_astats_0 @ 0x55] Channel: 2
[Parsed_astats_0 @ 0x55] RMS level dB: -22.900000
[Parsed_astats_0 @ 0x55] Overall
[Parsed_astats_0 @ 0x55] DC offset: 0.000010
[Parsed_astats_0 @ 0x55] RMS level dB: -24.912345
[Parsed_astats_0 @ 0x55] RMS peak dB: -10.0
"""


def test_astats(app):
    check("astats: Overall RMS (kanallari degil)",
          abs(app._parse_astats_rms(ASTATS_SAMPLE) - (-24.912345)) < 1e-6)
    silent = ASTATS_SAMPLE.replace("-24.912345", "-inf").replace("-24.912345000", "-inf")
    silent = silent.replace("RMS level dB: -24.912345", "RMS level dB: -inf")
    check("astats: -inf -> -200", app._parse_astats_rms(silent) == -200.0)
    for bad, label in (("Channel: 1\nRMS level dB: -20", "Overall yok"),
                       ("Overall\nDC offset: 0", "RMS satiri yok")):
        try:
            app._parse_astats_rms(bad)
            check(f"astats: {label} hata verir", False)
        except ValueError:
            check(f"astats: {label} hata verir", True)
    check("astats: pozitif/ondaliksiz deger", app._parse_astats_rms("Overall\nRMS level dB: -9") == -9.0)


def test_running_and_block(app):
    now = time.time()
    check("running taze -> sürüyor", app._sub_is_running({"sub": {"state": "running", "started": now}}))
    check("running takilmis -> sürmüyor",
          not app._sub_is_running({"sub": {"state": "running",
                                           "started": now - app.SUB_RUNNING_STALE_SECONDS - 1}}))
    check("done -> sürmüyor", not app._sub_is_running({"sub": {"state": "done"}}))
    check("sub yok -> sürmüyor", not app._sub_is_running({}) and not app._sub_is_running(None))
    check("started yok -> takilmis sayilir (guvenli yön: yeniden denenebilir)",
          not app._sub_is_running({"sub": {"state": "running"}}))

    blocked = app._delete_block_reason({"state": "done", "sub": {"state": "running", "started": now}})
    check("alt ayrim surerken silme engellenir", bool(blocked) and "Alt parcalar" in blocked, str(blocked))
    check("alt ayrim bitince silinebilir",
          app._delete_block_reason({"state": "done", "sub": {"state": "done"}}) is None)
    check("alt ayrim takilmissa silinebilir",
          app._delete_block_reason({"state": "done", "sub": {"state": "running", "started": now - 99999}}) is None)
    check("ana sarki isleniyorsa eski engel korunur",
          bool(app._delete_block_reason({"state": "separating"})))


def test_drop(app):
    with tempfile.TemporaryDirectory() as tmp:
        app.DATA_DIR = tmp
        app.volume = FakeVolume()
        song = "a" * 64
        base = pathlib.Path(tmp) / "songs" / song
        (base / "master" / "sub").mkdir(parents=True)
        (base / "stems" / "sub").mkdir(parents=True)
        (base / "master" / "sub" / "lead.flac").write_bytes(b"x")
        (base / "stems" / "sub" / "lead.m4a").write_bytes(b"x")
        (base / "master" / "vocals.flac").write_bytes(b"ana stem")
        (base / "stems").mkdir(exist_ok=True)
        (base / "stems" / "vocals.m4a").write_bytes(b"ana m4a")
        (base / "status.json").write_text(json.dumps(
            {"id": song, "state": "done", "stems_version": 5, "pipeline": "hifi_v2",
             "sub": {"state": "done", "version": 9}}), encoding="utf-8")

        check("_sub_drop bir sey sildi", app._sub_drop(song) is True)
        check("alt parca dizinleri gitti",
              not (base / "master" / "sub").exists() and not (base / "stems" / "sub").exists())
        check("ana stem'lere DOKUNULMADI",
              (base / "master" / "vocals.flac").read_bytes() == b"ana stem"
              and (base / "stems" / "vocals.m4a").read_bytes() == b"ana m4a")
        status = json.loads((base / "status.json").read_text(encoding="utf-8"))
        check("status.sub silindi", "sub" not in status)
        check("stems_version/pipeline/state korundu",
              status["stems_version"] == 5 and status["pipeline"] == "hifi_v2"
              and status["state"] == "done")
        check("commit edildi", app.volume.commits >= 1)

        commits = app.volume.commits
        check("ikinci cagri no-op", app._sub_drop(song) is False)
        check("no-op commit etmez", app.volume.commits == commits)
        check("olmayan sarki hata vermez", app._sub_drop("b" * 64) is False)

        # Alan olmayan (eski) sarkida da calisir
        (base / "status.json").write_text(json.dumps({"id": song, "state": "done"}), encoding="utf-8")
        check("sub'i olmayan sarki: no-op", app._sub_drop(song) is False)


def main():
    app = load_app()
    test_gates(app)
    test_astats(app)
    test_running_and_block(app)
    test_drop(app)
    print("\n" + "=" * 60)
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    for name in FAILED:
        print(f"  BASARISIZ: {name}")
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
