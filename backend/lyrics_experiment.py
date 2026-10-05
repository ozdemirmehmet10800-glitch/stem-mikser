"""Aşama 11 DENEYİ - şarkı sözü çıkarma adaylarının ölçümü.

AYRI bir Modal uygulaması (`experiment.py` gibi). `backend/app.py` hiç değişmiyor,
deploy YOK, canlı endpoint'e dokunulmuyor. Volume yalnız OKUNUYOR; tek yazılan şey
model ağırlıkları (`/data/weights-lyrics/`).

Adaylar (hepsi aynı `Systran/faster-whisper-large-v3` ağırlığı, CTranslate2 fp16):
  raw          faster-whisper, VARSAYILAN ayarlar (taban çizgisi)
  guard        condition_on_previous_text=False + silero VAD + no_speech/sıkıştırma
               eşikleri + hallucination_silence_threshold
  novad(_gate) guard'ın VAD'siz hali (NEM slowed+reverb'de VAD sesi atıyor)
  guard_gate   guard, ama ses ÖNCE vokal enerjisiyle kapılanmış (sessiz yerler 0)
  stable       stable-ts (faster-whisper arka ucu), vad=True
  stable_gate  stable, kapılanmış ses
Her aday ayrıca YAZIM SONRASI enerji maskesinden geçirilip `lines_masked` olarak
saklanıyor (kelimenin orta noktası sessiz çerçevedeyse atılır).
"Yapıştır ve hizala": stable-ts `align()` ile verilen metin sese hizalanır.

Girdiler: `vocals` (master/vocals.flac) ve, alt ayrımı olan şarkılarda, `lead`
(master/sub/lead.flac).

TELİF: gerçek sözler (`backend/lyrics_ref/`) ve ham çıktılar (`backend/lyrics_out/`)
.gitignore'da; ikisi de ASLA commit edilmez. Konsola söz METNİ yazılmaz, yalnız sayı.

Çalıştırma (hepsi .venv'den, UTF-8 ortamıyla):
    modal run backend/lyrics_experiment.py::fetch
    modal run backend/lyrics_experiment.py::run --songs zeus --variants raw,guard
    modal run backend/lyrics_experiment.py::align --songs zeus
    python backend/lyrics_experiment.py score          (yerel, ücretsiz)
"""

import json
import os
import pathlib
import subprocess
import sys
import time
import unicodedata

import modal

APP_NAME = "stem-mikser-soz-deney"
VOLUME_NAME = "stems-vol"
DATA_DIR = "/data"
HF_HOME = "/data/weights-lyrics/hf"
MODEL_NAME = "large-v3"
RATE = 16000
HOP = 0.05                      # sn: enerji çerçevesi
SILENT_DBFS = -50.0             # üretimdeki "vokal yok" kapısıyla AYNI sayı
GPU_DOLLAR_PER_SECOND = 0.59 / 3600     # T4 (PLAN.md maliyet ölçümleriyle aynı varsayım)

HERE = pathlib.Path(__file__).resolve().parent
REF_DIR = HERE / "lyrics_ref"
OUT_DIR = HERE / "lyrics_out"

# anahtar -> (başlıkta aranan iğne, Whisper dili, referans dosyası)
SONGS = {
    "zeus": ("Zeus", "tr", "zeus.txt"),
    "usseewa": ("Minachu", "tr", "usseewa_tr.txt"),
    "hazbin": ("HAZBIN", "tr", "hazbin.txt"),
    "below": ("Below The Surface", "en", "below_the_surface.txt"),
    "nem": ("nothing else matters", "en", "nem.txt"),
    "ado": ("うっせぇわ", "ja", "ado.txt"),
    "finalduet": ("Final Duet", None, None),
}
VARIANTS = ("raw", "guard", "guard_gate", "novad", "novad_gate", "stable", "stable_gate", "stable_novad")

