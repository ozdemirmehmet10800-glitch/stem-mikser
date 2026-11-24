"""Ayırma sonrası AAC kodlamasının AYNI ANDA yapılması (backend/app.py _encode_stems_parallel) - Modal'a hiç bağlanmaz.

Ölçüm (4 dk şarkı, Hi-Fi): 6 kanalın AAC'si SIRAYLA 97 sn, kanal başına durum yazımı toplam 33 sn sürüyordu. Burada:
  - kodlamaların gerçekten aynı anda koştuğu (sahte ffmpeg: her çağrı 0,3 sn),
  - her kanal için doğru girdi/çıktıyla bir ffmpeg çağrısı yapıldığı,
  - hata olursa yükseldiği (sessizce eksik stem kalmasın),
  - separate'in 4 CPU çekirdeği istediği ve durumu kanal başına değil bir kez yazdığı,
  - app.py satır sayısının değişmediği (Modal imaj önbelleği) sınanır.

Çalıştırma:
    .\\.venv\\Scripts\\python.exe tests\\test_parallel_encode.py
"""

import importlib.util
import pathlib
import re
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSED = []
FAILED = []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print(f"[{'OK  ' if condition else 'HATA'}] {name}" + (f"  -> {detail}" if detail else ""))


def load_app():
    spec = importlib.util.spec_from_file_location("app_parallel_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Fake:
    returncode = 0
    stdout = b""


def main():
    app = load_app()
    names = ["drums", "bass", "other", "vocals", "guitar", "piano"]
    jobs = [(pathlib.Path(f"master/{n}.flac"), pathlib.Path(f"stems/{n}.m4a")) for n in names]

    calls = []
    lock = threading.Lock()
    running = {"now": 0, "peak": 0}
    original_run = app._run

    def slow(cmd):
        with lock:
            calls.append(list(cmd))
            running["now"] += 1
            running["peak"] = max(running["peak"], running["now"])
        time.sleep(0.3)
        with lock:
            running["now"] -= 1
        return Fake()

    app._run = slow
    app._SOXR_OK = None
    try:
        started = time.time()
        seconds = app._encode_stems_parallel(jobs, 2)
        wall = time.time() - started
    finally:
        app._run = original_run
        app._SOXR_OK = None
    check("6 kanal AYNI ANDA kodlanıyor (sırayla 1,8 sn sürerdi)", wall < 0.9 and running["peak"] >= 4, f"{wall:.2f} sn, en çok {running['peak']} eşzamanlı")
    check("dönen süre duvar saati", 0.25 <= seconds <= 0.9, str(seconds))
    check("her kanal için tek ffmpeg çağrısı", len(calls) == 6, str(len(calls)))
    pairs = sorted((cmd[cmd.index("-i") + 1], cmd[-1]) for cmd in calls)
    check("girdi/çıktı eşleşmesi doğru (FLAC asıl -> aynı adlı m4a)",
          pairs == sorted((str(a), str(b)) for a, b in jobs), str(pairs[:2]))
    check("hepsi soxr + 48 kHz + 256k AAC", all("resampler=soxr" in " ".join(c) and "48000" in c and "256k" in c for c in calls))

    # hata yükselmeli
    def broken(cmd):
        if "vocals" in " ".join(cmd):
            raise RuntimeError("ffmpeg basarisiz (kod 1): bozuk")
        return Fake()

    app._run = broken
    app._SOXR_OK = True
    raised = False
    try:
        app._encode_stems_parallel(jobs, 2)
    except RuntimeError:
        raised = True
    finally:
        app._run = original_run
        app._SOXR_OK = None
    check("bir kanal bozulursa hata yükselir (eksik stem sessizce kalmaz)", raised)

    app._run = slow
    try:
        check("tek iş de çalışır", app._encode_stems_parallel(jobs[:1], 2) >= 0.25)
    finally:
        app._run = original_run
        app._SOXR_OK = None

    source = (ROOT / "backend" / "app.py").read_text(encoding="utf-8")
    check("app.py satır sayısı değişmedi (Modal imaj önbelleği: 9296)", len(source.splitlines()) == 9296, str(len(source.splitlines())))
    decorator = source[source.index("def separate(") - 700: source.index("def separate(")]
    check("separate 4 CPU çekirdeği istiyor, GPU aynı (T4)", re.search(r'gpu="T4", cpu=4\.0', decorator) is not None)
    body = source[source.index("        written = []"): source.index("aac_seconds = _encode_stems_parallel(jobs, channels)")]
    check("durum kanal başına değil BİR kez yazılıyor", body.count("_write_status(") == 1, str(body.count("_write_status(")))
    check("FLAC'lar hâlâ 24-bit asıl olarak yazılıyor", "subtype=FLAC_SUBTYPE" in body and "master_dir" in body)
    check("sonuç zamanlamasında aac_encode hâlâ raporlanıyor", '"aac_encode": round(aac_seconds, 2)' in source)

    print(f"\ngecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    if FAILED:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
