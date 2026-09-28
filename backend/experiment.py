"""Aşama 9 DENEYİ - Hi-Fi ayrıştırma adaylarının ölçümü.

AYRI bir Modal uygulaması. `backend/app.py` hiç değişmiyor, canlı endpoint'e
dokunulmuyor. Aynı Volume kullanılıyor, çünkü sonuçlar kitaplıkta ayrı şarkı
olarak görünsün isteniyor - API'nin /songs ucu zaten `status.json` içeren her
klasörü listeliyor, yani ek bir uç gerekmiyor.

Adaylar:
  A     Mel-Band Roformer ile vokal -> enstrümantal = karışım - vokal ->
        enstrümantal htdemucs_6s'e veriliyor. Demucs'un kendi vokal çıkışı
        (enstrümantalde kalan artık) "other"a EKLENİYOR, atılmıyor: stem
        toplamı orijinal karışıma eşit kalsın diye.
  B     BS-Roformer SW, tek model, 6 stem. num_overlap 2 (config varsayılanı).
  B-max Aynı model, num_overlap 8 + test-time augmentation (3 geçiş).

Çalıştırma:
    modal run backend/experiment.py::fetch          # ağırlıkları indir
    modal run backend/experiment.py                 # deneyi koştur


LİSANS DURUMU (2026-09-28'de kontrol edildi)
--------------------------------------------
A ağırlıkları - KimberleyJSN/melbandroformer, HF commit
  ac9b0614ab3cd7f77219e18ba494dfd93956c348, metadata `license: mit`.
  GEÇMİŞ: bu depo bir dönem gpl-3.0 gösteriyordu (Intel'in talebiyle
  eklenmişti; Intel/vocals_mel_band_roformer_kimberleyJSN_openvino hâlâ
  gpl-3.0 diyor). Yazar sonradan MIT'e çevirmiş. GÜNCEL metadata esas
  alındı: MIT. Depo public olduğu için GPL kabul edilemezdi.

A mimarisi - ZFTurbo/Music-Source-Separation-Training, MIT, gerçek LICENSE
  dosyası var. Commit 84b1eac0887756b4f1a9d7a1ff49105939749ed2'ye PİNLİ.
  KimberleyJensen/Mel-Band-Roformer-Vocal-Model deposu KULLANILMIYOR:
  hiçbir lisans dosyası yok, yani varsayılan olarak her hakkı saklı.

B ağırlıkları - LİSANSSIZ. Orijinal sahibi (jarredou) HF hesabını silmiş.
  İki ayna var ve sha256'ları BİREBİR AYNI, yani ikisi de orijinal dosya:
    enerjazzer/BS-ROFO-SW-Fixed      -> license: unknown  (dürüst olan)
    Blakus/bs_roformer_sw_6stem      -> license: mit      (üçüncü kişi
      yeniden yüklerken yazmış; sahip olmadığı bir hakkı veremez)
  Deney için indirilip çalıştırılıyor, YENİDEN DAĞITILMIYOR. Canlıya alma
  kararı ayrı: lisans netleşmeden B entegre EDİLEMEZ.
"""

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time

import modal

APP_NAME = "stem-mikser-deney"
VOLUME_NAME = "stems-vol"        # canlı sistemle AYNI volume
DATA_DIR = "/data"
EXP_WEIGHTS = "/data/weights-exp"  # ağırlıklar imaja gömülmüyor, volume'da
DEMUCS_WEIGHTS = "/weights"        # htdemucs_6s imaja gömülü (canlıdaki gibi)

MODEL_NAME = "htdemucs_6s"
AAC_BITRATE = "160k"          # app.py ile aynı olmalı: oynatıcı aynı
FLAC_SUBTYPE = "PCM_24"
T4_USD_PER_SECOND = 0.000164  # ölçümü paraya çevirmek için

# MSST (MIT) mimari dosyaları - PİNLİ commit.
MSST_SHA = "84b1eac0887756b4f1a9d7a1ff49105939749ed2"
MSST_RAW = f"https://raw.githubusercontent.com/ZFTurbo/Music-Source-Separation-Training/{MSST_SHA}"
MSST_FILES = ("attend.py", "bs_roformer.py", "mel_band_roformer.py")

# İndirilecek ağırlıklar. sha256'lar HF API'sinden alındı (LFS meta verisi),
# koda GÖMÜLÜ: indirilen dosya bunlarla tutmuyorsa hata veriyoruz.
WEIGHTS = {
    "a_ckpt": {
        "url": "https://huggingface.co/KimberleyJSN/melbandroformer/resolve/"
               f"ac9b0614ab3cd7f77219e18ba494dfd93956c348/MelBandRoformer.ckpt",
        "name": "melband_vocals.ckpt",
        "size": 913106900,
        "sha256": "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e",
    },
    "b_ckpt": {
        "url": "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/"
               f"a443a2985534b3bc815ef54a5d446c6a0390f974/BS-Rofo-SW-Fixed.ckpt",
        "name": "bs_roformer_sw.ckpt",
        "size": 699412152,
        "sha256": "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e",
    },
    "b_yaml": {
        "url": "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/"
               f"a443a2985534b3bc815ef54a5d446c6a0390f974/BS-Rofo-SW-Fixed.yaml",
        "name": "bs_roformer_sw.yaml",
        "size": None,     # LFS değil, HF sha256 vermiyor; ölçüp rapora yazıyoruz
        "sha256": None,
    },
    "a_yaml": {
        # A'nın konfigi MIT depodan: KimberleyJensen'in lisanssız deposundan
        # değil. Checkpoint'le uyumlu olan bu (dim 384, depth 6).
        "url": f"{MSST_RAW}/configs/KimberleyJensen/config_vocals_mel_band_roformer_kj.yaml",
        "name": "melband_vocals.yaml",
        "size": None,
        "sha256": None,
    },
}