_NVIDIA = "/usr/local/lib/python3.11/site-packages/nvidia"
lyrics_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install("torch==2.5.1", "torchaudio==2.5.1", "numpy==1.26.4")
    .pip_install(
        "faster-whisper==1.2.1",
        "ctranslate2==4.6.0",        # CUDA 12 + cuDNN 9 (torch 2.5.1 cu124 ile uyumlu)
        "stable-ts==2.19.1",
        "soundfile==0.13.1",
    )
    .env({
        "HF_HOME": HF_HOME,
        "LD_LIBRARY_PATH": f"{_NVIDIA}/cudnn/lib:{_NVIDIA}/cublas/lib:{_NVIDIA}/cuda_runtime/lib",
        "PYTHONUNBUFFERED": "1",
    })
)

app = modal.App(APP_NAME)
volume = modal.Volume.from_name(VOLUME_NAME)


# ----------------------------------------------------------------- yardımcılar
def _decode(path: str):
    """ffmpeg -> 16 kHz mono float32 numpy."""
    import numpy as np
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        capture_output=True, check=True)
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def _levels(audio):
    """HOP çerçevelerinde dBFS (sinüs tam ölçekte 0 değil, düz RMS)."""
    import numpy as np
    size = int(HOP * RATE)
    count = len(audio) // size
    frames = audio[: count * size].reshape(count, size).astype(np.float64)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-9))


def _activity(levels):
    """(aktif çerçeve maskesi, eşik). Eşik mutlak -50 dBFS ve tepe-40 dB'nin büyüğü."""
    import numpy as np
    p95 = float(np.percentile(levels, 95))
    threshold = max(SILENT_DBFS, p95 - 40.0)
    return levels > threshold, threshold, p95


def _fill_short_gaps(active, max_gap_frames):
    """Kısa nefes boşluklarını aktif say (ifade bütünlüğü)."""
    out = active.copy()
    n = len(out)
    i = 0
    while i < n:
        if not out[i]:
            j = i
            while j < n and not out[j]:
                j += 1
            if i > 0 and j < n and (j - i) <= max_gap_frames:
                out[i:j] = True
            i = j
        else:
            i += 1
    return out


def _silence_regions(active, min_seconds=2.0):
    """Ardışık inaktif çerçeve dizileri >= min_seconds (çerçeve çiftleri)."""
    regions = []
    n = len(active)
    i = 0
    while i < n:
        if not active[i]:
            j = i
            while j < n and not active[j]:
                j += 1
            if (j - i) * HOP >= min_seconds:
                regions.append((i, j))
            i = j
        else:
            i += 1
    return regions


def _gate_audio(audio, active):
    """Sessiz çerçeveleri 0'a çeker (kısa nefes boşlukları açık kalır)."""
    import numpy as np
    keep = _fill_short_gaps(active, int(0.3 / HOP))
    size = int(HOP * RATE)
    gated = audio.copy()
    for k in range(len(keep)):
        if not keep[k]:
            gated[k * size:(k + 1) * size] = 0.0
    tail = len(keep) * size
    if tail < len(gated) and not keep[-1:].any():
        gated[tail:] = 0.0
    return gated


def _line_dict(start, end, text, words=None, **extra):
    line = {"start": round(float(start), 3), "end": round(float(end), 3), "text": text.strip()}
    if words is not None:
        line["words"] = [dict({"s": round(float(w[0]), 3), "e": round(float(w[1]), 3), "w": w[2]},
                              **({"p": round(float(w[3]), 3)} if len(w) > 3 and w[3] is not None else {}))
                         for w in words]
    line.update(extra)
    return line


