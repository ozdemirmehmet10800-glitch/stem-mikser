"""Stem Mikser - Modal uygulaması.

Aşama 1: htdemucs_6s ile 6 kanallı ayrıştırma.

Yerel test:
    modal run backend/app.py --path sarki.mp3

Önemli: torch/numpy/soundfile gibi paketler YEREL ortamda kurulu değil.
Bu yüzden ağır importlar yalnızca uzak fonksiyonların içinde yapılır ve
uzak fonksiyonlar yerel entrypoint'e sadece düz Python tipleri döndürür
(PLAN.md kuralı).
"""

import hashlib
import json
import os
import pathlib
import subprocess
import time

import modal

APP_NAME = "stem-mikser"
VOLUME_NAME = "stems-vol"
DATA_DIR = "/data"
WEIGHTS_DIR = "/weights"
MODEL_NAME = "htdemucs_6s"

MAX_UPLOAD_BYTES = 30 * 1024 * 1024  # 30 MB
MAX_DURATION_SEC = 10 * 60  # 10 dakika

AAC_BITRATE = "160k"
FLAC_SUBTYPE = "PCM_24"  # 24-bit kayıpsız master

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

# --------------------------------------------------------------------------
# Düz tip bekçisi (PLAN.md: uzak fonksiyonlar torch/numpy nesnesi döndürmez)
#
# Not: bu yardımcı backend/smoke.py'de de var. Ortak bir modüle almak yerine
# kopyaladım; her dosya kendi başına calışabilsin ve imaja ek kaynak dosyası
# dahil etme ihtiyacı doğmasın.
# --------------------------------------------------------------------------
SCALAR_TYPES = (str, int, float, bool, type(None))


def _assert_plain(value, path: str = "return"):
    """Değerin (ve içindeki her şeyin) düz Python tipi olduğunu doğrular.

    bool int'in, TorchVersion ise str'in alt sınıfı olduğu için isinstance
    yetmez; tipin TAM olarak izinli olmasını istiyoruz.
    """
    kind = type(value)
    if kind is dict:
        for key, item in value.items():
            _assert_plain(key, f"{path}[key]")
            _assert_plain(item, f"{path}[{key!r}]")
    elif kind in (list, tuple):
        for i, item in enumerate(value):
            _assert_plain(item, f"{path}[{i}]")
    elif kind not in SCALAR_TYPES:
        raise TypeError(f"{path} duz tip degil: {kind.__module__}.{kind.__name__}")
    return value


# --------------------------------------------------------------------------
# İmajlar
# --------------------------------------------------------------------------

# Hafif imaj: ffmpeg/ffprobe var, torch YOK. Süre/etiket sorgulama ve durum
# okuma gibi CPU işleri burada koşar (Aşama 3'teki API de bunu kullanacak).
light_image = modal.Image.debian_slim(python_version="3.11").apt_install("ffmpeg")


def _warm_weights():
    """Build aşaması: htdemucs_6s ağırlıklarını imaja gömer ve doğrular."""
    import importlib.util

    # torchaudio'ya gizli bir bağımlılık varsa build'de patlasın, çalışma
    # anında değil (PLAN.md: torchaudio I/O kullanmıyoruz, kurulu da değil).
    if importlib.util.find_spec("torchaudio") is not None:
        raise RuntimeError("torchaudio imaja sizmis; ses I/O icin istenmiyor")

    from demucs.pretrained import get_model

    model = get_model(MODEL_NAME)
    print(f"model: {MODEL_NAME}")
    print(f"sources: {list(model.sources)}")
    print(f"samplerate: {model.samplerate}  audio_channels: {model.audio_channels}")

    # Ağırlıklar gerçekten /weights altına indi mi?
    found = []
    for root, _dirs, files in os.walk(WEIGHTS_DIR):
        for name in files:
            full = os.path.join(root, name)
            size = os.path.getsize(full)
            if size > 1024 * 1024:
                found.append((full, size))

    for full, size in sorted(found, key=lambda item: -item[1]):
        print(f"  {size / 1024**2:8.1f} MB  {full}")

    total = sum(size for _full, size in found)
    if total < 50 * 1024**2:
        raise RuntimeError(
            f"{WEIGHTS_DIR} altinda checkpoint bulunamadi "
            f"(1 MB ustu {len(found)} dosya, toplam {total} bayt). "
            "HF_HOME/TORCH_HOME ayarlari build'de gecerli olmayabilir."
        )
    print(f"toplam agirlik: {total / 1024**2:.1f} MB")


