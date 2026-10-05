"""Tarayıcı <-> sunucu fark ölçümü için yerel araç (Aşama 15, 3. oturum).

Sentetik girişleri (gerçek şarkı/söz YOK; üretici backend/app.py `_export_diff_build`, Modal'daki karşılaştırma
aynı girişleri yeniden üretir) WAV olarak yazar ve küçük bir yerel sunucuyla tarayıcıdaki ölçüm sayfasını
(tests/export_diff.html: GERÇEK Engine + OfflineAudioContext) besler; sayfa sonuçları geri yollar. Sunucu tarafı
ve karşılaştırma `modal run backend/app.py::export_validate` içinde (gerçek ffmpeg, canlı imajın aynısı).

    .\\.venv\\Scripts\\python.exe tests\\export_diff.py            # girişleri üret + sunucuyu başlat (Ctrl+C ile durur)
    sonra tarayıcıda: http://127.0.0.1:8765/tests/export_diff.html   (sayfa kendiliğinden koşar, "bitti" yazar)
    .\\.venv\\Scripts\\python.exe -m modal run backend/app.py::export_validate

Çıktılar `tests/export_diff_out/` altında (gitignore'lı): scenarios.json, inputs/*.wav, results/*.f32.
results/<senaryo>.f32 = önce sol kanal, sonra sağ (Float32 LE): engine çıkışı, çalma başlangıcı (START_LEAD) atılmış.
"""

import importlib.util
import json
import pathlib
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "export_diff_out"
PORT = 8765


def load_app():
    spec = importlib.util.spec_from_file_location("app_export_diff", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generate():
    app = load_app()
    scenarios, inputs = app._export_diff_build()
    (OUT / "inputs").mkdir(parents=True, exist_ok=True)
    (OUT / "results").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "results").glob("*.f32"):
        old.unlink()
    for name, data in inputs.items():
        sf.write(str(OUT / "inputs" / f"{name}.wav"), data, app.EXPORT_DIFF_RATE, subtype="FLOAT")
    (OUT / "scenarios.json").write_text(json.dumps({"rate": app.EXPORT_DIFF_RATE, "scenarios": scenarios}, indent=1),
                                        encoding="utf-8")
    print(f"{len(scenarios)} senaryo, {len(inputs)} giris -> {OUT}")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        prefix = "/__result/"
        if not self.path.startswith(prefix):
            self.send_error(404)
            return
        name = pathlib.Path(self.path[len(prefix):]).name
        length = int(self.headers.get("Content-Length") or 0)
        (OUT / "results" / f"{name}.f32").write_bytes(self.rfile.read(length))
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if args and "__result" in str(args[0]):
            print("sonuc alindi:", args[0], flush=True)


if __name__ == "__main__":
    generate()
    if "--gen-only" in sys.argv:
        sys.exit(0)
    print(f"sunucu: http://127.0.0.1:{PORT}/tests/export_diff.html  (Ctrl+C ile durdur)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