def _mask_filter(lines, active):
    """Üretim süzgeci adayı: sessiz çerçevede kalan kelimeleri ve boş satırları at,
    aynı metnin 3'ten fazla art arda tekrarını kes."""
    n = len(active)
    kept = []
    for line in lines:
        words = line.get("words") or []
        if words:
            alive = []
            for w in words:
                mid = int(((w["s"] + w["e"]) / 2) / HOP)
                if 0 <= mid < n and active[mid]:
                    alive.append(w)
            if not alive:
                continue
            text = "".join(x["w"] for x in alive) if not any(" " in x["w"] for x in alive) \
                else " ".join(x["w"].strip() for x in alive)
            line = dict(line, words=alive, start=alive[0]["s"], end=alive[-1]["e"], text=text.strip())
        else:
            a, b = int(line["start"] / HOP), max(int(line["end"] / HOP), int(line["start"] / HOP) + 1)
            if b > n or active[a:b].mean() < 0.3:
                continue
        kept.append(line)
    out, run = [], 0
    for line in kept:
        if out and out[-1]["text"] == line["text"]:
            run += 1
            if run >= 3:
                continue
        else:
            run = 0
        out.append(line)
    return out


def _quantile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 3)


def _metrics(lines, active, silences, duration):
    """Metin içermeyen sayılar: uydurma ve zaman uyumu."""
    n = len(active)
    in_silence = 0
    for line in lines:
        a, b = int(line["start"] / HOP), int(line["end"] / HOP)
        span = max(b - a, 1)
        covered = sum(max(0, min(b, e) - max(a, s)) for s, e in silences)
        if covered / span >= 0.5:
            in_silence += 1
    # ifade başlangıçları: >= 0.5 sn sessizlikten sonra ses başlayan anlar
    filled = _fill_short_gaps(active, int(0.3 / HOP))
    onsets = [k * HOP for k in range(1, n) if filled[k] and not filled[k - 1]]
    if n and filled[0]:
        onsets.insert(0, 0.0)
    errors, prev_end = [], -9.0
    for line in lines:
        if line["start"] - prev_end >= 0.3 and onsets:
            nearest = min(onsets, key=lambda o: abs(o - line["start"]))
            if abs(nearest - line["start"]) <= 2.0:
                errors.append(line["start"] - nearest)
        prev_end = max(prev_end, line["end"])
    start_silent = sum(1 for line in lines
                       if 0 <= int(line["start"] / HOP) < n and not filled[int(line["start"] / HOP)])
    abserr = [abs(e) for e in errors]
    words = sum(len(l.get("words") or []) for l in lines)
    probs = [w["p"] for l in lines for w in (l.get("words") or []) if "p" in w]
    return {
        "silent_line_ratio": round(in_silence / max(len(lines), 1), 3),
        "mean_word_prob": round(sum(probs) / len(probs), 3) if probs else None,
        "lines": len(lines), "words": words,
        "lines_in_silence": in_silence,
        "silence_regions": len(silences),
        "silence_seconds": round(sum(e - s for s, e in silences) * HOP, 1),
        "line_starts_in_gap": start_silent,
        "phrase_onsets": len(onsets),
        "onset_pairs": len(errors),
        "onset_err_median_s": _quantile(abserr, 0.5),
        "onset_err_p90_s": _quantile(abserr, 0.9),
        "onset_signed_median_s": _quantile(errors, 0.5),   # + = satır sesten SONRA
        "mean_line_seconds": round(sum(l["end"] - l["start"] for l in lines) / max(len(lines), 1), 2),
        "duration_s": round(duration, 1),
    }


def _detect_language(model, audio, active):
    """Vokal enerjisi en yüksek 4 adet 30 sn'lik pencerede ayrı algılama, oy."""
    import numpy as np
    size = 30 * RATE
    if len(audio) < size:
        windows = [audio]
    else:
        step = 10 * RATE
        starts = list(range(0, len(audio) - size + 1, step))
        scored = sorted(starts, key=lambda s: -float(np.mean(audio[s:s + size] ** 2)))
        chosen = []
        for s in scored:
            if all(abs(s - c) >= size for c in chosen):
                chosen.append(s)
            if len(chosen) == 4:
                break
        windows = [audio[s:s + size] for s in chosen]
    votes = {}
    detail = []
    for window in windows:
        try:
            language, probability, _ = model.detect_language(audio=window)
        except Exception as error:      # sürüm farkı: kaydet, düşme
            return {"error": f"{type(error).__name__}: {error}"[:200]}
        votes[language] = votes.get(language, 0) + 1
        detail.append([language, round(float(probability), 3)])
    winner = max(votes, key=votes.get)
    return {"winner": winner, "votes": votes, "windows": detail}