separate_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        # demucs 4.1.0 torch>=2.1 istiyor (Linux'ta üst sınır yok). torch 2.6'da
        # torch.load varsayılanı weights_only=True oldu; demucs'un checkpoint
        # yükleyicisini kırabilir. 2.5.1 bu değişiklikten önce.
        "torch==2.5.1",
        "numpy==1.26.4",
        "demucs==4.1.0",
        "soundfile==0.13.1",
        # torchaudio BİLEREK kurulmuyor: demucs 4.1.0'da yalnızca "train"
        # extra'sının bağımlılığı, inference için gerekmiyor.
    )
    # Ağırlıklar build'de bu iki yola inecek ve imaja gömülecek.
    .env({"HF_HOME": WEIGHTS_DIR, "TORCH_HOME": WEIGHTS_DIR})
    .run_function(_warm_weights)
    # Build'den SONRA offline'a al: soğuk başlangıçta sessizce yeniden indirme
    # olursa gürültüsüzce yavaşlamak yerine hata versin.
    .env({"HF_HUB_OFFLINE": "1"})
)

app = modal.App(APP_NAME)


# --------------------------------------------------------------------------
# Volume yardımcıları (konteyner içinde çalışır)
# --------------------------------------------------------------------------


def _song_dir(song_id: str) -> pathlib.Path:
    return pathlib.Path(DATA_DIR) / "songs" / song_id


def _read_status(song_id: str):
    volume.reload()
    path = _song_dir(song_id) / "status.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_status(song_id: str, **fields) -> dict:
    """status.json'ı günceller ve volume'a commit eder."""
    path = _song_dir(song_id) / "status.json"
    status = {}
    if path.exists():
        status = json.loads(path.read_text(encoding="utf-8"))
    status.update(fields)
    status["id"] = song_id
    status["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    status.setdefault("created_at", status["updated_at"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    volume.commit()
    return status


def _find_input(song_id: str) -> pathlib.Path:
    matches = sorted(_song_dir(song_id).glob("input.*"))
    if not matches:
        raise FileNotFoundError(f"{song_id}: input dosyasi yok")
    return matches[0]


def _run(cmd: list) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace") if proc.stderr else ""
        raise RuntimeError(f"{cmd[0]} basarisiz (kod {proc.returncode}): {err[-2000:]}")
    return proc


# --------------------------------------------------------------------------
# CPU fonksiyonları (hafif imaj, torch yok)
# --------------------------------------------------------------------------


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=120)
def probe(song_id: str, fallback_title: str = "") -> dict:
    """ffprobe ile süre/etiket okur, status.json'ı hazırlar.

    30 MB / 10 dk kapısı burada, GPU'ya girmeden CPU tarafında kapanır.
    """
    volume.reload()
    path = _find_input(song_id)
    size = path.stat().st_size

    proc = _run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration:format_tags=title,artist",
            "-of", "json", str(path),
        ]
    )
    meta = json.loads(proc.stdout.decode("utf-8", "replace"))
    fmt = meta.get("format") or {}
    tags = fmt.get("tags") or {}

    raw_duration = fmt.get("duration")
    duration = None if raw_duration is None else round(float(raw_duration), 3)

    title = str(tags.get("title") or fallback_title or song_id[:12])
    artist = tags.get("artist")
    if artist:
        title = f"{artist} - {title}"

    def reject(message: str) -> dict:
        return _assert_plain(
            _write_status(
                song_id, state="error", progress=0, title=title,
                duration=duration, error=message, size_bytes=int(size),
            )
        )

    if size > MAX_UPLOAD_BYTES:
        return reject(
            f"Dosya cok buyuk: {size / 1024**2:.1f} MB "
            f"(sinir {MAX_UPLOAD_BYTES // 1024**2} MB)"
        )

    if duration is None:
        return reject("Ses suresi okunamadi; dosya bozuk veya desteklenmeyen bicimde.")

    if duration > MAX_DURATION_SEC:
        return reject(
            f"Sarki cok uzun: {duration / 60:.1f} dakika "
            f"(sinir {MAX_DURATION_SEC // 60} dakika)"
        )

    return _assert_plain(
        _write_status(
            song_id, state="queued", progress=0, title=title,
            duration=duration, error=None, size_bytes=int(size),
        )
    )


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=60)
def get_status(song_id: str):
    return _assert_plain(_read_status(song_id))


# --------------------------------------------------------------------------
# GPU: ayrıştırma
# --------------------------------------------------------------------------