# İkinci ayna: aynı dosya mı, sha256 ile doğrulanıyor.
B_MIRROR_ALT = "https://huggingface.co/Blakus/bs_roformer_sw_6stem/resolve/main/BS-Rofo-SW-Fixed.ckpt"

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
app = modal.App(APP_NAME)

# İndirme imajı: GPU yok, torch yok. Sadece ağ + hash.
fetch_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "requests==2.32.3"
)


def _sha256(path: pathlib.Path, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _download(url: str, target: pathlib.Path) -> int:
    import requests

    target.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with requests.get(url, stream=True, timeout=600) as response:
        response.raise_for_status()
        with target.open("wb") as handle:
            for block in response.iter_content(chunk_size=1024 * 1024):
                handle.write(block)
                total += len(block)
    return total


@app.function(
    image=fetch_image,
    volumes={DATA_DIR: volume},
    timeout=3600,
)
def fetch_weights(check_mirror: bool = True) -> dict:
    """Ağırlıkları Volume'a indirir ve sha256 doğrular.

    İmaja GÖMMÜYORUZ: 1.6 GB'ı imaja koymak her kod değişikliğinde yeniden
    build demek, deneyde hızlı yineleme istiyoruz. Bedeli soğuk başlangıçta
    Volume'dan okuma - o da ölçtüğümüz şeylerden biri.
    """
    volume.reload()
    root = pathlib.Path(EXP_WEIGHTS)
    root.mkdir(parents=True, exist_ok=True)
    report = {}

    for key, item in WEIGHTS.items():
        target = root / item["name"]
        if target.exists() and item["sha256"]:
            existing = _sha256(target)
            if existing == item["sha256"]:
                print(f"[atla] {item['name']} zaten var ve sha256 tutuyor")
                report[key] = {"bytes": target.stat().st_size, "sha256": existing,
                               "downloaded": False}
                continue
            print(f"[yeniden] {item['name']} sha256 tutmuyor, tekrar iniyor")

        started = time.time()
        size = _download(item["url"], target)
        digest = _sha256(target)
        seconds = round(time.time() - started, 1)
        print(f"[indi] {item['name']}: {size} bayt, {seconds} sn, sha256={digest}")

        if item["sha256"] and digest != item["sha256"]:
            target.unlink(missing_ok=True)
            raise ValueError(
                f"{item['name']} sha256 UYUSMUYOR!\n"
                f"  beklenen: {item['sha256']}\n"
                f"  gelen   : {digest}"
            )
        if item["size"] and size != item["size"]:
            raise ValueError(f"{item['name']} boyutu beklenenden farkli: {size}")
        report[key] = {"bytes": int(size), "sha256": digest, "downloaded": True,
                       "seconds": seconds}

    # İkinci aynanın AYNI dosya olduğunu kanıtla. jarredou'nun hesabı silinmiş;
    # iki bağımsız aynanın aynı hash'i vermesi dosyanın orijinal olduğunu
    # gösteren elimizdeki tek kanıt.
    if check_mirror:
        alt = root / "_mirror_check.ckpt"
        try:
            _download(B_MIRROR_ALT, alt)
            alt_digest = _sha256(alt)
            same = alt_digest == WEIGHTS["b_ckpt"]["sha256"]
            print(f"[ayna] Blakus kopyasi sha256={alt_digest} -> "
                  f"{'AYNI DOSYA' if same else 'FARKLI!'}")
            report["b_mirror"] = {"sha256": alt_digest, "identical": bool(same)}
        finally:
            alt.unlink(missing_ok=True)

    # MSST mimari dosyaları da volume'a: imaj build'i ağa bağımlı olmasın.
    models_dir = root / "msst" / "models" / "bs_roformer"
    models_dir.mkdir(parents=True, exist_ok=True)
    (root / "msst" / "models" / "__init__.py").write_text("", encoding="utf-8")
    # ZFTurbo'nun __init__.py'si conformer'ları da import ediyor; bize gerekmiyor.
    (models_dir / "__init__.py").write_text("", encoding="utf-8")
    for name in MSST_FILES:
        size = _download(f"{MSST_RAW}/models/bs_roformer/{name}", models_dir / name)
        print(f"[msst] {name}: {size} bayt")
    report["msst_commit"] = MSST_SHA

    volume.commit()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report

# --------------------------------------------------------------------------
# htdemucs_6s ağırlığı imaja gömülüyor (A yolunun ikinci aşaması).
# Roformer ağırlıkları volume'da; bu küçük ve canlı imajla aynı davranmalı.
# --------------------------------------------------------------------------

def _warm_demucs():
    from demucs.pretrained import get_model

    model = get_model(MODEL_NAME)
    print(f"[build] {MODEL_NAME} indirildi, kaynaklar={list(model.sources)}")

# --------------------------------------------------------------------------
# GPU imajı
# --------------------------------------------------------------------------
# Sürümler canlı separate_image ile AYNI tutuldu: aynı torch/demucs/numpy
# ikilisi, böylece ölçülen fark modelden geliyor, ortamdan değil.
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.5.1",
        "numpy==1.26.4",
        "demucs==4.1.0",       # A yolunun ikinci aşaması
        "soundfile==0.13.1",
    )
    .pip_install(
        "einops==0.8.2",
        "rotary-embedding-torch==0.9.1",
        "beartype==0.19.0",    # MSST model dosyaları isteğe bağlı değil, import ediyor
        "librosa==0.11.0",     # yalnız mel filtre bankası için (filters)
        "PyYAML==6.0.2",
    )
    .env({"HF_HOME": DEMUCS_WEIGHTS, "TORCH_HOME": DEMUCS_WEIGHTS})
    .run_function(_warm_demucs)
    .env({"HF_HUB_OFFLINE": "1"})
)