def _fw_lines(segments):
    lines = []
    for seg in segments:
        words = [(w.start, w.end, w.word) for w in (seg.words or [])]
        text = seg.text
        lines.append(_line_dict(seg.start, seg.end, text, words,
                                avg_logprob=round(float(seg.avg_logprob), 3),
                                no_speech=round(float(seg.no_speech_prob), 3)))
    return lines


def _stable_lines(result):
    lines = []
    for seg in result.segments:
        words = [(w.start, w.end, w.word, getattr(w, "probability", None)) for w in (seg.words or [])]
        lines.append(_line_dict(seg.start, seg.end, seg.text, words))
    return lines


def _find_song(needle: str):
    root = pathlib.Path(DATA_DIR) / "songs"
    found = []
    for entry in root.iterdir():
        path = entry / "status.json"
        if not path.is_file():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("state") != "done" or data.get("source_song"):
            continue
        title = str(data.get("title") or "")
        if needle.lower() in title.lower():
            found.append((str(data.get("created_at") or ""), entry.name, title, data))
    if not found:
        raise FileNotFoundError(needle)
    found.sort(reverse=True)
    return found[0]


# ----------------------------------------------------------------- Modal işleri
@app.function(image=lyrics_image, gpu="T4", volumes={DATA_DIR: volume}, timeout=3600)
def fetch_run() -> dict:
    """Ağırlıkları Volume'a indirir (HF önbelleği)."""
    from faster_whisper import WhisperModel
    t0 = time.time()
    pathlib.Path(HF_HOME).mkdir(parents=True, exist_ok=True)
    WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
    volume.commit()
    import ctranslate2
    import faster_whisper
    import stable_whisper
    import torch
    return {"seconds": round(time.time() - t0, 1), "ctranslate2": ctranslate2.__version__,
            "faster_whisper": faster_whisper.__version__,
            "stable_ts": getattr(stable_whisper, "__version__", "?"), "torch": str(torch.__version__),
            "cuda_devices": ctranslate2.get_cuda_device_count()}


@app.function(image=lyrics_image, gpu="T4", volumes={DATA_DIR: volume}, timeout=3300,
              max_containers=1)