@app.function(
    image=separate_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=900,
    max_containers=1,  # min_containers YOK: boştayken maliyet sıfır
)
def separate(song_id: str) -> dict:
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    started = time.time()
    volume.reload()
    song_dir = _song_dir(song_id)
    input_path = _find_input(song_id)

    try:
        _write_status(song_id, state="separating", progress=5, error=None)

        # --- model (ağırlıklar imajda gömülü olmalı) ----------------------
        load_started = time.time()
        model = get_model(MODEL_NAME)
        model.eval()
        model_load_seconds = round(time.time() - load_started, 2)

        weights_files = sorted(
            os.path.join(root, name)
            for root, _dirs, files in os.walk(WEIGHTS_DIR)
            for name in files
            if os.path.getsize(os.path.join(root, name)) > 1024 * 1024
        )
        print(f"[soguk-baslangic] model {model_load_seconds} sn'de yuklendi")
        print(f"[soguk-baslangic] /weights checkpointleri: {weights_files}")
        print("[soguk-baslangic] yukarida indirme/progress cubugu YOKSA agirliklar imajdan geldi")

        # Örnekleme hızı ve kanal sayısı modelden okunur, elle yazılmaz.
        samplerate = int(model.samplerate)
        channels = int(model.audio_channels)
        sources = [str(name) for name in model.sources]
        print(f"[model] sources={sources} samplerate={samplerate} channels={channels}")

        # --- decode: ffmpeg -> float32 PCM (torchaudio I/O YOK) -----------
        proc = _run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-i", str(input_path),
                "-f", "f32le", "-acodec", "pcm_f32le",
                "-ar", str(samplerate), "-ac", str(channels), "-",
            ]
        )
        audio = np.frombuffer(proc.stdout, dtype="<f4").reshape(-1, channels).T.copy()
        wav = torch.from_numpy(audio)
        duration = round(wav.shape[1] / samplerate, 3)
        print(f"[decode] {tuple(wav.shape)} -> {duration} sn")

        # Yedek kapı: asıl kontrol probe()'da, CPU tarafında yapıldı.
        if duration > MAX_DURATION_SEC:
            raise ValueError(
                f"Sarki cok uzun: {duration / 60:.1f} dakika "
                f"(sinir {MAX_DURATION_SEC // 60} dakika)"
            )

        _write_status(song_id, state="separating", progress=20, duration=duration)

        # --- normalizasyon (demucs CLI ile aynı) --------------------------
        ref = wav.mean(0)
        ref_mean = ref.mean()
        ref_std = ref.std()
        if float(ref_std) < 1e-8:  # tamamen sessiz girdi
            raise ValueError("Ses neredeyse tamamen sessiz; ayristirilacak sinyal yok.")
        wav_norm = (wav - ref_mean) / ref_std

        # --- ayrıştırma ---------------------------------------------------
        apply_started = time.time()
        with torch.no_grad():
            out = apply_model(
                model, wav_norm[None], device="cuda",
                shifts=1, split=True, overlap=0.25, progress=False,
            )
        stems = out[0].cpu()
        gpu_seconds = round(time.time() - apply_started, 2)
        print(f"[apply_model] {gpu_seconds} sn")

        # normalizasyonu geri al
        stems = stems * ref_std + ref_mean

        _write_status(song_id, state="separating", progress=80)

        # --- yazma: FLAC master (24-bit) + AAC m4a ------------------------
        master_dir = song_dir / "master"
        stems_dir = song_dir / "stems"
        master_dir.mkdir(parents=True, exist_ok=True)
        stems_dir.mkdir(parents=True, exist_ok=True)

        # Clip koruması (demucs CLI'nin clip="rescale" davranışı), ama stem
        # başına DEĞİL: tüm kanallara ORTAK tek bir scale uygulanır. Mikserde 6
        # stem üst üste çalınacağı için aralarındaki oran korunmak zorunda;
        # kanalları ayrı ayrı ölçeklemek dengeyi bozar.
        raw_peaks = {
            name: float(stems[index].abs().max())
            for index, name in enumerate(sources)
        }
        clip_peak = max(raw_peaks.values())
        clip_scale = max(1.01 * clip_peak, 1.0)
        peaks = {name: round(value, 4) for name, value in raw_peaks.items()}
        print(f"[clip] tepeler={peaks}")
        print(f"[clip] ortak tepe={clip_peak:.4f} -> ortak scale={clip_scale:.4f}")

        written = []
        for index, name in enumerate(sources):
            stem = stems[index] / clip_scale

            flac_path = master_dir / f"{name}.flac"
            sf.write(
                str(flac_path), stem.T.numpy(), samplerate,
                subtype=FLAC_SUBTYPE, format="FLAC",
            )

            m4a_path = stems_dir / f"{name}.m4a"
            _run(
                [
                    "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(flac_path),
                    "-c:a", "aac", "-b:a", AAC_BITRATE,
                    "-ar", str(samplerate), "-ac", str(channels),
                    "-movflags", "+faststart", str(m4a_path),
                ]
            )
            written.append(name)
            print(f"[yaz] {name}: tepe {raw_peaks[name]:.4f} -> flac + m4a")
            _write_status(
                song_id, progress=80 + int(20 * len(written) / len(sources))
            )

        result = {
            "id": song_id,
            "stems": written,
            "peaks": peaks,  # stem başına ölçülen tepe (ölçekleme öncesi)
            "clip_peak": round(clip_peak, 4),  # bunların maksimumu
            "clip_scale": round(clip_scale, 4),  # hepsine uygulanan ortak bölen
            "samplerate": samplerate,
            "channels": channels,
            "duration": duration,
            "gpu_seconds": gpu_seconds,
            "model_load_seconds": model_load_seconds,
            "total_seconds": round(time.time() - started, 2),
        }
        _write_status(
            song_id, progress=100, error=None, stems=written,
            samplerate=samplerate, channels=channels, gpu_seconds=gpu_seconds,
        )
        # Aşama 2 (analiz) gelene kadar ayrıştırma son adım; durumu done'a
        # çekiyoruz. Aşama 2'de burası "analyzing" olup analyze tetiklenecek.
        _write_status(song_id, state="done")
        return _assert_plain(result)

    except Exception as exc:
        _write_status(song_id, state="error", error=f"{type(exc).__name__}: {exc}")
        raise


