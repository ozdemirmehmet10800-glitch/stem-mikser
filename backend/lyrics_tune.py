"""Söz çıkarma AYAR DENEMESİ (2026-11-26): otomatik çıkarmanın (Whisper) kelime hata oranı ayarla düşer mi?

AYRI bir Modal uygulaması (`lyrics_experiment.py` gibi). `backend/app.py` değişmez, canlıya dokunulmaz. Volume yalnız OKUNUR
(şarkıların master/vocals.flac'ı; hiçbir şarkıya iş başlatılmaz, lyrics.json/status.json'a yazılmaz).

Üretimle BİREBİR aynı kod: app.py'deki `_lyr_*` yardımcıları ve sabitler (AST ile) çıkarılıp konteynerde çalıştırılır, yani
"base" = bugünkü canlı ayar (dil algılama, enerji maskesi, kısa/tekrar süzgeci dahil). Adaylar yalnız `model.transcribe`
seçeneklerini değiştirir:
  base         canlıdaki ayar
  prompt       + initial_prompt = şarkının (temizlenmiş) adı ve sanatçısı
  beam_prompt  + initial_prompt + beam_size=10, patience=2 (daha geniş arama)
  beam         yalnız beam_size=10, patience=2 (ipucu yok)

Tek konteyner, model BİR kez yüklenir (maliyet ~ süre x T4 0,59 $/sa). Referans sözler `backend/lyrics_ref/` ve ham çıktılar
`backend/lyrics_out/` .gitignore'da: ASLA commit edilmez; konsola söz METNİ yazılmaz, yalnız sayılar.

    modal run backend/lyrics_tune.py --variants base,prompt,beam_prompt
    python backend/lyrics_tune.py score
"""

import ast
import json
import pathlib
import sys
import time

import modal

APP_NAME = "stem-mikser-soz-ayar"
DATA_DIR = "/data"
HF_HOME = "/data/weights-lyrics/hf"
GPU_DOLLAR_PER_SECOND = 0.59 / 3600

HERE = pathlib.Path(__file__).resolve().parent
REF_DIR = HERE / "lyrics_ref"
OUT_DIR = HERE / "lyrics_out"

# anahtar -> (şarkı kimliği, beklenen dil, initial_prompt, referans dosyası)
SONGS = {
    "zeus": ("19b73f4eb70946c504cef2a645d36f7544b100f290b887c6c091f5ddd7a394ed", "tr",
             "Zeus Kabadayı & Rota - Çok Mutlu Bir Şarkı", "zeus.txt"),
    "madem": ("f369c618ac0db3927b31eb528eddb932e7861eac4742b7b0cc764999bcb29104", "tr",
              "Dolu Kadehi Ters Tut - Madem", "madem.txt"),
    "addict": ("d48f5a850117a70cb95e7e3a6a5c83cc4a55f5728e81716895ede4f055313521", "en",
               "Hazbin Hotel - Addict", "addict.txt"),
    "holod": ("d43911680c1deadefbd4ec51fd6610b87c5dad2000ded681d53bbe0dfe19ec02", "ru",
              "холод по спине", "holod.txt"),
}
VARIANTS = {
    "base": {},
    "prompt": {"prompt": True},
    "beam_prompt": {"prompt": True, "beam_size": 10, "patience": 2.0},
    "beam": {"beam_size": 10, "patience": 2.0},
}

_NVIDIA = "/usr/local/lib/python3.11/site-packages/nvidia"
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("torch==2.5.1", "torchaudio==2.5.1", "numpy==1.26.4")
    .pip_install("faster-whisper==1.2.1", "ctranslate2==4.6.0", "stable-ts==2.19.1", "soundfile==0.13.1")
    .env({
        "HF_HOME": HF_HOME,
        "LD_LIBRARY_PATH": f"{_NVIDIA}/cudnn/lib:{_NVIDIA}/cublas/lib:{_NVIDIA}/cuda_runtime/lib",
    })                     # canlıdaki lyrics_image ile AYNI tanım: Modal imaj önbelleği yeniden kullanılır (kurulum yok)
)
app = modal.App(APP_NAME)
volume = modal.Volume.from_name("stems-vol")