def transcribe_song(key: str, variants: list, inputs: list, ref_text: str = "") -> dict:
    """Bir şarkıda tüm (girdi x aday) birleşimlerini koşar. Metin YAZMAZ, döner."""
    import numpy as np
    from faster_whisper import WhisperModel

    needle, language, _ = SONGS[key]
    volume.reload()
    _, song_id, title, status = _find_song(needle)
    song_dir = pathlib.Path(DATA_DIR) / "songs" / song_id
    result = {"key": key, "song_id": song_id, "title_len": len(title), "language_forced": language,
              "inputs": {}, "timing": {}}
    t_start = time.time()
    t0 = time.time()
    model = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
    result["timing"]["model_load_s"] = round(time.time() - t0, 1)

    paths = {"vocals": song_dir / "master" / "vocals.flac",
             "lead": song_dir / "master" / "sub" / "lead.flac"}
    gpu_s_by_variant = {}
    smodel_holder = {}
    for input_name in inputs:
        path = paths[input_name]
        if not path.is_file():
            result["inputs"][input_name] = {"skipped": "dosya yok"}
            continue
        audio = _decode(str(path))
        duration = len(audio) / RATE
        levels = _levels(audio)
        active, threshold, p95 = _activity(levels)
        silences = _silence_regions(_fill_short_gaps(active, int(0.5 / HOP)))
        gated = _gate_audio(audio, active)
        info = {"duration_s": round(duration, 1), "p95_dbfs": round(p95, 1),
                "activity_threshold_dbfs": round(threshold, 1),
                "rms_dbfs": round(float(20 * np.log10(max(float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))), 1e-9))), 1),
                "language_detect": _detect_language(model, audio, active),
                "variants": {}}
        for variant in variants:
            source = gated if variant.endswith("_gate") else audio
            t1 = time.time()
            entry = {}
            try:
                if variant in ("raw", "guard", "guard_gate", "novad", "novad_gate"):
                    kwargs = dict(language=language, word_timestamps=True, beam_size=5)
                    if variant != "raw":
                        kwargs.update(
                            condition_on_previous_text=False,
                            # novad*: silero VAD kapalı (reverb'li vokalde sesi konuşma saymıyor)
                            vad_filter=not variant.startswith("novad"),
                            vad_parameters=dict(min_silence_duration_ms=500),
                            no_speech_threshold=0.6, compression_ratio_threshold=2.4,
                            log_prob_threshold=-1.0, hallucination_silence_threshold=2.0)
                    segments, tinfo = model.transcribe(source, **kwargs)
                    lines = _fw_lines(list(segments))
                    entry["language_used"] = tinfo.language
                    entry["language_prob"] = round(float(tinfo.language_probability), 3)
                else:
                    import stable_whisper
                    if smodel_holder.get("m") is None:      # bir kez yükle (T4'te iki kopya sığar, ikinci SIZINTI OOM)
                        smodel_holder["m"] = stable_whisper.load_faster_whisper(
                            MODEL_NAME, device="cuda", compute_type="float16")
                    smodel = smodel_holder["m"]
                    res = smodel.transcribe(source, language=language, vad=not variant.startswith("stable_novad"), word_timestamps=True,
                                            condition_on_previous_text=False, regroup=True)
                    lines = _stable_lines(res)
            except Exception as error:
                entry["error"] = f"{type(error).__name__}: {error}"[:400]
                info["variants"][variant] = entry
                continue
            seconds = time.time() - t1
            masked = _mask_filter(lines, active)
            entry.update({"seconds": round(seconds, 1),
                          "speed_x_realtime": round(duration / seconds, 1) if seconds else None,
                          "metrics": _metrics(lines, active, silences, duration),
                          "metrics_masked": _metrics(masked, active, silences, duration),
                          "lines": lines, "lines_masked": masked})
            gpu_s_by_variant[f"{input_name}/{variant}"] = round(seconds, 1)
            info["variants"][variant] = entry
        result["inputs"][input_name] = info
    result["timing"]["total_s"] = round(time.time() - t_start, 1)
    result["timing"]["by_variant_s"] = gpu_s_by_variant
    result["timing"]["est_dollars_total"] = round(result["timing"]["total_s"] * GPU_DOLLAR_PER_SECOND, 4)
    return result


@app.function(image=lyrics_image, gpu="T4", volumes={DATA_DIR: volume}, timeout=3300,
              max_containers=1)
def align_song(key: str, ref_text: str, inputs: list) -> dict:
    """Verilen metni (satır satır) stable-ts align() ile sese hizalar."""
    import numpy as np
    import stable_whisper

    needle, language, _ = SONGS[key]
    volume.reload()
    _, song_id, _title, _status = _find_song(needle)
    song_dir = pathlib.Path(DATA_DIR) / "songs" / song_id
    result = {"key": key, "inputs": {}, "timing": {}}
    t_start = time.time()
    t0 = time.time()
    backend = "faster-whisper"
    model = stable_whisper.load_faster_whisper(MODEL_NAME, device="cuda", compute_type="float16")
    if not hasattr(model, "align"):
        backend = "openai-whisper(stable_whisper.load_model)"
        model = stable_whisper.load_model(MODEL_NAME, device="cuda")
    result["timing"]["model_load_s"] = round(time.time() - t0, 1)
    result["align_backend"] = backend
    paths = {"vocals": song_dir / "master" / "vocals.flac",
             "lead": song_dir / "master" / "sub" / "lead.flac"}
    for input_name in inputs:
        path = paths[input_name]
        if not path.is_file():
            result["inputs"][input_name] = {"skipped": "dosya yok"}
            continue
        audio = _decode(str(path))
        duration = len(audio) / RATE
        levels = _levels(audio)
        active, threshold, p95 = _activity(levels)
        silences = _silence_regions(_fill_short_gaps(active, int(0.5 / HOP)))
        t1 = time.time()
        entry = {}
        for tag, source in (("plain", audio), ("gate", _gate_audio(audio, active))):
            sub = {}
            try:
                t2 = time.time()
                res = model.align(source, ref_text, language=language, original_split=True)
                lines = _stable_lines(res)
                sub = {"seconds": round(time.time() - t2, 1), "metrics": _metrics(lines, active, silences, duration),
                       "lines": lines}
            except Exception as error:
                sub = {"error": f"{type(error).__name__}: {error}"[:400]}
            entry[tag] = sub
        result["inputs"][input_name] = entry
    result["timing"]["total_s"] = round(time.time() - t_start, 1)
    result["timing"]["est_dollars_total"] = round(result["timing"]["total_s"] * GPU_DOLLAR_PER_SECOND, 4)
    return result