# Konteyner ne zaman ayağa kalktı? Soğuk başlangıcı ölçmek için.
_CONTAINER_START = time.time()
_FIRST_CALL = True


# --------------------------------------------------------------------------
# yardımcılar
# --------------------------------------------------------------------------

def _run(cmd: list) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} basarisiz ({result.returncode}): "
            f"{result.stderr.decode('utf-8', 'replace')[:800]}"
        )
    return result


def _song_dir(song_id: str) -> pathlib.Path:
    return pathlib.Path(DATA_DIR) / "songs" / song_id


def _find_input(song_id: str) -> pathlib.Path:
    matches = sorted(_song_dir(song_id).glob("input.*"))
    if not matches:
        raise FileNotFoundError(f"{song_id}: input dosyasi yok")
    return matches[0]


def _msst_path() -> str:
    """MSST model dosyaları volume'da; import edilebilmesi için sys.path'e."""
    return str(pathlib.Path(EXP_WEIGHTS) / "msst")


def _load_config(path: pathlib.Path) -> dict:
    """YAML'i GÜVENLİ yükler.

    Konfigler `!!python/tuple` etiketi kullanıyor; `yaml.unsafe_load` bunu
    çözer ama rastgele kod çalıştırmaya da açar. B'nin konfigi lisansı
    belirsiz bir aynadan geliyor, o yüzden SafeLoader'a yalnızca tuple
    kurucusunu ekliyoruz.
    """
    import yaml

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_constructor(
        "tag:yaml.org,2002:python/tuple",
        lambda loader, node: tuple(loader.construct_sequence(node)),
    )
    with path.open("r", encoding="utf-8") as handle:
        return yaml.load(handle, Loader=Loader)


def _build_model(kind: str, config: dict):
    """kind: 'melband' (A, tek stem vokal) | 'bs' (B, 6 stem)."""
    import sys

    if _msst_path() not in sys.path:
        sys.path.insert(0, _msst_path())

    params = dict(config["model"])
    if kind == "melband":
        from models.bs_roformer.mel_band_roformer import MelBandRoformer

        return MelBandRoformer(**params)
    from models.bs_roformer.bs_roformer import BSRoformer

    return BSRoformer(**params)