# --------------------------------------------------------------------------
# Yerel entrypoint
# --------------------------------------------------------------------------


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@app.local_entrypoint()
def main(path: str, out: str = "out", force: bool = False, masters: bool = True):
    """modal run backend/app.py --path sarki.mp3

    --no-masters ile FLAC master'lar indirilmez (6 kanal ~200 MB eder);
    yalnızca oynatma m4a'ları iner.
    """
    src = pathlib.Path(path).expanduser()
    if not src.is_file():
        raise SystemExit(f"Dosya bulunamadi: {src}")

    size = src.stat().st_size
    print(f"dosya: {src.name}  ({size / 1024**2:.2f} MB)")
    if size > MAX_UPLOAD_BYTES:
        raise SystemExit(
            f"Dosya cok buyuk: {size / 1024**2:.1f} MB "
            f"(sinir {MAX_UPLOAD_BYTES // 1024**2} MB). GPU'ya hic girilmedi."
        )

    song_id = _sha256(src)
    print(f"sha256: {song_id}")

    existing = get_status.remote(song_id)
    if existing and existing.get("state") == "done" and not force:
        print("bu dosya zaten islenmis (durum: done). Yeniden islemek icin --force.")
    else:
        ext = src.suffix.lower().lstrip(".") or "bin"
        remote_input = f"songs/{song_id}/input.{ext}"
        print(f"yukleniyor -> {remote_input}")
        with volume.batch_upload(force=True) as batch:
            batch.put_file(str(src), remote_input)

        print("ffprobe (CPU, GPU'ya girmeden)...")
        status = probe.remote(song_id, src.stem)
        print(f"  baslik: {status.get('title')}  sure: {status.get('duration')} sn")
        if status.get("state") == "error":
            raise SystemExit(f"Reddedildi: {status.get('error')}")

        print("ayristirma (T4)...")
        result = separate.remote(song_id)
        print("\n===== sonuc =====")
        for key, value in result.items():
            print(f"{key}: {value}")

    # --- stem'leri PC'ye indir ---
    dest_root = pathlib.Path(out) / song_id
    prefixes = ("stems", "master") if masters else ("stems",)
    print(f"\nindiriliyor -> {dest_root}  ({', '.join(prefixes)})")
    for prefix in prefixes:
        for entry in volume.listdir(f"songs/{song_id}/{prefix}"):
            dest = dest_root / prefix / pathlib.PurePosixPath(entry.path).name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as handle:
                for chunk in volume.read_file(entry.path):
                    handle.write(chunk)
            print(f"  {dest}  ({dest.stat().st_size / 1024**2:.2f} MB)")

    print("\nBitti.")