# ----------------------------------------------------------------- yerel tarafı
def _save(name: str, data: dict):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def _summary(result: dict):
    print(f"\n== {result['key']}  (model yükleme {result['timing']['model_load_s']} sn, "
          f"toplam {result['timing']['total_s']} sn, ~${result['timing']['est_dollars_total']})")
    for input_name, info in result["inputs"].items():
        if "skipped" in info:
            print(f"  [{input_name}] atlandı: {info['skipped']}")
            continue
        det = info.get("language_detect", {})
        print(f"  [{input_name}] süre {info['duration_s']} sn, RMS {info['rms_dbfs']} dBFS, "
              f"dil algılama: {det.get('winner', det.get('error'))} {det.get('votes', '')}")
        for variant, entry in info["variants"].items():
            if "error" in entry:
                print(f"    {variant:12s} HATA: {entry['error']}")
                continue
            for label, key in (("", "metrics"), ("+maske", "metrics_masked")):
                m = entry[key]
                print(f"    {variant + label:18s} {entry['seconds']:6.1f} sn ({entry['speed_x_realtime']}x) "
                      f"satır {m['lines']:3d} kelime {m['words']:4d}  sessizde {m['lines_in_silence']:2d}  "
                      f"başlangıç hatası med {m['onset_err_median_s']} p90 {m['onset_err_p90_s']} "
                      f"(+{m['onset_signed_median_s']}) n={m['onset_pairs']}")


@app.local_entrypoint()
def fetch():
    print(fetch_run.remote())


@app.local_entrypoint()
def run(songs: str = "zeus", variants: str = ",".join(VARIANTS), inputs: str = "vocals,lead"):
    for key in [s.strip() for s in songs.split(",") if s.strip()]:
        wanted_inputs = ["vocals"] if key == "finalduet" else inputs.split(",")
        wanted_variants = ["raw", "guard"] if key == "finalduet" else variants.split(",")
        # faster-whisper ve stable-ts AYRI konteynerde: aynı T4'te iki model + ct2 önbelleği OOM veriyor
        groups = [[v for v in wanted_variants if not v.startswith("stable")],
                  [v for v in wanted_variants if v.startswith("stable")]]
        merged = None
        for group in groups:
            if not group:
                continue
            result = transcribe_song.remote(key, group, wanted_inputs)
            if merged is None:
                merged = result
            else:
                for input_name, info in result["inputs"].items():
                    if "variants" in info and "variants" in merged["inputs"].get(input_name, {}):
                        merged["inputs"][input_name]["variants"].update(info["variants"])
                merged["timing"]["total_s"] = round(merged["timing"]["total_s"] + result["timing"]["total_s"], 1)
                merged["timing"]["est_dollars_total"] = round(
                    merged["timing"]["est_dollars_total"] + result["timing"]["est_dollars_total"], 4)
        _save(f"{key}__auto.json", merged)
        _summary(merged)