def _load_checkpoint(model, path: pathlib.Path, device: str):
    import torch

    state = torch.load(str(path), map_location="cpu", weights_only=False)
    if isinstance(state, dict):
        for key in ("state_dict", "model", "model_state_dict"):
            if key in state and isinstance(state[key], dict):
                state = state[key]
                break
    # Bazı checkpoint'ler "module." önekiyle kaydedilmiş oluyor.
    if any(name.startswith("module.") for name in state):
        state = {name.removeprefix("module."): value for name, value in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        print(f"[ckpt] eksik={len(missing)} fazla={len(unexpected)}")
        if missing[:3]:
            print(f"[ckpt] ilk eksikler: {missing[:3]}")
    model.to(device)
    model.eval()
    return model


def _windowing_array(window_size: int, fade_size: int, device):
    """MSST'nin _getWindowingArray'i (MIT): doğrusal fade-in/out, ortası 1."""
    import torch

    window = torch.ones(window_size, device=device)
    window[:fade_size] = torch.linspace(0.0, 1.0, fade_size, device=device)
    window[-fade_size:] = torch.linspace(1.0, 0.0, fade_size, device=device)
    return window


def _demix(model, mix, config: dict, num_overlap: int, use_fp16: bool,
           device: str = "cuda"):
    """Örtüşmeli parça parça çıkarım.

    MSST'nin demix()'inin (MIT) 'generic' dalıyla aynı: kenar bozulmasını
    önlemek için reflect dolgu, parça başına fade'li pencere (ilk parçada
    fade-in, son parçada fade-out yok), ağırlıklı toplam / sayaç.

    Kendimiz yazdık çünkü num_overlap deneyin ASIL KOLU ([B-max]) ve MSST'nin
    utils/model_utils.py'si çok daha fazla bağımlılık çekiyor.
    """
    import numpy as np
    import torch
    from torch.nn import functional as F

    chunk_size = int(config["audio"]["chunk_size"])
    batch_size = int(config.get("inference", {}).get("batch_size", 1))
    fade_size = chunk_size // 10
    step = chunk_size // num_overlap
    border = chunk_size - step

    mix = torch.as_tensor(mix, dtype=torch.float32, device=device)
    length_init = mix.shape[-1]
    if length_init > 2 * border and border > 0:
        mix = F.pad(mix, (border, border), mode="reflect")

    window_template = _windowing_array(chunk_size, fade_size, device)
    num_stems = int(config["model"].get("num_stems", 1))
    result = torch.zeros((num_stems,) + tuple(mix.shape), dtype=torch.float32,
                         device=device)
    counter = torch.zeros(mix.shape[-1], dtype=torch.float32, device=device)

    batch_data = []
    batch_locations = []
    index = 0
    with torch.autocast("cuda", dtype=torch.float16, enabled=use_fp16):
        with torch.inference_mode():
            while index < mix.shape[1]:
                part = mix[:, index:index + chunk_size]
                chunk_len = part.shape[-1]
                pad_mode = "reflect" if chunk_len > chunk_size // 2 else "constant"
                part = F.pad(part, (0, chunk_size - chunk_len), mode=pad_mode)
                batch_data.append(part)
                batch_locations.append((index, chunk_len))
                index += step

                if len(batch_data) >= batch_size or index >= mix.shape[1]:
                    out = model(torch.stack(batch_data, dim=0)).to(torch.float32)
                    if out.dim() == 3:  # tek stem'li modeller stem eksenini atıyor
                        out = out.unsqueeze(1)
                    window = window_template.clone()
                    if index - step == 0:
                        window[:fade_size] = 1.0        # ilk parça: fade-in yok
                    elif index >= mix.shape[1]:
                        window[-fade_size:] = 1.0       # son parça: fade-out yok
                    for slot, (start, seg_len) in enumerate(batch_locations):
                        piece = out[slot, ..., :seg_len] * window[:seg_len]
                        result[..., start:start + seg_len] += piece
                        counter[start:start + seg_len] += window[:seg_len]
                    batch_data.clear()
                    batch_locations.clear()

            estimated = result / counter.clamp(min=1e-8)
            if length_init > 2 * border and border > 0:
                estimated = estimated[..., border:-border]

    array = estimated.cpu().numpy()
    # NaN nöbetçisi: T4'te bf16 yok, fp16'da Roformer NaN üretebiliyor.
    # Sessizce sıfırlamak yerine çağırana haber veriyoruz.
    had_nan = bool(np.isnan(array).any() or np.isinf(array).any())
    np.nan_to_num(array, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    return array, had_nan


def _demix_tta(model, mix, config, num_overlap, use_fp16):
    """Test-time augmentation: orijinal + kanal takası + faz tersi, ortalama.

    MSST'nin --use_tta'sıyla aynı. Üç geçiş, yani üç kat süre.
    """
    import numpy as np

    variants = [mix, mix[::-1].copy(), -mix]
    total = None
    nan_seen = False
    for slot, variant in enumerate(variants):
        out, had_nan = _demix(model, variant, config, num_overlap, use_fp16)
        nan_seen = nan_seen or had_nan
        if slot == 1:
            out = out[:, ::-1].copy()   # kanalları geri çevir
        elif slot == 2:
            out = -out                  # fazı geri çevir
        total = out if total is None else total + out
    return total / len(variants), nan_seen

# --------------------------------------------------------------------------
# çıktı yazımı ve ölçüm
# --------------------------------------------------------------------------

STEM_ORDER = ("vocals", "drums", "bass", "guitar", "piano", "other")


def _decode(path: pathlib.Path, samplerate: int, channels: int):
    """ffmpeg -> float32 PCM. torchaudio I/O YOK (proje kuralı)."""
    import numpy as np

    proc = _run([
        "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ar", str(samplerate), "-ac", str(channels), "-",
    ])
    return np.frombuffer(proc.stdout, dtype="<f4").reshape(-1, channels).T.copy()


def _residual_report(mix, stems: dict) -> dict:
    """Stem toplamı orijinal karışımdan ne kadar sapıyor?

    ÖLÇEKLEMEDEN ÖNCE hesaplanıyor: ortak clip_scale uygulandıktan sonra
    bakılsa hata ölçek kadar yapay olarak kayardı.
    """
    import numpy as np

    total = None
    for value in stems.values():
        total = value.copy() if total is None else total + value
    residual = mix - total
    mix_rms = float(np.sqrt(np.mean(mix.astype(np.float64) ** 2)))
    res_rms = float(np.sqrt(np.mean(residual.astype(np.float64) ** 2)))
    ratio_db = 20.0 * np.log10(res_rms / mix_rms) if mix_rms > 0 and res_rms > 0 else -np.inf
    return {
        "residual_db": round(float(ratio_db), 2) if np.isfinite(ratio_db) else -999.0,
        "residual_peak": round(float(np.abs(residual).max()), 6),
        "mix_rms": round(mix_rms, 6),
    }


def _write_outputs(song_id: str, title: str, stems: dict, samplerate: int,
                   channels: int, duration: float, source_song: str,
                   meta: dict) -> list:
    """FLAC master + m4a, canlı `separate` ile AYNI kurallarla.

    Ortak clip_scale: stem başına ayrı ölçek mikserde dengeyi bozardı.
    """
    import soundfile as sf

    song_dir = _song_dir(song_id)
    master_dir = song_dir / "master"
    stems_dir = song_dir / "stems"
    master_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)

    peaks = {name: float(abs(value).max()) for name, value in stems.items()}
    clip_scale = max(1.01 * max(peaks.values()), 1.0)
    print(f"[clip] tepeler={ {k: round(v, 4) for k, v in peaks.items()} }")
    print(f"[clip] ortak scale={clip_scale:.4f}")

    written = []
    for name in STEM_ORDER:
        if name not in stems:
            continue
        data = stems[name] / clip_scale
        flac_path = master_dir / f"{name}.flac"
        sf.write(str(flac_path), data.T, samplerate, subtype=FLAC_SUBTYPE,
                 format="FLAC")
        _run([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(flac_path),
            "-c:a", "aac", "-b:a", AAC_BITRATE,
            "-ar", str(samplerate), "-ac", str(channels),
            "-movflags", "+faststart", str(stems_dir / f"{name}.m4a"),
        ])
        written.append(name)

    # Akor ve vuruş ORİJİNALDEN kopyalanıyor, yeniden hesaplanmıyor:
    # karşılaştırmak istediğimiz ayrıştırma, analiz değil. Aynı ızgara
    # olması zaten şart, yoksa şerit kayar.
    copied = []
    for name in ("chords.json", "beats.json"):
        source = _song_dir(source_song) / name
        if source.is_file():
            shutil.copyfile(source, song_dir / name)
            copied.append(name)

    status = {
        "id": song_id,
        "title": title,
        "state": "done",
        "progress": 100,
        "duration": duration,
        "stems": written,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "experiment": meta,       # ölçümler status.json'da da dursun
        "source_song": source_song,
        "copied_analysis": copied,
    }
    (song_dir / "status.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    volume.commit()
    return written


def _peak_vram() -> dict:
    import torch

    if not torch.cuda.is_available():
        return {}
    return {
        "vram_allocated_mb": round(torch.cuda.max_memory_allocated() / 1024**2, 1),
        "vram_reserved_mb": round(torch.cuda.max_memory_reserved() / 1024**2, 1),
    }


# --------------------------------------------------------------------------
# B: tek model, 6 stem
# --------------------------------------------------------------------------

@app.function(
    image=gpu_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=3600,          # B-max 8 örtüşme + TTA ile dakikalar sürebilir
    max_containers=1,      # min_containers YOK: boştayken maliyet sıfır
)
def run_b(song_id: str, num_overlap: int = 2, tta: bool = False,
          suffix: str = "b", label: str = "B") -> dict:
    global _FIRST_CALL
    import numpy as np
    import torch

    wall_started = time.time()
    cold_seconds = round(time.time() - _CONTAINER_START, 2) if _FIRST_CALL else 0.0
    was_cold = _FIRST_CALL
    _FIRST_CALL = False

    volume.reload()
    root = pathlib.Path(EXP_WEIGHTS)
    config = _load_config(root / "bs_roformer_sw.yaml")
    samplerate = int(config["audio"]["sample_rate"])
    channels = int(config["audio"]["num_channels"])

    load_started = time.time()
    model = _build_model("bs", config)
    _load_checkpoint(model, root / "bs_roformer_sw.ckpt", "cuda")
    model_load_seconds = round(time.time() - load_started, 2)
    print(f"[model] B yuklendi {model_load_seconds} sn")

    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    mix = _decode(_find_input(song_id), samplerate, channels)
    duration = round(mix.shape[1] / samplerate, 3)
    print(f"[decode] {mix.shape} -> {duration} sn")

    torch.cuda.reset_peak_memory_stats()
    gpu_started = time.time()
    use_fp16 = True
    if tta:
        out, had_nan = _demix_tta(model, mix, config, num_overlap, use_fp16)
    else:
        out, had_nan = _demix(model, mix, config, num_overlap, use_fp16)
    if had_nan:
        # fp16'da NaN çıktı: aynı şarkıyı fp32'de yeniden koş, hangisinin
        # kullanıldığını rapora yaz. Sessizce sıfırlamak sonucu bozar.
        print("[fp16] NaN/Inf uretildi, fp32'ye dusuluyor")
        use_fp16 = False
        torch.cuda.reset_peak_memory_stats()
        gpu_started = time.time()
        if tta:
            out, had_nan = _demix_tta(model, mix, config, num_overlap, use_fp16)
        else:
            out, had_nan = _demix(model, mix, config, num_overlap, use_fp16)
    gpu_seconds = round(time.time() - gpu_started, 2)
    vram = _peak_vram()
    print(f"[demix] {gpu_seconds} sn, overlap={num_overlap}, tta={tta}, "
          f"fp16={use_fp16}, {vram}")

    names = list(config["training"]["instruments"])
    stems = {name: out[index] for index, name in enumerate(names)}
    missing = [name for name in STEM_ORDER if name not in stems]
    if missing:
        raise ValueError(f"model beklenen stem'leri vermedi, eksik: {missing}")

    residual = _residual_report(mix, stems)
    print(f"[artik] {residual}")

    title = f"{source_status.get('title') or song_id[:12]} [{label}]"
    target_id = f"{song_id}-{suffix}"
    written = _write_outputs(target_id, title, stems, samplerate, channels,
                             duration, song_id, meta={})

    wall_seconds = round(time.time() - wall_started, 2)
    report = {
        "method": label,
        "source_song": song_id,
        "target_song": target_id,
        "title": title,
        "duration": duration,
        "num_overlap": int(num_overlap),
        "tta": bool(tta),
        "precision": "fp16" if use_fp16 else "fp32",
        "cold_start_seconds": cold_seconds,
        "was_cold": bool(was_cold),
        "model_load_seconds": model_load_seconds,
        "gpu_seconds": gpu_seconds,
        "wall_seconds": wall_seconds,
        "usd": round(wall_seconds * T4_USD_PER_SECOND, 5),
        "stems": written,
        **{key: float(value) for key, value in vram.items()},
        **{key: float(value) for key, value in residual.items()},
    }
    # status.json'a ölçümleri de yaz (yeniden çalıştırmadan bakılabilsin).
    status_path = _song_dir(target_id) / "status.json"
    status = json.loads(status_path.read_text("utf-8"))
    status["experiment"] = report
    status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    volume.commit()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report

# --------------------------------------------------------------------------
# A: Roformer vokal -> enstrümantal -> htdemucs_6s
# --------------------------------------------------------------------------

@app.function(
    image=gpu_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=3600,
    max_containers=1,      # min_containers YOK
)
def run_a(song_id: str, num_overlap: int = 2, suffix: str = "a",
          label: str = "A") -> dict:
    """İki aşamalı hibrit.

    1. Mel-Band Roformer karışımdan vokali çıkarır.
    2. enstrümantal = karışım - vokal   (tanım gereği TAM, hata sıfır)
    3. htdemucs_6s enstrümantali böler.
    4. Demucs'un KENDİ vokal çıkışı (enstrümantalde kalan artık) "other"a
       EKLENİR, atılmaz - stem toplamı karışıma eşit kalsın diye.

    Yani toplamdaki tek sapma demucs'un kendi yeniden kurma hatası; Roformer
    aşaması hiç hata eklemiyor.
    """
    global _FIRST_CALL
    import numpy as np
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    wall_started = time.time()
    cold_seconds = round(time.time() - _CONTAINER_START, 2) if _FIRST_CALL else 0.0
    was_cold = _FIRST_CALL
    _FIRST_CALL = False

    volume.reload()
    root = pathlib.Path(EXP_WEIGHTS)
    config = _load_config(root / "melband_vocals.yaml")
    samplerate = int(config["audio"]["sample_rate"])
    channels = int(config["audio"]["num_channels"])

    load_started = time.time()
    roformer = _build_model("melband", config)
    _load_checkpoint(roformer, root / "melband_vocals.ckpt", "cuda")
    demucs = get_model(MODEL_NAME)
    demucs.eval()
    model_load_seconds = round(time.time() - load_started, 2)
    demucs_sources = [str(name) for name in demucs.sources]
    print(f"[model] A yuklendi {model_load_seconds} sn, demucs={demucs_sources}")

    if int(demucs.samplerate) != samplerate or int(demucs.audio_channels) != channels:
        raise ValueError(
            f"Ornekleme/kanal uyusmuyor: roformer {samplerate}/{channels}, "
            f"demucs {int(demucs.samplerate)}/{int(demucs.audio_channels)}"
        )

    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    mix = _decode(_find_input(song_id), samplerate, channels)
    duration = round(mix.shape[1] / samplerate, 3)
    print(f"[decode] {mix.shape} -> {duration} sn")

    # --- 1. aşama: vokal ---------------------------------------------------
    torch.cuda.reset_peak_memory_stats()
    stage1_started = time.time()
    use_fp16 = True
    out, had_nan = _demix(roformer, mix, config, num_overlap, use_fp16)
    if had_nan:
        print("[fp16] NaN/Inf uretildi, fp32'ye dusuluyor")
        use_fp16 = False
        torch.cuda.reset_peak_memory_stats()
        stage1_started = time.time()
        out, had_nan = _demix(roformer, mix, config, num_overlap, use_fp16)
    vocals = out[0]
    stage1_seconds = round(time.time() - stage1_started, 2)
    vram_stage1 = _peak_vram()
    print(f"[roformer] {stage1_seconds} sn, fp16={use_fp16}, {vram_stage1}")

    # Belleği bırak: demucs aşaması aynı GPU'da.
    del roformer, out
    torch.cuda.empty_cache()

    # --- 2. aşama: enstrümantal -> demucs ---------------------------------
    instrumental = mix - vocals

    # Normalizasyon: canlı separate ile aynı (demucs CLI davranışı).
    reference = instrumental.mean(0)
    ref_mean = float(reference.mean())
    ref_std = float(reference.std())
    if ref_std < 1e-8:
        raise ValueError("Enstrumantal neredeyse sessiz; demucs'a verilecek sinyal yok.")
    normalized = (instrumental - ref_mean) / ref_std

    torch.cuda.reset_peak_memory_stats()
    stage2_started = time.time()
    with torch.no_grad():
        split = apply_model(
            demucs, torch.from_numpy(normalized)[None], device="cuda",
            shifts=1, split=True, overlap=0.25, progress=False,
        )
    demucs_out = (split[0].cpu().numpy() * ref_std) + ref_mean
    stage2_seconds = round(time.time() - stage2_started, 2)
    vram_stage2 = _peak_vram()
    print(f"[demucs] {stage2_seconds} sn, {vram_stage2}")

    by_name = {name: demucs_out[index] for index, name in enumerate(demucs_sources)}

    # Demucs'un vokal çıkışı: enstrümantalde kalan vokal ARTIĞI. Roformer'ın
    # vokaliyle karıştırmak istemiyoruz (çift sayılırdı), atmak da toplamı
    # bozardı - "other"a ekliyoruz.
    residue = by_name.get("vocals")
    stems = {
        "vocals": vocals,
        "drums": by_name["drums"],
        "bass": by_name["bass"],
        "guitar": by_name["guitar"],
        "piano": by_name["piano"],
        "other": by_name["other"] + (residue if residue is not None else 0.0),
    }
    residue_rms = float(np.sqrt(np.mean(residue.astype(np.float64) ** 2))) if residue is not None else 0.0
    print(f"[artik-vokal] demucs'un vokal artigi rms={residue_rms:.6f} -> other'a eklendi")

    residual = _residual_report(mix, stems)
    print(f"[artik] {residual}")

    title = f"{source_status.get('title') or song_id[:12]} [{label}]"
    target_id = f"{song_id}-{suffix}"
    written = _write_outputs(target_id, title, stems, samplerate, channels,
                             duration, song_id, meta={})

    wall_seconds = round(time.time() - wall_started, 2)
    gpu_seconds = round(stage1_seconds + stage2_seconds, 2)
    report = {
        "method": label,
        "source_song": song_id,
        "target_song": target_id,
        "title": title,
        "duration": duration,
        "num_overlap": int(num_overlap),
        "tta": False,
        "precision": "fp16" if use_fp16 else "fp32",
        "cold_start_seconds": cold_seconds,
        "was_cold": bool(was_cold),
        "model_load_seconds": model_load_seconds,
        "gpu_seconds": gpu_seconds,
        "roformer_seconds": stage1_seconds,
        "demucs_seconds": stage2_seconds,
        "vocal_residue_rms": round(residue_rms, 6),
        "wall_seconds": wall_seconds,
        "usd": round(wall_seconds * T4_USD_PER_SECOND, 5),
        "stems": written,
        "vram_allocated_mb": float(max(
            vram_stage1.get("vram_allocated_mb", 0.0),
            vram_stage2.get("vram_allocated_mb", 0.0),
        )),
        "vram_reserved_mb": float(max(
            vram_stage1.get("vram_reserved_mb", 0.0),
            vram_stage2.get("vram_reserved_mb", 0.0),
        )),
        **{key: float(value) for key, value in residual.items()},
    }
    status_path = _song_dir(target_id) / "status.json"
    status = json.loads(status_path.read_text("utf-8"))
    status["experiment"] = report
    status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    volume.commit()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


# --------------------------------------------------------------------------
# şarkı seçimi ve koşum
# --------------------------------------------------------------------------

@app.function(image=fetch_image, volumes={DATA_DIR: volume}, timeout=120)
def pick_songs(count: int = 3, must_contain: str = "") -> list:
    """Deneyde kullanılacak şarkılar: en son yüklenen `count` tanesi.

    `must_contain` verilirse (HAZBIN gibi) o şarkı listede olmasa bile
    başa ekleniyor. Deney çıktıları (-a/-b/-bmax) elenmiş oluyor.
    """
    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    found = []
    for entry in sorted(root.iterdir()) if root.is_dir() else []:
        status_path = entry / "status.json"
        if not status_path.is_file():
            continue
        try:
            data = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("state") != "done":
            continue
        if data.get("source_song"):       # deney çıktısı, kaynak değil
            continue
        if not sorted(entry.glob("input.*")):
            continue
        found.append({
            "id": str(data.get("id", entry.name)),
            "title": str(data.get("title") or entry.name[:12]),
            "created_at": str(data.get("created_at") or ""),
            "duration": float(data.get("duration") or 0.0),
        })

    found.sort(key=lambda item: item["created_at"], reverse=True)
    chosen = []
    if must_contain:
        needle = must_contain.lower()
        for item in found:
            if needle in item["title"].lower():
                chosen.append(item)
                break
    for item in found:
        if len(chosen) >= count:
            break
        if item not in chosen:
            chosen.append(item)
    return chosen


@app.local_entrypoint()
def fetch(check_mirror: bool = True):
    """modal run backend/experiment.py::fetch"""
    report = fetch_weights.remote(check_mirror=check_mirror)
    print("\n--- agirlik raporu ---")
    for key, value in report.items():
        print(f"{key}: {value}")

@app.local_entrypoint()
def main(count: int = 3, must_contain: str = "HAZBIN",
         methods: str = "a,b,bmax", song_id: str = ""):
    """Deneyi koşturur ve karşılaştırma tablosunu basar.

        modal run backend/experiment.py
        modal run backend/experiment.py --methods b,bmax --count 1

    ÖNCE `modal run backend/experiment.py::fetch` çalıştırılmış olmalı.
    """
    if song_id:
        songs = [{"id": song_id, "title": song_id[:12], "duration": 0.0}]
    else:
        songs = pick_songs.remote(count=count, must_contain=must_contain)
    if not songs:
        raise SystemExit(
            "Kitaplikta 'done' durumunda, input dosyasi olan sarki bulunamadi."
        )

    wanted = [name.strip().lower() for name in methods.split(",") if name.strip()]
    print(f"\nSarkilar ({len(songs)}):")
    for item in songs:
        print(f"  {item['id'][:12]}  {item['title']}  "
              f"{item.get('duration', 0):.0f} sn")
    print(f"Yontemler: {', '.join(wanted)}\n")

    reports = []
    for item in songs:
        for method in wanted:
            print(f"--- {item['title'][:40]} / {method.upper()} ---")
            try:
                if method == "a":
                    report = run_a.remote(item["id"])
                elif method == "b":
                    report = run_b.remote(item["id"], num_overlap=2, tta=False,
                                          suffix="b", label="B")
                elif method == "bmax":
                    # [B-max]: yüksek örtüşme + test-time augmentation.
                    # Tek kullanıcı, şarkı başı dakikalar kabul.
                    report = run_b.remote(item["id"], num_overlap=8, tta=True,
                                          suffix="bmax", label="B-max")
                else:
                    print(f"  bilinmeyen yontem: {method}")
                    continue
                reports.append(report)
            except Exception as error:  # noqa: BLE001 - deney, akış durmasın
                print(f"  BASARISIZ: {error}")
                reports.append({"method": method, "source_song": item["id"],
                                "error": str(error)})

    _print_table(reports)


def _print_table(reports: list):
    ok = [r for r in reports if "error" not in r]
    failed = [r for r in reports if "error" in r]

    print("\n" + "=" * 108)
    print("ASAMA 9 DENEY SONUCLARI")
    print("=" * 108)
    header = (f"{'yontem':<7} {'sarki':<24} {'sure':>6} {'GPU':>7} {'duvar':>7} "
              f"{'$':>8} {'VRAM':>7} {'artik dB':>9} {'kesinlik':>8} {'soguk':>7}")
    print(header)
    print("-" * 108)
    for r in ok:
        print(
            f"{r['method']:<7} {r['title'][:24]:<24} "
            f"{r['duration']:>6.0f} {r['gpu_seconds']:>7.1f} {r['wall_seconds']:>7.1f} "
            f"{r['usd']:>8.4f} {r.get('vram_allocated_mb', 0):>7.0f} "
            f"{r.get('residual_db', 0):>9.1f} {r['precision']:>8} "
            f"{r['cold_start_seconds'] if r.get('was_cold') else 0:>7.1f}"
        )
    print("-" * 108)

    # Yöntem başına ortalama: asıl karşılaştırma bu.
    print("\nYONTEM BASINA ORTALAMA (sarki basi)")
    for method in ("A", "B", "B-max"):
        rows = [r for r in ok if r["method"] == method]
        if not rows:
            continue
        n = len(rows)
        avg = lambda key: sum(r.get(key, 0) for r in rows) / n  # noqa: E731
        # Dakika basina normalize: sarki sureleri farkli.
        minutes = sum(r["duration"] for r in rows) / 60.0
        print(
            f"  {method:<6} n={n}  GPU {avg('gpu_seconds'):.1f} sn  "
            f"duvar {avg('wall_seconds'):.1f} sn  ${avg('usd'):.4f}/sarki  "
            f"({sum(r['wall_seconds'] for r in rows) / minutes:.1f} sn/muzik-dk)  "
            f"VRAM {max(r.get('vram_allocated_mb', 0) for r in rows):.0f} MB  "
            f"artik {avg('residual_db'):.1f} dB"
        )

    if failed:
        print("\nBASARISIZ:")
        for r in failed:
            print(f"  {r['method']} / {r['source_song'][:12]}: {r['error'][:160]}")

    print("\nartik dB = 20*log10(rms(karisim - toplam stem) / rms(karisim)).")
    print("Ne kadar NEGATIF ise toplam orijinale o kadar yakin.")
    print("Sonuclar kitaplikta '[A]', '[B]', '[B-max]' olarak gorunuyor;")
    print("akor ve vurus orijinalden kopyalandi, yeniden hesaplanmadi.")