def production_helpers() -> str:
    """app.py'den: `_run`, `_decode_mono`, `_song_dir`, tüm `_lyr_*` fonksiyonları ve BÜYÜK HARFLİ sabitler (kaynak metin)."""
    source = (HERE / "app.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    parts = ["import contextlib, json, os, pathlib, re, subprocess, time"]
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and (node.name.startswith("_lyr_") or node.name in ("_run", "_decode_mono", "_song_dir")):
            parts.append(ast.get_source_segment(source, node))
        elif isinstance(node, ast.Assign) and all(isinstance(t, ast.Name) and t.id.isupper() for t in node.targets):
            segment = ast.get_source_segment(source, node)
            parts.append(f"try:\n    {segment.replace(chr(10), chr(10) + '    ')}\nexcept Exception:\n    pass")
    return "\n\n".join(parts)


@app.function(image=image, gpu="T4", volumes={DATA_DIR: volume}, timeout=1800)
def tune(helpers: str, jobs: list, variants: dict) -> dict:
    import stable_whisper

    started = time.time()
    ns: dict = {}
    exec(helpers, ns)                                         # noqa: S102 - kendi depomuzun kodu
    model = stable_whisper.load_faster_whisper(ns["LYRICS_MODEL"], device="cuda", compute_type="float16")
    load_s = round(time.time() - started, 1)
    results = {}
    for job in jobs:
        path = pathlib.Path(DATA_DIR) / "songs" / job["id"] / "master" / "vocals.flac"
        audio = ns["_decode_mono"](path, ns["LYRICS_RATE"])
        active, _thr, _p95 = ns["_lyr_activity"](ns["_lyr_levels"](audio))
        t0 = time.time()
        detected, detail = ns["_lyr_detect_language"](model, audio)
        song = {"duration": round(len(audio) / ns["LYRICS_RATE"], 1), "detected": detected,
                "scores": (detail or {}).get("scores"), "detect_s": round(time.time() - t0, 1), "variants": {}}
        lang = job["lang"]                                     # varyantlar aynı dilde karşılaştırılır
        for name, spec in variants.items():
            options = dict(language=lang, vad=False, word_timestamps=True, condition_on_previous_text=False, regroup=True)
            if spec.get("prompt"):
                options["initial_prompt"] = job["prompt"]
            for key in ("beam_size", "patience", "best_of"):
                if key in spec:
                    options[key] = spec[key]
            t1 = time.time()
            result = model.transcribe(audio, **options)
            lines = ns["_lyr_clean_lines"](ns["_lyr_mask_filter"](ns["_lyr_segments"](result), active))
            song["variants"][name] = {"seconds": round(time.time() - t1, 1), "lines": [line["text"] for line in lines]}
            print(f"[ayar] {job['key']} {name}: {len(lines)} satir, {song['variants'][name]['seconds']} sn", flush=True)
        results[job["key"]] = song
    wall = round(time.time() - started, 1)
    return {"results": results, "load_s": load_s, "wall_s": wall, "usd": round(wall * GPU_DOLLAR_PER_SECOND, 4)}


@app.local_entrypoint()
def main(songs: str = ",".join(SONGS), variants: str = ",".join(VARIANTS)):
    jobs = [{"key": k, "id": SONGS[k][0], "lang": SONGS[k][1], "prompt": SONGS[k][2]} for k in songs.split(",")]
    chosen = {v: VARIANTS[v] for v in variants.split(",")}
    out = tune.remote(production_helpers(), jobs, chosen)
    OUT_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (OUT_DIR / f"tune_{stamp}.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"kaydedildi: lyrics_out/tune_{stamp}.json  yukleme {out['load_s']} sn, toplam {out['wall_s']} sn, ~{out['usd']} $")
    score_file(OUT_DIR / f"tune_{stamp}.json")


def score_file(path: pathlib.Path):
    sys.path.insert(0, str(HERE))
    from lyrics_experiment import _error_rate                 # aynı ölçüt (Aşama 11)

    data = json.loads(path.read_text(encoding="utf-8"))
    names = None
    totals = {}
    for key, song in data["results"].items():
        ref_path = REF_DIR / SONGS[key][3]
        if not ref_path.exists():
            print(f"{key}: referans yok")
            continue
        reference = ref_path.read_text(encoding="utf-8")
        lang = SONGS[key][1]
        names = list(song["variants"])
        row = []
        for name in names:
            rate = _error_rate(reference, "\n".join(song["variants"][name]["lines"]), lang)
            value = rate[1]                                  # (ölçüt adı, oran, referans kelime sayısı)
            totals.setdefault(name, []).append(value)
            row.append(f"{name} {value:.3f} ({song['variants'][name]['seconds']} sn)")
        print(f"{key:7s} [{lang}, algılanan {song['detected']}]: " + " | ".join(row))
    if names:
        print("ORTALAMA: " + " | ".join(f"{n} {sum(v) / len(v):.3f}" for n, v in totals.items()))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "score":
    files = sorted(OUT_DIR.glob("tune_*.json"))
    score_file(pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else files[-1])