@app.local_entrypoint()
def align(songs: str = "zeus", inputs: str = "vocals", ref: str = ""):
    for key in [s.strip() for s in songs.split(",") if s.strip()]:
        ref_path = REF_DIR / (ref or SONGS[key][2] or "")
        if not ref_path.is_file():
            print(f"{key}: referans yok ({ref_path.name}), atlandı")
            continue
        text = "\n".join(l.strip() for l in ref_path.read_text(encoding="utf-8").splitlines() if l.strip())
        result = align_song.remote(key, text, inputs.split(","))
        _save(f"{key}__align{'_x_' + ref_path.stem if ref else ''}.json", result)
        print(f"\n== {key} hizalama ({result.get('align_backend')}): "
              f"toplam {result['timing']['total_s']} sn ~${result['timing']['est_dollars_total']}")
        for input_name, entry in result["inputs"].items():
            for tag, sub in entry.items() if "skipped" not in entry else []:
                if "error" in sub:
                    print(f"  [{input_name}/{tag}] HATA: {sub['error']}")
                else:
                    m = sub["metrics"]
                    print(f"  [{input_name}/{tag}] ORAN sessiz {m['silent_line_ratio']} olasilik {m['mean_word_prob']} "
                          f"{sub['seconds']} sn satır {m['lines']} kelime {m['words']} "
                          f"sessizde {m['lines_in_silence']} başlangıç med {m['onset_err_median_s']} "
                          f"p90 {m['onset_err_p90_s']} n={m['onset_pairs']}")


# ----------------------------------------------------------------- WER / CER (yerel)
def _normalize(text: str, language: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    if language == "tr":
        text = text.replace("I", "ı").replace("İ", "i")
    text = text.lower()
    out = []
    for ch in text:
        category = unicodedata.category(ch)
        if category[0] in "LN" or ch.isspace():
            out.append(ch)
        elif category[0] in "MS" and category == "Mn":
            out.append(ch)          # birleşik işaret (ör. Japonca dakuten) korunur
    return " ".join("".join(out).split())


def _edit_distance(a: list, b: list) -> int:
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        current = [i]
        for j, y in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x != y)))
        previous = current
    return previous[-1]


def _error_rate(reference: str, hypothesis: str, language: str):
    ref, hyp = _normalize(reference, language), _normalize(hypothesis, language)
    if language == "ja":                       # boşluksuz yazı: karakter hata oranı
        r, h = list(ref.replace(" ", "")), list(hyp.replace(" ", ""))
        name = "CER"
    else:
        r, h = ref.split(), hyp.split()
        name = "WER"
    return name, round(_edit_distance(r, h) / max(len(r), 1), 3), len(r)


def score():
    """Yerel: lyrics_out/*.json'ı lyrics_ref/*.txt ile karşılaştırır. Metin yazmaz."""
    for key, (_, language, ref_name) in SONGS.items():
        if not ref_name:
            continue
        ref_path = REF_DIR / ref_name
        if not ref_path.is_file():
            continue
        reference = ref_path.read_text(encoding="utf-8")
        ref_lines = [l for l in reference.splitlines() if l.strip()]
        for kind in ("auto", "align"):
            path = OUT_DIR / f"{key}__{kind}.json"
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            print(f"\n== {key} {kind}: referans {len(ref_lines)} satır")
            for input_name, info in data["inputs"].items():
                if "skipped" in info:
                    continue
                if kind == "auto":
                    cases = [(v, e.get("lines"), e.get("lines_masked")) for v, e in info["variants"].items()
                             if "lines" in e]
                    for variant, lines, masked in cases:
                        for label, chosen in (("", lines), ("+maske", masked)):
                            name, rate, n = _error_rate(reference, " ".join(l["text"] for l in chosen), language)
                            print(f"  [{input_name}] {variant + label:18s} {name} {rate:.3f} "
                                  f"(ref {n}) satır {len(chosen)}")
                else:
                    for tag, sub in info.items():
                        if "lines" in sub:
                            print(f"  [{input_name}] hizalama/{tag}: satır {len(sub['lines'])} "
                                  f"(ref {len(ref_lines)}) sessizde {sub['metrics']['lines_in_silence']}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "score":
        score()
    else:
        print(__doc__)
