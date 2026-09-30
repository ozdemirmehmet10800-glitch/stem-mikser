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
  dosyası var. Commit 84b1eac0887756b4f1a9d7a1ff49105939749ed2'ye PİNLİ ve
  dosyalar DEPODA: backend/vendor/msst/ (lisans, hash'ler ve attend.py
  yaması orada belgeli). İmaja add_local_dir ile giriyor, indirilmiyor.
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

# MSST (MIT) mimari dosyaları - PİNLİ commit. Artık DEPODA (canlı app.py ile
# aynı kaynak: backend/vendor/msst/, imaja add_local_dir ile giriyor).
# Önceden hem fetch hem çalışma anında indirilip metin yamasıyla torch 2.5.1'e
# uyarlanıyorlardı; yama şimdi depodaki dosyada görünür durumda.
MSST_SHA = "84b1eac0887756b4f1a9d7a1ff49105939749ed2"
MSST_RAW = f"https://raw.githubusercontent.com/ZFTurbo/Music-Source-Separation-Training/{MSST_SHA}"
MSST_DIR = "/msst"
MSST_LOCAL = str(pathlib.Path(__file__).resolve().parent / "vendor" / "msst")

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

    # MSST mimari dosyaları BURADA İNMİYOR: depoda (backend/vendor/msst/) ve
    # imaja add_local_dir ile giriyorlar. Eski koşumlardan Volume'da kalmış
    # `weights-exp/msst` kopyası varsa artık KULLANILMIYOR (sys.path imajı
    # gösteriyor); silinmesi gerekmiyor, yalnızca ölü veri.
    report["msst_commit"] = MSST_SHA
    report["msst_source"] = f"repo: backend/vendor/msst -> imaj: {MSST_DIR}"

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
        # MSST'nin GERÇEK demix'ini referans olarak çağırabilmek için.
        "ml-collections==1.0.0",
        "tqdm==4.67.1",
    )
    .env({"HF_HOME": DEMUCS_WEIGHTS, "TORCH_HOME": DEMUCS_WEIGHTS})
    .run_function(_warm_demucs)
    .env({"HF_HUB_OFFLINE": "1"})
    # MSST mimari dosyaları (MIT, pinli commit) depodan - canlı app.py ile aynı
    # kaynak. copy=False: konteyner açılışında bağlanıyor, imaj katmanına
    # girmiyor, yani değişse bile demucs ağırlığı yeniden inmiyor. Modal'da
    # mount katmanından sonra build adımı olamaz, bu yüzden en sonda.
    .add_local_dir(MSST_LOCAL, MSST_DIR)
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
    """MSST model dosyaları imajda (depodan gelir); sys.path'e eklenecek yol."""
    return MSST_DIR


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

    # Çalışma anı yaması KALKTI: attend.py depoda yamalı geliyor
    # (backend/vendor/msst/models/bs_roformer/attend.py).
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
                   meta: dict, clip_scale: float = None,
                   copy_analysis: bool = True) -> list:
    """FLAC master + m4a, canlı `separate` ile AYNI kurallarla.

    Ortak clip_scale: stem başına ayrı ölçek mikserde dengeyi bozardı.
    `clip_scale` verilirse (madde 7 deneyi) ONUNLA yazılır: aynı şarkının
    varyantları aynı ölçeği kullansın, yoksa ~1 dB ses farkı kulak testinde
    "daha iyi" yanılgısı yaratır.
    """
    import soundfile as sf

    song_dir = _song_dir(song_id)
    master_dir = song_dir / "master"
    stems_dir = song_dir / "stems"
    master_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)

    peaks = {name: float(abs(value).max()) for name, value in stems.items()}
    if clip_scale is None:
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
    for name in (("chords.json", "beats.json") if copy_analysis else ()):
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

    # Etiket BAŞTA: telefonda uzun isimlerin sonu görünmüyor.
    title = f"[{label}] {source_status.get('title') or song_id[:12]}"
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

    # Etiket BAŞTA: telefonda uzun isimlerin sonu görünmüyor.
    title = f"[{label}] {source_status.get('title') or song_id[:12]}"
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


# --------------------------------------------------------------------------
# C: vokal B'nin modelinden, kalan 5 stem demucs'tan
# --------------------------------------------------------------------------

def _demucs_stage(demucs, instrumental, sources: list, fix_mean: bool = False):
    """Enstrümantali htdemucs_6s ile böler. A ve C bunu paylaşıyor.

    Normalizasyon canlı `separate` ile aynı (demucs CLI davranışı).
    `fix_mean`: canlı yoldaki düzeltme (ref_mean YALNIZ bir kaynağa eklenir);
    eski A/C koşumları yayınlama kusuruyla kalsın diye varsayılan kapalı.
    Dönen: {isim: (2, N)}, saniye, tepe VRAM.
    """
    import numpy as np
    import torch
    from demucs.apply import apply_model

    reference = instrumental.mean(0)
    ref_mean = float(reference.mean())
    ref_std = float(reference.std())
    if ref_std < 1e-8:
        raise ValueError("Enstrumantal neredeyse sessiz; demucs'a verilecek sinyal yok.")
    normalized = (instrumental - ref_mean) / ref_std

    torch.cuda.reset_peak_memory_stats()
    started = time.time()
    with torch.no_grad():
        split = apply_model(
            demucs, torch.from_numpy(normalized)[None], device="cuda",
            shifts=1, split=True, overlap=0.25, progress=False,
        )
    if fix_mean:
        out = split[0].cpu().numpy() * ref_std
        out[0] += ref_mean
    else:
        out = (split[0].cpu().numpy() * ref_std) + ref_mean
    seconds = round(time.time() - started, 2)
    return {name: out[index] for index, name in enumerate(sources)}, seconds, _peak_vram()


@app.function(
    image=gpu_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=3600,
    max_containers=1,      # min_containers YOK
)
def run_c(song_id: str, num_overlap: int = 2, suffix: str = "c",
          label: str = "C", fp32: bool = False,
          instrumental_from_model: bool = False) -> dict:
    """A ile AYNI iskelet, vokal kaynağı farklı.

    Kulak testinde vokalin en temizi B'nin modeli çıktı ama B'nin bası ve
    gitarı kayboluyordu; demucs'un bas/gitar/davulu ise iyiydi. C ikisinin
    iyi tarafını birleştiriyor: vokali BS-Roformer SW'den, kalan beş stem'i
    htdemucs_6s'ten.
    """
    global _FIRST_CALL
    import numpy as np
    import torch
    from demucs.pretrained import get_model

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
    roformer = _build_model("bs", config)
    _load_checkpoint(roformer, root / "bs_roformer_sw.ckpt", "cuda")
    demucs = get_model(MODEL_NAME)
    demucs.eval()
    model_load_seconds = round(time.time() - load_started, 2)
    demucs_sources = [str(name) for name in demucs.sources]
    print(f"[model] C yuklendi {model_load_seconds} sn, demucs={demucs_sources}")

    if int(demucs.samplerate) != samplerate or int(demucs.audio_channels) != channels:
        raise ValueError(
            f"Ornekleme/kanal uyusmuyor: roformer {samplerate}/{channels}, "
            f"demucs {int(demucs.samplerate)}/{int(demucs.audio_channels)}"
        )

    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    mix = _decode(_find_input(song_id), samplerate, channels)
    duration = round(mix.shape[1] / samplerate, 3)
    print(f"[decode] {mix.shape} -> {duration} sn")

    # --- 1. aşama: B'nin modeli, YALNIZ vokal çıkışı alınıyor -------------
    torch.cuda.reset_peak_memory_stats()
    stage1_started = time.time()
    # fp32 elle istenebiliyor: C'de duyulan cızırtının vokal tahminindeki
    # hassasiyetten gelip gelmediğini sınamak için. Konfig use_amp: true
    # diyor (MSST'nin varsayılanı da bu), yani fp16 "yanlış" değil - ama
    # çıkarma sonrası açığa çıkan hatayı büyütüyor olabilir.
    use_fp16 = not fp32
    out, had_nan = _demix(roformer, mix, config, num_overlap, use_fp16)
    if had_nan and use_fp16:
        print("[fp16] NaN/Inf uretildi, fp32'ye dusuluyor")
        use_fp16 = False
        torch.cuda.reset_peak_memory_stats()
        stage1_started = time.time()
        out, had_nan = _demix(roformer, mix, config, num_overlap, use_fp16)
    names = list(config["training"]["instruments"])
    vocals = out[names.index("vocals")]
    # C-inst modelin öteki stem'lerine de ihtiyaç duyuyor; yalnız o kipte
    # tutuyoruz, yoksa bellekte boşuna 6 kanal duruyor.
    out_all = out if instrumental_from_model else None
    stage1_seconds = round(time.time() - stage1_started, 2)
    vram_stage1 = _peak_vram()
    print(f"[roformer-B] {stage1_seconds} sn, fp16={use_fp16}, {vram_stage1}")

    del roformer
    if out_all is None:
        del out
    torch.cuda.empty_cache()

    # --- 2. aşama: enstrümantal -> demucs ---------------------------------
    if instrumental_from_model:
        # C-inst: modelin KENDİ enstrümantali (vokal dışı 5 stem toplamı).
        # Çıkarma yapılmadığı için vokal tahminindeki hata enstrümantale
        # sızmıyor; bedeli toplamın artık tam korunmaması (~-33 dB kabul).
        instrumental = None
        for name in names:
            if name == "vocals":
                continue
            piece = out_all[names.index(name)]
            instrumental = piece.copy() if instrumental is None else instrumental + piece
        print("[enstrumantal] modelin kendi 5 stem toplamindan")
    else:
        # Çıkarma TANIM GEREĞİ tam: enstrümantal = karışım - vokal.
        instrumental = mix - vocals
        print("[enstrumantal] karisim - vokal")
    by_name, stage2_seconds, vram_stage2 = _demucs_stage(
        demucs, instrumental, demucs_sources
    )
    print(f"[demucs] {stage2_seconds} sn, {vram_stage2}")

    # Demucs'un vokal çıkışı = enstrümantalde kalan artık -> "other"a.
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

    # Etiket BAŞTA: telefonda uzun isimlerin sonu görünmüyor.
    title = f"[{label}] {source_status.get('title') or song_id[:12]}"
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
        "tta": False,
        "precision": "fp16" if use_fp16 else "fp32",
        "cold_start_seconds": cold_seconds,
        "was_cold": bool(was_cold),
        "model_load_seconds": model_load_seconds,
        "gpu_seconds": round(stage1_seconds + stage2_seconds, 2),
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


@app.local_entrypoint()
def analyze(count: int = 3, must_contain: str = "HAZBIN", song_id: str = "",
            variants: str = ",a,b,c,cfp32,cov4,cboth,cinst,e"):
    """Kulak testinden sonra: içerik hangi stem'e gitti?

        modal run backend/experiment.py::analyze
    """
    if song_id:
        songs = [{"id": song_id, "title": song_id[:12]}]
    else:
        songs = pick_songs.remote(count=count, must_contain=must_contain)

    for item in songs:
        report = analyze_variants.remote(item["id"], variants=variants)
        _print_analysis(report)


def _print_analysis(report: dict):
    title = report["title"]
    print("\n" + "=" * 100)
    print(f"{title}")
    print("=" * 100)

    print("\n1) STEM BASINA <150 Hz PAYI (yontem ici dagilim, toplam=1.00)")
    header = f"{'yontem':<10}" + "".join(f"{n:>9}" for n in STEM_ORDER)
    print(header)
    for variant, row in report.get("low_band_share", {}).items():
        name = variant or "orijinal"
        print(f"{name:<10}" + "".join(f"{row.get(n, 0):>9.3f}" for n in STEM_ORDER))

    print("\n2) STEM BASINA RMS ve TEPE")
    for variant, entry in report["variants"].items():
        name = variant or "orijinal"
        print(f"  {name:<8} scale={entry['scale']:.3f}  artik={entry['residual_db']:>7.1f} dB"
              f"  DC={entry['dc_offset']:.1e}")
        for stem in STEM_ORDER:
            data = entry["stems"].get(stem)
            if not data:
                continue
            print(f"      {stem:<7} rms={data['rms']:.5f} tepe={data['peak']:.4f} "
                  f"<150Hz pay={data['low_energy_ratio']:.3f} "
                  f"sicrama max={data['max_jump']:.3f} n={data['jumps_over_threshold']}")

    print("\n3) ICERIK ESLEMESI (bir yontemin stem'i otekinde nereye dusuyor)")
    for pair, matrix in report.get("stem_mapping", {}).items():
        print(f"  {pair}")
        for stem, data in matrix.items():
            row = "  ".join(f"{k}={v:.2f}" for k, v in data["row"].items())
            print(f"      {stem:<7} -> {data['best_match']:<7} ({data['corr']:.2f})   {row}")


# --------------------------------------------------------------------------
# Kulak testi sonrası ölçüm: içerik nereye gitti?
# --------------------------------------------------------------------------
# Kulakla duyulanlar ("B'de bas yok", "B'de gitar yok", "A'nın artığı büyük",
# "B-max'ta cızırtı") tahminle değil sayıyla açıklanıyor. Hepsi Volume'daki
# FLAC master'lardan okunuyor, GPU gerekmiyor.

# PyYAML ŞART: analiz konfiglerden chunk/adım geometrisini okuyor.
# İlk sürümde unutulmuştu, ::crackle ModuleNotFoundError ile düştü.
analysis_image = modal.Image.debian_slim(python_version="3.11").apt_install(
    "ffmpeg"
).pip_install("numpy==1.26.4", "soundfile==0.13.1", "PyYAML==6.0.2")

# Bant sınırları: bas <150 Hz (kullanıcının sorduğu), orta, tiz.
BANDS = ((0.0, 150.0), (150.0, 2000.0), (2000.0, 22050.0))
CORR_RATE_DIVISOR = 4      # 44100 -> 11025, ilişki ölçümü için fazlasıyla yeter
CLICK_THRESHOLD = 0.25     # ardışık örnek farkı bu kadarsa süreksizlik sayılır


def _band_energies(mono, samplerate: int) -> list:
    """Bant başına enerji (mutlak, toplamı sinyalin toplam enerjisi)."""
    import numpy as np

    frame = 1 << 15
    freqs = np.fft.rfftfreq(frame, d=1.0 / samplerate)
    masks = [(freqs >= low) & (freqs < high) for low, high in BANDS]
    totals = [0.0] * len(BANDS)
    for start in range(0, len(mono) - frame + 1, frame):
        spectrum = np.abs(np.fft.rfft(mono[start:start + frame])) ** 2
        for index, mask in enumerate(masks):
            totals[index] += float(spectrum[mask].sum())
    return totals


def _click_stats(stereo) -> dict:
    """Süreksizlik (cızırtı) izi: ardışık örnekler arasındaki sıçramalar."""
    import numpy as np

    mono = stereo.mean(axis=0)
    diff = np.abs(np.diff(mono))
    big = np.flatnonzero(diff > CLICK_THRESHOLD)
    return {
        "max_jump": round(float(diff.max()) if diff.size else 0.0, 4),
        "p99999_jump": round(float(np.percentile(diff, 99.999)) if diff.size else 0.0, 4),
        "jumps_over_threshold": int(big.size),
        "first_jump_samples": [int(v) for v in big[:8]],
    }


def _load_stems(song_id: str, samplerate_hint: int = 44100):
    """Bir varyantın master FLAC'larını okur.

    Dönen: {isim: (2, N) float32}, örnekleme hızı. Eksik stem atlanıyor.
    """
    import numpy as np
    import soundfile as sf

    master = _song_dir(song_id) / "master"
    stems = {}
    samplerate = samplerate_hint
    for name in STEM_ORDER:
        path = master / f"{name}.flac"
        if not path.is_file():
            continue
        data, samplerate = sf.read(str(path), dtype="float32", always_2d=True)
        stems[name] = np.ascontiguousarray(data.T)
    return stems, int(samplerate)


def _downmix(stereo, divisor: int):
    """Mono + basit ondalama: ilişki ölçümü için yeterli, bellek dostu."""
    import numpy as np

    mono = stereo.mean(axis=0)
    usable = (len(mono) // divisor) * divisor
    return mono[:usable].reshape(-1, divisor).mean(axis=1)


def _correlation(first, second) -> float:
    import numpy as np

    length = min(len(first), len(second))
    a, b = first[:length], second[:length]
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator < 1e-12:
        return 0.0
    return round(float(np.dot(a, b) / denominator), 3)


@app.function(
    image=analysis_image,
    volumes={DATA_DIR: volume},
    timeout=1800,
    memory=8192,
)
def analyze_variants(song_id: str, variants: str = ",a,b,c,cfp32,cov4,cboth,cinst,e") -> dict:
    """Bir şarkının tüm yöntem çıktılarını yan yana ölçer."""
    import numpy as np

    volume.reload()
    wanted = [v.strip() for v in variants.split(",")]
    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    title = source_status.get("title") or song_id[:12]

    mix = None
    samplerate = 44100
    report = {"song": song_id, "title": title, "variants": {}}
    compact = {}   # varyant -> {stem -> ondalanmış mono}

    for variant in wanted:
        target = song_id if variant == "" else f"{song_id}-{variant}"
        if not (_song_dir(target) / "master").is_dir():
            print(f"[atla] {target} yok")
            continue
        stems, samplerate = _load_stems(target)
        if not stems:
            continue
        if mix is None:
            mix = _decode(_find_input(song_id), samplerate, 2)

        total = None
        for value in stems.values():
            total = value.copy() if total is None else total + value

        # Kaydedilen stem'ler ortak clip_scale'e BÖLÜNMÜŞ durumda ve ölçek
        # varyanttan varyanta değişiyor. Yöntemleri karşılaştırmak için geri
        # çarpmamız gerek; ölçeği en küçük kareler ile kestiriyoruz:
        #   scale = <mix, toplam> / <toplam, toplam>
        length = min(mix.shape[1], total.shape[1])
        numerator = float(np.sum(mix[:, :length] * total[:, :length]))
        denominator = float(np.sum(total[:, :length] ** 2))
        scale = numerator / denominator if denominator > 1e-12 else 1.0

        residual = mix[:, :length] - scale * total[:, :length]
        mix_rms = float(np.sqrt(np.mean(mix[:, :length].astype(np.float64) ** 2)))
        res_rms = float(np.sqrt(np.mean(residual.astype(np.float64) ** 2)))
        residual_db = 20.0 * np.log10(res_rms / mix_rms) if mix_rms > 0 and res_rms > 0 else -999.0
        # DC kayması: demucs normalizasyonu ref_mean'i HER stem'e geri
        # ekliyor, yani toplamda 6 kat. Gerçek müzikte ref_mean ~0 olduğu
        # için ihmal edilebilir olmalı - ölçüp gösteriyoruz.
        dc_offset = float(np.mean(scale * total[:, :length]) - np.mean(mix[:, :length]))

        entry = {"scale": round(scale, 4),
                 "residual_db": round(float(residual_db), 2),
                 "dc_offset": float(f"{dc_offset:.3e}"),
                 "stems": {}}
        compact[variant] = {}
        for name, value in stems.items():
            scaled = value * scale
            mono = scaled.mean(axis=0)
            bands = _band_energies(mono, samplerate)
            band_total = sum(bands) or 1.0
            entry["stems"][name] = {
                "rms": round(float(np.sqrt(np.mean(scaled.astype(np.float64) ** 2))), 5),
                "peak": round(float(np.abs(scaled).max()), 4),
                "low_energy_ratio": round(bands[0] / band_total, 4),
                "low_energy_abs": float(f"{bands[0]:.4e}"),
                **_click_stats(scaled),
            }
            compact[variant][name] = _downmix(scaled, CORR_RATE_DIVISOR)
        report["variants"][variant] = entry
        print(f"[{variant or 'orijinal'}] scale={scale:.4f} artik={residual_db:.1f} dB")

    # --- bas nereye gitti: <150 Hz enerjisinin yöntemler arası dağılımı ----
    low_table = {}
    for variant, entry in report["variants"].items():
        absolute = {name: data["low_energy_abs"] for name, data in entry["stems"].items()}
        grand = sum(absolute.values()) or 1.0
        low_table[variant] = {name: round(value / grand, 4)
                              for name, value in absolute.items()}
    report["low_band_share"] = low_table

    # --- içerik eşlemesi: A'nın stem'i B'nin hangi stem'iyle örtüşüyor? ----
    pairs = {}
    for left in ("", "a", "c"):
        for right in ("b", "bmax", "c"):
            if left not in compact or right not in compact or left == right:
                continue
            matrix = {}
            for lname, lvalue in compact[left].items():
                row = {rname: _correlation(lvalue, rvalue)
                       for rname, rvalue in compact[right].items()}
                best = max(row, key=row.get)
                matrix[lname] = {"best_match": best, "corr": row[best], "row": row}
            pairs[f"{left or 'orijinal'}->{right}"] = matrix
    report["stem_mapping"] = pairs

    volume.commit()
    return report


# --------------------------------------------------------------------------
# Cızırtı avı: "karışım - vokal" enstrümantalleri karşılaştır
# --------------------------------------------------------------------------
# C'de cızırtı duyuldu, A'da duyulmadı. İkisinin de yaptığı şey aynı:
# enstrümantal = karışım - vokal. Fark vokali üreten model ve onun parça
# (chunk) geometrisi:
#
#   A (MelBand)  chunk 352800 = 8.00 sn, adım (overlap 2) 176400 = 4.00 sn
#   C (BS-RoFo)  chunk 588800 = 13.35 sn, adım (overlap 2) 294400 = 6.68 sn
#
# Cızırtı parça sınırlarından geliyorsa sıçramalar ADIMIN KATLARINDA
# kümelenir. Bunu varsaymak yerine ölçüyoruz: en büyük sıçramaların
# konumlarını adıma göre mod alıp dağılımın ne kadar toplandığına bakıyoruz.

HF_BAND_HZ = 8000.0     # cızırtı geniş bantlı/tiz olur
TOP_JUMPS = 300         # periyodiklik sınaması için en büyük sıçramalar
MOD_BINS = 100


def _hf_share(mono, samplerate: int) -> float:
    import numpy as np

    frame = 1 << 15
    freqs = np.fft.rfftfreq(frame, d=1.0 / samplerate)
    mask = freqs >= HF_BAND_HZ
    high = 0.0
    total = 0.0
    for start in range(0, len(mono) - frame + 1, frame):
        spectrum = np.abs(np.fft.rfft(mono[start:start + frame])) ** 2
        total += float(spectrum.sum())
        high += float(spectrum[mask].sum())
    return high / total if total > 0 else 0.0


def _periodicity(positions, step: int) -> dict:
    """Sıçramalar adımın katlarında mı kümeleniyor?

    Konumları adıma göre mod alıp MOD_BINS kutuya dağıtıyoruz. Rastgele
    dağılımda her kutu ~1/MOD_BINS alır; tek kutuda toplanıyorsa sıçramalar
    parça sınırlarına bağlı demektir.
    """
    import numpy as np

    if len(positions) == 0 or step <= 0:
        return {"step": int(step), "top_bin_share": 0.0, "expected": 1.0 / MOD_BINS}
    residues = np.asarray(positions) % step
    counts, _ = np.histogram(residues, bins=MOD_BINS, range=(0, step))
    best = int(np.argmax(counts))
    return {
        "step": int(step),
        "step_seconds": round(step / 44100.0, 3),
        "top_bin_share": round(float(counts.max() / counts.sum()), 3),
        "expected": round(1.0 / MOD_BINS, 3),
        "top_bin_offset_seconds": round(best * step / MOD_BINS / 44100.0, 3),
    }


def _variant_scale(mix, song_id: str):
    """Kaydedilen stem'ler clip_scale'e bölünmüş; ölçeği geri kestiriyoruz."""
    import numpy as np

    stems, samplerate = _load_stems(song_id)
    if not stems:
        return None, None, samplerate
    total = None
    for value in stems.values():
        total = value.copy() if total is None else total + value
    length = min(mix.shape[1], total.shape[1])
    denominator = float(np.sum(total[:, :length] ** 2))
    scale = (float(np.sum(mix[:, :length] * total[:, :length])) / denominator
             if denominator > 1e-12 else 1.0)
    return stems, scale, samplerate


@app.function(
    image=analysis_image,
    volumes={DATA_DIR: volume},
    timeout=1800,
    memory=8192,
)
def analyze_instrumental(song_id: str, variants: str = "a,c,cfp32,cov4,cboth,cinst,e") -> dict:
    """Her yöntemin "karışım - vokal" enstrümantalini ölçer.

    Vokal stem'leri DİSKTEN okunuyor, model yeniden çalıştırılmıyor.
    Karşılaştırma tabanı: orijinal htdemucs'un vokal DIŞI stem toplamı -
    yani "temiz" enstrümantalin nasıl göründüğü.
    """
    import numpy as np

    volume.reload()
    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    title = source_status.get("title") or song_id[:12]
    mix = _decode(_find_input(song_id), 44100, 2)
    samplerate = 44100

    report = {"song": song_id, "title": title, "instrumentals": {}}

    # Taban: orijinal htdemucs, vokal dışı stem'lerin toplamı.
    original_stems, original_scale, _ = _variant_scale(mix, song_id)
    if original_stems:
        base = None
        for name, value in original_stems.items():
            if name == "vocals":
                continue
            base = value.copy() if base is None else base + value
        candidates = {"orijinal(demucs toplami)": base * original_scale}
    else:
        candidates = {}

    # Adım geometrisi konfiglerden, tahminle değil.
    steps = {}
    for key, cfg_name in (("a", "melband_vocals.yaml"), ("c", "bs_roformer_sw.yaml")):
        path = pathlib.Path(EXP_WEIGHTS) / cfg_name
        if path.is_file():
            cfg = _load_config(path)
            chunk = int(cfg["audio"]["chunk_size"])
            steps[key] = {"chunk": chunk, "step2": chunk // 2, "step4": chunk // 4}

    for variant in [v.strip() for v in variants.split(",") if v.strip()]:
        target = f"{song_id}-{variant}"
        stems, scale, _ = _variant_scale(mix, target)
        if not stems or "vocals" not in stems:
            print(f"[atla] {target} yok")
            continue
        if variant.startswith("pd"):
            # Madde 7 varyantı: vokal HEP aynı SW çıktısı, yani "karışım -
            # vokal" hepsinde aynı olurdu. Fark piyano/davul çıkarmalarında;
            # duyulan şey "vokal kapalı" karışımı = vokal dışı stem toplamı.
            total = None
            for name, value in stems.items():
                if name == "vocals":
                    continue
                total = value.copy() if total is None else total + value
            candidates[variant] = total * scale
            continue
        vocals = stems["vocals"] * scale
        length = min(mix.shape[1], vocals.shape[1])
        candidates[variant] = mix[:, :length] - vocals[:, :length]

    for name, instrumental in candidates.items():
        mono = instrumental.mean(axis=0)
        diff = np.abs(np.diff(mono))
        order = np.argsort(diff)[-TOP_JUMPS:]
        entry = {
            "rms": round(float(np.sqrt(np.mean(mono.astype(np.float64) ** 2))), 5),
            "peak": round(float(np.abs(mono).max()), 4),
            "hf_share_8k": round(_hf_share(mono, samplerate), 4),
            "max_jump": round(float(diff.max()), 4),
            "p9999_jump": round(float(np.percentile(diff, 99.99)), 4),
            "jumps_over_threshold": int(np.count_nonzero(diff > CLICK_THRESHOLD)),
            "periodicity": [],
        }
        # Her iki modelin adımına göre periyodiklik sınaması.
        for key, geometry in steps.items():
            for label, step in (("overlap2", geometry["step2"]),
                                ("overlap4", geometry["step4"])):
                result = _periodicity(order, step)
                result["model"] = key
                result["mode"] = label
                entry["periodicity"].append(result)
        report["instrumentals"][name] = entry
        print(f"[{name}] rms={entry['rms']:.5f} tiz_pay={entry['hf_share_8k']:.4f} "
              f"max_sicrama={entry['max_jump']:.4f} n={entry['jumps_over_threshold']}")

    return report


@app.local_entrypoint()
def crackle(song_id: str = "", must_contain: str = "HAZBIN",
            variants: str = "a,c,cfp32,cov4,cboth,cinst,e"):
    """Cızırtının kaynağını ölç.

        modal run backend/experiment.py::crackle
    """
    if not song_id:
        songs = pick_songs.remote(count=1, must_contain=must_contain)
        if not songs:
            raise SystemExit("Sarki bulunamadi")
        song_id = songs[0]["id"]

    report = analyze_instrumental.remote(song_id, variants=variants)
    print("\n" + "=" * 96)
    print(f"ENSTRUMANTAL KARSILASTIRMASI - {report['title']}")
    print("=" * 96)
    print(f"{'kaynak':<26} {'rms':>8} {'tepe':>7} {'tiz>8k':>8} "
          f"{'max sic':>8} {'p99.99':>8} {'n>esik':>8}")
    for name, entry in report["instrumentals"].items():
        print(f"{name:<26} {entry['rms']:>8.5f} {entry['peak']:>7.3f} "
              f"{entry['hf_share_8k']:>8.4f} {entry['max_jump']:>8.4f} "
              f"{entry['p9999_jump']:>8.4f} {entry['jumps_over_threshold']:>8d}")

    print("\nSICRAMALAR PARCA SINIRLARINDA MI KUMELENIYOR?")
    print("(en buyuk sicramalarin konumu adima gore mod; rastgelede pay ~0.010)")
    for name, entry in report["instrumentals"].items():
        best = max(entry["periodicity"], key=lambda item: item["top_bin_share"])
        # Esik 0.25: sentetik sinamada YANLIS adimla bakildiginda pay 0.113'e
        # kadar cikabiliyor (adimlar ortak carpan tasiyor), dogru adimda ise
        # 1.0. 0.25 ikisini rahatca ayiriyor.
        flag = "KUMELENME VAR" if best["top_bin_share"] > 0.25 else "dagilmis"
        print(f"  {name:<26} en yuksek pay {best['top_bin_share']:.3f} "
              f"({best['model']}/{best['mode']}, adim {best['step_seconds']} sn) -> {flag}")


# --------------------------------------------------------------------------
# a) REFERANS KONTROLÜ: bizim _demix, MSST'nin demix'iyle aynı mı?
# --------------------------------------------------------------------------
# _demix'i MSST'nin generic dalına bakarak yazdık ama BİREBİR aynı olduğunu
# hiç kanıtlamadık. Cızırtı bizim kodumuzdan geliyorsa önce bunu bilmeliyiz.
# MSST'nin GERÇEK demix'ini aynı checkpoint ve ayarlarla çağırıp çıktıları
# örnek bazında karşılaştırıyoruz.

def _as_config_dict(config: dict):
    """MSST'nin demix'i ConfigDict bekliyor (config.audio.chunk_size gibi)."""
    from ml_collections import ConfigDict

    return ConfigDict(config)


@app.function(
    image=gpu_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=3600,
    max_containers=1,
)
def reference_check(song_id: str, seconds: float = 60.0) -> dict:
    """Bizim _demix ile MSST'nin demix'ini aynı girdide karşılaştırır.

    seconds: karşılaştırma için şarkının ilk N saniyesi (tam şarkı iki kez
    çıkarım demek; 60 sn fark olup olmadığını görmeye fazlasıyla yeter).
    """
    import sys

    import numpy as np
    import torch

    volume.reload()
    root = pathlib.Path(EXP_WEIGHTS)
    config = _load_config(root / "bs_roformer_sw.yaml")
    samplerate = int(config["audio"]["sample_rate"])
    channels = int(config["audio"]["num_channels"])

    model = _build_model("bs", config)
    _load_checkpoint(model, root / "bs_roformer_sw.ckpt", "cuda")

    mix = _decode(_find_input(song_id), samplerate, channels)
    if seconds > 0:
        mix = mix[:, : int(seconds * samplerate)]
    print(f"[ref] karsilastirma girdisi {mix.shape}")

    num_overlap = int(config.get("inference", {}).get("num_overlap", 2))

    ours, ours_nan = _demix(model, mix, config, num_overlap, True)
    print(f"[ref] bizimki bitti, nan={ours_nan}")

    if _msst_path() not in sys.path:
        sys.path.insert(0, _msst_path())
    from utils.model_utils import demix as msst_demix

    theirs = msst_demix(
        _as_config_dict(config), model, mix, torch.device("cuda"),
        model_type="bs_roformer", pbar=False,
    )
    # MSST sözlük döndürüyor (enstrüman -> dizi); bizimki (stem, kanal, n).
    names = list(config["training"]["instruments"])
    if isinstance(theirs, dict):
        theirs = np.stack([theirs[name] for name in names], axis=0)
    print(f"[ref] MSST bitti, bicim={theirs.shape}")

    report = {"song": song_id, "seconds": float(seconds), "stems": {}}
    length = min(ours.shape[-1], theirs.shape[-1])
    for index, name in enumerate(names):
        a = ours[index, ..., :length].astype(np.float64)
        b = theirs[index, ..., :length].astype(np.float64)
        diff = a - b
        ref_rms = float(np.sqrt(np.mean(b ** 2)))
        diff_rms = float(np.sqrt(np.mean(diff ** 2)))
        db = 20.0 * np.log10(diff_rms / ref_rms) if ref_rms > 0 and diff_rms > 0 else -999.0
        report["stems"][name] = {
            "max_abs_diff": round(float(np.abs(diff).max()), 6),
            "diff_db": round(float(db), 1),
            "ref_rms": round(ref_rms, 6),
        }
        print(f"[ref] {name:<7} maks fark={report['stems'][name]['max_abs_diff']:.6f} "
              f"fark={report['stems'][name]['diff_db']:.1f} dB")

    worst = max(report["stems"].values(), key=lambda item: item["diff_db"])
    report["worst_diff_db"] = worst["diff_db"]
    # -60 dB altı: kayan nokta gürültüsü, aynı sayılır. Üstü: gerçek fark.
    report["identical"] = bool(worst["diff_db"] < -60.0)
    print(f"[ref] SONUC: en kotu {worst['diff_db']:.1f} dB -> "
          f"{'AYNI' if report['identical'] else 'FARKLI'}")
    return report


# --------------------------------------------------------------------------
# c) E: vokal = A ve B vokallerinin ortalaması (ensemble)
# --------------------------------------------------------------------------

@app.function(
    image=gpu_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=3600,
    max_containers=1,
)
def run_e(song_id: str, num_overlap: int = 2, suffix: str = "e",
          label: str = "E") -> dict:
    """Vokali iki modelin ortalamasından alır.

    Gerekçe: BS-Roformer daha az sızıntı ama daha çok artefakt üretiyor
    (SIR/SAR takası); MelBand tersi. Ortalama ikisinin arasında bir yer
    tutuyor ve ensemble'ın artefaktı bastırması bekleniyor.

    Modeller SIRAYLA yükleniyor: ikisi birden T4'e sığar ama gerek yok,
    çıkarımdan sonra belleği bırakıp öbürünü alıyoruz.
    """
    global _FIRST_CALL
    import numpy as np
    import torch
    from demucs.pretrained import get_model

    wall_started = time.time()
    cold_seconds = round(time.time() - _CONTAINER_START, 2) if _FIRST_CALL else 0.0
    was_cold = _FIRST_CALL
    _FIRST_CALL = False

    volume.reload()
    root = pathlib.Path(EXP_WEIGHTS)
    config_a = _load_config(root / "melband_vocals.yaml")
    config_b = _load_config(root / "bs_roformer_sw.yaml")
    samplerate = int(config_a["audio"]["sample_rate"])
    channels = int(config_a["audio"]["num_channels"])
    if int(config_b["audio"]["sample_rate"]) != samplerate:
        raise ValueError("Iki vokal modeli ayni ornekleme hizinda degil")

    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    mix = _decode(_find_input(song_id), samplerate, channels)
    duration = round(mix.shape[1] / samplerate, 3)
    print(f"[decode] {mix.shape} -> {duration} sn")

    load_started = time.time()
    torch.cuda.reset_peak_memory_stats()
    stage1_started = time.time()

    melband = _build_model("melband", config_a)
    _load_checkpoint(melband, root / "melband_vocals.ckpt", "cuda")
    out_a, nan_a = _demix(melband, mix, config_a, num_overlap, True)
    vocals_a = out_a[0]
    del melband, out_a
    torch.cuda.empty_cache()
    print(f"[melband] bitti, nan={nan_a}")

    bs = _build_model("bs", config_b)
    _load_checkpoint(bs, root / "bs_roformer_sw.ckpt", "cuda")
    out_b, nan_b = _demix(bs, mix, config_b, num_overlap, True)
    names_b = list(config_b["training"]["instruments"])
    vocals_b = out_b[names_b.index("vocals")]
    del bs, out_b
    torch.cuda.empty_cache()
    print(f"[bs-roformer] bitti, nan={nan_b}")

    # Basit ortalama. Ağırlıklı ortalama da denenebilir ama önce düzünü
    # ölçelim; ağırlık seçmek tek şarkıya aşırı uyum riski taşıyor.
    vocals = (vocals_a + vocals_b) * 0.5
    agreement = _correlation(
        _downmix(vocals_a, CORR_RATE_DIVISOR), _downmix(vocals_b, CORR_RATE_DIVISOR)
    )
    stage1_seconds = round(time.time() - stage1_started, 2)
    vram_stage1 = _peak_vram()
    model_load_seconds = round(stage1_started - load_started, 2)
    print(f"[ensemble] iki vokal ilintisi={agreement} (1'e yakinsa modeller ayni seyi diyor)")

    demucs = get_model(MODEL_NAME)
    demucs.eval()
    demucs_sources = [str(name) for name in demucs.sources]
    instrumental = mix - vocals
    by_name, stage2_seconds, vram_stage2 = _demucs_stage(
        demucs, instrumental, demucs_sources
    )
    print(f"[demucs] {stage2_seconds} sn, {vram_stage2}")

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
    residual = _residual_report(mix, stems)
    print(f"[artik] {residual}")

    # Etiket BAŞTA: telefonda uzun isimlerin sonu görünmüyor.
    title = f"[{label}] {source_status.get('title') or song_id[:12]}"
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
        "tta": False,
        "precision": "fp16",
        "cold_start_seconds": cold_seconds,
        "was_cold": bool(was_cold),
        "model_load_seconds": model_load_seconds,
        "gpu_seconds": round(stage1_seconds + stage2_seconds, 2),
        "roformer_seconds": stage1_seconds,
        "demucs_seconds": stage2_seconds,
        "vocal_model_agreement": float(agreement),
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


@app.local_entrypoint()
def reference(song_id: str = "", must_contain: str = "HAZBIN",
              seconds: float = 60.0):
    """Bizim _demix, MSST'ninkiyle aynı mı?

        modal run backend/experiment.py::reference
    """
    if not song_id:
        songs = pick_songs.remote(count=1, must_contain=must_contain)
        if not songs:
            raise SystemExit("Sarki bulunamadi")
        song_id = songs[0]["id"]
    report = reference_check.remote(song_id, seconds=seconds)
    print("\n" + "=" * 80)
    print("REFERANS KONTROLU: bizim _demix vs MSST demix")
    print("=" * 80)
    for name, data in report["stems"].items():
        print(f"  {name:<8} maks fark {data['max_abs_diff']:.6f}   "
              f"fark {data['diff_db']:>7.1f} dB   (referans rms {data['ref_rms']:.5f})")
    print(f"\nEn kotu fark: {report['worst_diff_db']:.1f} dB")
    if report["identical"]:
        print("SONUC: AYNI (-60 dB alti = kayan nokta gurultusu).")
        print("Cizirti bizim chunk birlestirmemizden GELMIYOR.")
    else:
        print("SONUC: FARKLI. Chunk birlestirme suphelisi dogrulandi,")
        print("cizirtinin kaynagi once burada aranmali.")


@app.function(image=fetch_image, volumes={DATA_DIR: volume}, timeout=600)
def list_experiment_songs() -> list:
    """Deney çıktılarını bulur. Orijinal şarkılara DOKUNMAZ.

    Hedefleri `status.json`'daki `source_song` alanından buluyor, isim son
    ekinden DEĞİL: orijinal bir şarkının adı yanlışlıkla "-a" ile bitse
    bile silinmesin.
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
        source = data.get("source_song")
        if not source:
            continue        # orijinal şarkı, dokunulmuyor
        total = sum(f.stat().st_size for f in entry.rglob("*") if f.is_file())
        found.append({
            "id": str(data.get("id", entry.name)),
            "title": str(data.get("title") or entry.name),
            "source_song": str(source),
            "bytes": int(total),
        })
    return found


@app.function(image=fetch_image, volumes={DATA_DIR: volume}, timeout=600)
def delete_experiment_songs(ids: list) -> dict:
    """Verilen deney çıktılarını siler. Yalnız source_song'u olanlar."""
    volume.reload()
    removed = []
    for song_id in ids:
        status_path = _song_dir(song_id) / "status.json"
        if not status_path.is_file():
            continue
        data = json.loads(status_path.read_text(encoding="utf-8"))
        if not data.get("source_song"):
            print(f"[atla] {song_id} deney ciktisi degil")
            continue
        shutil.rmtree(_song_dir(song_id), ignore_errors=True)
        removed.append(song_id)
        print(f"[sil] {song_id}")
    volume.commit()
    return {"removed": removed, "count": len(removed)}


@app.function(image=fetch_image, volumes={DATA_DIR: volume}, timeout=300)
def stale_msst(delete: bool = False) -> dict:
    """Volume'da kalmış ÖLÜ MSST kopyasını bildirir, istenirse siler.

    MSST mimari dosyaları artık depoda (`backend/vendor/msst`) ve imaja
    `add_local_dir` ile giriyor; `_msst_path()` /msst'yi döndürüyor. Eski
    koşumlardan kalan `weights-exp/msst` hiçbir yerden okunmuyor.

    AĞIRLIKLARA DOKUNMUYOR (`bs_roformer_sw.ckpt`/`.yaml`,
    `melband_vocals.*`): deney yeniden koşarsa onlar gerekiyor ve 1.6 GB'ı
    tekrar indirmek anlamsız.
    """
    volume.reload()
    target = pathlib.Path(EXP_WEIGHTS) / "msst"
    if not target.is_dir():
        return {"exists": False, "path": str(target), "files": 0, "bytes": 0,
                "deleted": False}

    files = [item for item in target.rglob("*") if item.is_file()]
    report = {
        "exists": True,
        "path": str(target),
        "files": len(files),
        "bytes": int(sum(item.stat().st_size for item in files)),
        "deleted": False,
    }
    if delete:
        shutil.rmtree(target, ignore_errors=True)
        volume.commit()
        report["deleted"] = bool(not target.exists())
        print(f"[sil] {target} ({report['files']} dosya, {report['bytes']} bayt)")
    return report


@app.local_entrypoint()
def cleanup(yes: bool = False):
    """Deney çıktılarını ve Volume'daki ölü MSST kopyasını temizler.

        modal run backend/experiment.py::cleanup            # yalnız listeler
        modal run backend/experiment.py::cleanup --yes      # siler

    Orijinal şarkılara ve deney ağırlıklarına dokunmuyor.
    """
    found = list_experiment_songs.remote()
    stale = stale_msst.remote()

    print("")
    if found:
        total = sum(item["bytes"] for item in found)
        sources = {item["source_song"] for item in found}
        print(f"{len(found)} deney ciktisi bulundu ({total / 1024**2:.0f} MB):")
        print("")
        for item in found:
            print(f"  {item['id'][:20]:<22} {item['title'][:46]:<48} "
                  f"{item['bytes'] / 1024**2:>7.1f} MB")
        print("")
        print(f"  (kaynak sarkilar: {len(sources)} tane, DOKUNULMAYACAK)")
    else:
        print("Silinecek deney ciktisi yok.")

    if stale["exists"]:
        print("")
        print(f"Olu MSST kopyasi: {stale['path']}")
        print(f"  {stale['files']} dosya, {stale['bytes'] / 1024:.0f} KB - "
              "mimari dosyalar artik depodan (vendor/msst) geliyor, "
              "bu kopya hicbir yerden okunmuyor")
        print("  (deney agirliklari .ckpt/.yaml DOKUNULMAYACAK)")

    if not found and not stale["exists"]:
        print("")
        print("Temizlenecek bir sey yok.")
        return

    if not yes:
        print("")
        print("Silmek icin: modal run backend/experiment.py::cleanup --yes")
        return

    print("")
    if found:
        result = delete_experiment_songs.remote([item["id"] for item in found])
        print(f"{result['count']} deney klasoru silindi.")
    if stale["exists"]:
        done = stale_msst.remote(delete=True)
        print(f"Olu MSST kopyasi silindi: {done['deleted']}")


@app.local_entrypoint()
def fetch(check_mirror: bool = True):
    """modal run backend/experiment.py::fetch"""
    report = fetch_weights.remote(check_mirror=check_mirror)
    print("\n--- agirlik raporu ---")
    for key, value in report.items():
        print(f"{key}: {value}")

@app.local_entrypoint()
def main(count: int = 3, must_contain: str = "HAZBIN",
         methods: str = "a,b,c", song_id: str = ""):
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
                    # Kulak testinde ELENDİ (5 kat maliyet, tutarlı fark yok,
                    # bir şarkıda cızırtı); karşılaştırma için duruyor.
                    report = run_b.remote(item["id"], num_overlap=8, tta=True,
                                          suffix="bmax", label="B-max")
                elif method == "c":
                    report = run_c.remote(item["id"])
                # --- C'deki cızırtı için düzeltme adayları ---
                elif method == "cfp32":
                    report = run_c.remote(item["id"], fp32=True,
                                          suffix="cfp32", label="C-fp32")
                elif method == "cov4":
                    report = run_c.remote(item["id"], num_overlap=4,
                                          suffix="cov4", label="C-ov4")
                elif method == "cboth":
                    report = run_c.remote(item["id"], num_overlap=4, fp32=True,
                                          suffix="cboth", label="C-fp32-ov4")
                elif method == "cinst":
                    report = run_c.remote(item["id"], instrumental_from_model=True,
                                          suffix="cinst", label="C-inst")
                elif method == "e":
                    report = run_e.remote(item["id"])
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
    for method in ("A", "B", "C", "C-fp32", "C-ov4", "C-fp32-ov4",
                   "C-inst", "E", "B-max"):
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


# ==========================================================================
# MADDE 7 DENEYİ: piyano ve davul BS-Roformer SW'den (PLAN.md madde 7)
# ==========================================================================
# SW tek geçişte altı stem üretiyor; canlı yol yalnız vokali alıp kalanı
# atıyor. Burada piyano ve davul da SW'den alınıp enstrümantalden ÇIKARILIYOR:
#
#   V0  bugünkü canlı zincir:   demucs(karışım - vokal)
#   V1  piyano SW'den:          demucs(karışım - vokal - piyano)
#   V2  piyano + davul SW'den:  demucs(karışım - vokal - piyano - davul)
#
# Demucs'un SW'nin aldığı stem'lerle aynı isimli çıkışı ("artık" = SW'nin
# kaçırdığı) iki yere gidebilir: "p" aynı stem'e eklenir, "o" other'a eklenir.
# ÖNCE artığın RMS'i SW stem'ine göre ölçülür; vokal artığı (V0'daki, zaten
# kabul edilen yol) REFERANS. Artık referansın ALTINDAYSA yalnız "p" üretilir,
# büyükse o/p ikisi de. Demucs'un vokal artığı her zaman other'a (canlı gibi).
#
# Tüm metrikler 2 sn'lik pencerelerle; şarkı ortalaması + en kötü 5 pencere
# zaman damgasıyla. Kulak testi için etiketler NÖTR HARF; anahtar yalnız
# yerel pd_out/key.json'a yazılıyor (kulak testinden ÖNCE bakma).

PD_WINDOW_SEC = 2.0
PD_LOW_DIV = 4               # ilişki ölçümü 11025 Hz'de
PD_FLOOR = 1e-3              # bant enerjisi karışımın -30 dB altındaysa pencere geçersiz
PD_LETTERS = "KMPQTWXZ"
PD_OUT = pathlib.Path(__file__).resolve().parent / "pd_out"
PD_DEFAULT_SONGS = "Zeus,Below The Surface,HAZBIN,Final Duet,Nothing Else Matters"


def _pd_win(x, win: int):
    import numpy as np

    count = len(x) // win
    return np.asarray(x[:count * win], dtype=np.float64).reshape(count, win)


def _pd_energy(x, win: int):
    return (_pd_win(x, win) ** 2).sum(axis=1)


def _pd_dot(x, y, win: int):
    size = min(len(x), len(y))
    return (_pd_win(x[:size], win) * _pd_win(y[:size], win)).sum(axis=1)


def _pd_fmt(seconds: float) -> str:
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


def _pd_sos(sr: int) -> dict:
    from scipy.signal import butter

    fs_lo = sr / PD_LOW_DIV
    return {
        "lp": butter(4, 200, btype="low", fs=fs_lo, output="sos"),
        "bp": butter(4, [200, 4000], btype="band", fs=fs_lo, output="sos"),
        "hp": butter(4, 6000, btype="high", fs=sr, output="sos"),
    }


def _pd_features(stems: dict, mix, sr: int, sos: dict) -> dict:
    """Bir varyantın pencere bazlı özellikleri (ölçeklenmemiş stem'ler)."""
    import numpy as np
    from scipy.signal import sosfiltfilt

    win = int(PD_WINDOW_SEC * sr)
    win_lo = win // PD_LOW_DIV
    feats = {"energy": {}, "lo": {}, "mid": {}, "loE": {}, "hf": {}}
    clicks = None
    total = None
    for name, value in stems.items():
        total = value.copy() if total is None else total + value
        mono = value.mean(axis=0)
        feats["energy"][name] = _pd_energy(mono, win)
        flags = np.zeros(len(mono), dtype=np.float32)
        flags[1:] = np.abs(np.diff(mono)) > CLICK_THRESHOLD
        per_window = _pd_win(flags, win).sum(axis=1)
        clicks = per_window if clicks is None else clicks + per_window
        if name in ("bass", "piano", "drums"):
            small = _downmix(value, PD_LOW_DIV)
            feats["lo"][name] = sosfiltfilt(sos["lp"], small)
            feats["mid"][name] = sosfiltfilt(sos["bp"], small)
            feats["loE"][name] = _pd_energy(feats["lo"][name], win_lo)
        if name in ("drums", "other"):
            feats["hf"][name] = _pd_energy(sosfiltfilt(sos["hp"], mono), win)
    feats["clicks"] = clicks
    size = min(total.shape[1], mix.shape[1])
    feats["sumres"] = _pd_energy((mix[:, :size] - total[:, :size]).mean(axis=0), win)
    return feats


def _pd_mix_features(mix, sr: int, sos: dict) -> dict:
    from scipy.signal import sosfiltfilt

    win = int(PD_WINDOW_SEC * sr)
    win_lo = win // PD_LOW_DIV
    mono = mix.mean(axis=0)
    small = _downmix(mix, PD_LOW_DIV)
    return {
        "E": _pd_energy(mono, win),
        "loE": _pd_energy(sosfiltfilt(sos["lp"], small), win_lo),
        "midE": _pd_energy(sosfiltfilt(sos["bp"], small), win_lo),
        "hfE": _pd_energy(sosfiltfilt(sos["hp"], mono), win),
    }


def _pd_contain(x, y, mix_energy, win_lo: int):
    """<x,y>/<y,y>: y'nin ne kadarı x'in içinde. y sessizse pencere GEÇERSİZ (nan)."""
    import numpy as np

    xy = _pd_dot(x, y, win_lo)
    yy = _pd_energy(y, win_lo)
    size = min(len(xy), len(yy), len(mix_energy))
    out = np.full(size, np.nan)
    valid = yy[:size] > PD_FLOOR * mix_energy[:size]
    out[valid] = xy[:size][valid] / yy[:size][valid]
    return out


def _pd_metrics(base: dict, cand: dict, mixf: dict, sr: int) -> dict:
    """metrik -> (pencere dizisi, yüksek=kötü mü). Referans V0 (base)."""
    import numpy as np

    win_lo = int(PD_WINDOW_SEC * sr) // PD_LOW_DIV
    eps = 1e-20

    def db(num, den):
        return 10.0 * np.log10((num + eps) / (den + eps))

    table = {}
    size = min(len(cand["sumres"]), len(mixf["E"]))
    table["sum_residual_db"] = (db(cand["sumres"][:size], mixf["E"][:size]), True)

    bass_b, bass_c = base["loE"]["bass"], cand["loE"]["bass"]
    size = min(len(bass_b), len(bass_c), len(mixf["loE"]))
    delta = db(bass_c[:size], bass_b[:size])
    delta[~(bass_b[:size] > PD_FLOOR * mixf["loE"][:size])] = np.nan
    table["bass_low_delta_db"] = (delta, False)      # bas <200 Hz'i kaybederse KÖTÜ

    def stolen(stem: str):
        after = _pd_contain(cand["lo"][stem], base["lo"]["bass"], mixf["loE"], win_lo)
        before = _pd_contain(base["lo"][stem], base["lo"]["bass"], mixf["loE"], win_lo)
        count = min(len(after), len(before))
        return after[:count] - before[:count]

    table["bass_stolen_by_piano"] = (stolen("piano"), True)
    table["bass_stolen_by_drums"] = (stolen("drums"), True)

    after = _pd_contain(cand["mid"]["drums"], base["mid"]["piano"], mixf["midE"], win_lo)
    before = _pd_contain(base["mid"]["drums"], base["mid"]["piano"], mixf["midE"], win_lo)
    count = min(len(after), len(before))
    table["piano_in_drums"] = (after[:count] - before[:count], True)

    def ghost(feats):
        return db(feats["hf"]["other"], feats["hf"]["drums"])

    ghost_c, ghost_b = ghost(cand), ghost(base)
    size = min(len(ghost_c), len(ghost_b), len(mixf["hfE"]))
    hf_delta = ghost_c[:size] - ghost_b[:size]
    hf_delta[~(base["hf"]["drums"][:size] > PD_FLOOR * mixf["hfE"][:size])] = np.nan
    table["hf_ghost_delta_db"] = (hf_delta, True)     # other'da zil/hi-hat arttıysa KÖTÜ

    floor = 1e-4 * mixf["E"]
    size = min(len(cand["energy"]["piano"]), len(base["energy"]["piano"]), len(floor))
    table["piano_level_delta_db"] = (
        10.0 * np.log10((cand["energy"]["piano"][:size] + floor[:size])
                        / (base["energy"]["piano"][:size] + floor[:size])),
        True,                                          # şişen piyano = uydurma riski
    )
    size = min(len(cand["clicks"]), len(base["clicks"]))
    table["click_delta"] = (cand["clicks"][:size] - base["clicks"][:size], True)
    return table


def _pd_summarize(values, worse_higher: bool, k: int = 5) -> dict:
    import numpy as np

    arr = np.asarray(values, dtype=np.float64)
    ok = np.isfinite(arr)
    if not ok.any():
        return {"mean": None, "worst": [], "valid_windows": 0}
    key = np.where(ok, arr if worse_higher else -arr, -np.inf)
    order = [int(i) for i in np.argsort(-key)[:k] if ok[i]]
    return {
        "mean": round(float(np.mean(arr[ok])), 3),
        "valid_windows": int(ok.sum()),
        "worst": [{"t": _pd_fmt(i * PD_WINDOW_SEC), "value": round(float(arr[i]), 3)}
                  for i in order],
    }


def _pd_listen(tables: dict, mix_energy) -> dict:
    """Dinleme bölümleri: en kötü pencere + bir NORMAL pencere (medyana yakın)."""
    import numpy as np

    size = min(len(mix_energy), *(len(arr) for table in tables.values()
                                   for arr, _ in table.values()))
    composite = np.zeros(size)
    for table in tables.values():
        for arr, worse_higher in table.values():
            a = np.asarray(arr[:size], dtype=np.float64)
            ok = np.isfinite(a)
            if ok.sum() < 10:
                continue
            median = np.median(a[ok])
            spread = np.median(np.abs(a[ok] - median)) * 1.4826 + 1e-6
            z = (a - median) / spread
            z = z if worse_higher else -z
            composite = composite + np.where(ok, np.clip(z, 0, 30), 0)
    music = mix_energy[:size] > 0.05 * float(np.mean(mix_energy[:size]))
    if not music.any():
        return {}
    worst = int(np.argmax(np.where(music, composite, -1.0)))
    median_score = float(np.median(composite[music]))
    far = music & (np.abs(np.arange(size) - worst) * PD_WINDOW_SEC > 10.0)
    if far.any():
        normal = int(np.argmin(np.where(far, np.abs(composite - median_score), np.inf)))
    else:
        normal = worst
    return {
        "worst": {"t": _pd_fmt(worst * PD_WINDOW_SEC), "index": worst,
                  "score": round(float(composite[worst]), 2)},
        "normal": {"t": _pd_fmt(normal * PD_WINDOW_SEC), "index": normal,
                   "score": round(float(composite[normal]), 2)},
    }


def _pd_res_windows(residue, reference, mix_energy, sr: int):
    """Artık/SW-stem oranı (dB), pencere bazlı; SW stem'i sessizse nan."""
    import numpy as np

    win = int(PD_WINDOW_SEC * sr)
    res_e = _pd_energy(residue.mean(axis=0), win)
    ref_e = _pd_energy(reference.mean(axis=0), win)
    size = min(len(res_e), len(ref_e), len(mix_energy))
    out = 10.0 * np.log10((res_e[:size] + 1e-20) / (ref_e[:size] + 1e-20))
    out[~(ref_e[:size] > 1e-4 * mix_energy[:size])] = np.nan
    return out


def _pd_rms_db(residue, reference) -> float:
    import numpy as np

    res = float(np.sqrt(np.mean(residue.astype(np.float64) ** 2)))
    ref = float(np.sqrt(np.mean(reference.astype(np.float64) ** 2)))
    if ref <= 0 or res <= 0:
        return -999.0
    return round(20.0 * float(np.log10(res / ref)), 2)


@app.function(
    image=gpu_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=3600,
    max_containers=1,      # min_containers YOK
)
def run_pd(song_id: str, letters: str = PD_LETTERS) -> dict:
    """Bir şarkı için V0/V1/V2 çıkışları + ölçümler. SW BİR kez koşar."""
    import random

    import numpy as np
    import torch
    from demucs.pretrained import get_model

    wall_started = time.time()
    volume.reload()
    root = pathlib.Path(EXP_WEIGHTS)
    config = _load_config(root / "bs_roformer_sw.yaml")
    samplerate = int(config["audio"]["sample_rate"])
    channels = int(config["audio"]["num_channels"])

    load_started = time.time()
    roformer = _build_model("bs", config)
    _load_checkpoint(roformer, root / "bs_roformer_sw.ckpt", "cuda")
    demucs = get_model(MODEL_NAME)
    demucs.eval()
    demucs_sources = [str(name) for name in demucs.sources]
    if int(demucs.samplerate) != samplerate or int(demucs.audio_channels) != channels:
        raise ValueError("Ornekleme/kanal uyusmuyor (roformer/demucs)")
    load_seconds = round(time.time() - load_started, 2)

    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    title = str(source_status.get("title") or song_id[:12])
    mix = _decode(_find_input(song_id), samplerate, channels)
    duration = round(mix.shape[1] / samplerate, 3)
    print(f"[pd] {title}: {mix.shape} -> {duration} sn, model yukleme {load_seconds} sn")

    # --- SW: BİR geçiş, fp32 (canlı yol gibi). Yalnız 3 stem tutuluyor. ----
    started = time.time()
    out, _ = _demix(roformer, mix, config, 2, False)
    instruments = list(config["training"]["instruments"])
    sw = {name: out[instruments.index(name)].copy()
          for name in ("vocals", "piano", "drums")}
    sw_seconds = round(time.time() - started, 2)
    print(f"[pd] SW {sw_seconds} sn, stem sirasi={instruments}")
    del out, roformer
    torch.cuda.empty_cache()

    vocals, piano, drums = sw["vocals"], sw["piano"], sw["drums"]

    # --- demucs: üç enstrümantal --------------------------------------------
    stage_seconds = {}
    d0, stage_seconds["v0"], _ = _demucs_stage(
        demucs, mix - vocals, demucs_sources, True)
    d1, stage_seconds["v1"], _ = _demucs_stage(
        demucs, mix - vocals - piano, demucs_sources, True)
    d2, stage_seconds["v2"], _ = _demucs_stage(
        demucs, mix - vocals - piano - drums, demucs_sources, True)
    print(f"[pd] demucs sn: {stage_seconds}")

    sos = _pd_sos(samplerate)
    mixf = _pd_mix_features(mix, samplerate, sos)

    # --- ÖNCE artık ölçümü: yön kararı --------------------------------------
    residue = {
        "vocal_ref_db": _pd_rms_db(d0["vocals"], vocals),   # V0'daki (kabul edilmiş) referans
        "v1_piano_db": _pd_rms_db(d1["piano"], piano),
        "v2_piano_db": _pd_rms_db(d2["piano"], piano),
        "v2_drums_db": _pd_rms_db(d2["drums"], drums),
    }
    windows = {
        "vocal_ref": _pd_res_windows(d0["vocals"], vocals, mixf["E"], samplerate),
        "v1_piano": _pd_res_windows(d1["piano"], piano, mixf["E"], samplerate),
        "v2_piano": _pd_res_windows(d2["piano"], piano, mixf["E"], samplerate),
        "v2_drums": _pd_res_windows(d2["drums"], drums, mixf["E"], samplerate),
    }
    reference = residue["vocal_ref_db"]
    # Referans yalnız SW vokali gerçekten doluysa anlamlı. Vokalsiz şarkıda
    # (Final Duet: vokal tepesi 0.0001) oran +54 dB çıkıyor, bu artık değil
    # bölme gürültüsü. O durumda karar KOYMUYORUZ: iki yön de üretilir.
    voc_rms = float(np.sqrt(np.mean(vocals.astype(np.float64) ** 2)))
    mix_rms = float(np.sqrt(np.mean(mix.astype(np.float64) ** 2)))
    reference_valid = voc_rms > 10 ** (-40 / 20) * mix_rms
    residue["vocal_ref_valid"] = bool(reference_valid)
    if reference_valid:
        v1_both = residue["v1_piano_db"] > reference
        v2_both = max(residue["v2_piano_db"], residue["v2_drums_db"]) > reference
    else:
        v1_both = v2_both = True
    print(f"[pd] artik dB (SW stem'ine gore): {residue}  -> "
          f"V1 {'o+p' if v1_both else 'p'}, V2 {'o+p' if v2_both else 'p'}")

    def assemble(kind: str, route: str) -> dict:
        if kind == "V0":
            d = d0
            return {"vocals": vocals, "drums": d["drums"], "bass": d["bass"],
                    "guitar": d["guitar"], "piano": d["piano"],
                    "other": d["other"] + d["vocals"]}
        same = route == "p"
        if kind == "V1":
            d = d1
            return {"vocals": vocals, "drums": d["drums"], "bass": d["bass"],
                    "guitar": d["guitar"],
                    "piano": piano + d["piano"] if same else piano,
                    "other": d["other"] + d["vocals"] + (0.0 if same else d["piano"])}
        d = d2
        return {"vocals": vocals, "bass": d["bass"], "guitar": d["guitar"],
                "piano": piano + d["piano"] if same else piano,
                "drums": drums + d["drums"] if same else drums,
                "other": d["other"] + d["vocals"]
                + (0.0 if same else d["piano"] + d["drums"])}

    plan = [("V0", "-"), ("V1", "p")]
    if v1_both:
        plan.append(("V1", "o"))
    plan.append(("V2", "p"))
    if v2_both:
        plan.append(("V2", "o"))
    names = [kind if route == "-" else f"{kind}{route}" for kind, route in plan]

    # --- 1. geçiş: ortak ölçek + özellikler (bellek: tek varyant canlı) -----
    peaks, feats, sum_res = {}, {}, {}
    for (kind, route), name in zip(plan, names):
        stems = assemble(kind, route)
        peaks[name] = max(float(np.abs(value).max()) for value in stems.values())
        feats[name] = _pd_features(stems, mix, samplerate, sos)
        sum_res[name] = _residual_report(mix, stems)
        del stems
    clip_scale = max(1.01 * max(peaks.values()), 1.0)
    print(f"[pd] ortak clip_scale={clip_scale:.4f}, "
          f"tepeler={ {k: round(v, 3) for k, v in peaks.items()} }")

    # --- ölçümler (V0 referans) ---------------------------------------------
    tables = {name: _pd_metrics(feats["V0"], feats[name], mixf, samplerate)
              for name in names if name != "V0"}
    metrics = {
        name: {metric: _pd_summarize(arr, worse_higher)
               for metric, (arr, worse_higher) in table.items()}
        for name, table in tables.items()
    }
    listen = _pd_listen(tables, mixf["E"])
    residue_windows = {key: _pd_summarize(arr, True) for key, arr in windows.items()}
    piano_level_db = {
        name: round(float(10 * np.log10((feats[name]["energy"]["piano"].sum() + 1e-20)
                                        / (mixf["E"].sum() + 1e-20))), 2)
        for name in names
    }

    # --- 2. geçiş: yaz (nötr harf etiketiyle) -------------------------------
    pool = list(letters)
    random.SystemRandom().shuffle(pool)
    key = {}
    written_ids = {}
    for (kind, route), name in zip(plan, names):
        letter = pool.pop()
        target_id = f"{song_id}-pd{letter.lower()}"
        key[letter] = name
        written_ids[letter] = target_id
        _write_outputs(target_id, f"[{letter}] {title}", assemble(kind, route),
                       samplerate, channels, duration, song_id,
                       meta={"pd": True, "clip_scale": round(clip_scale, 6)},
                       clip_scale=clip_scale)
        print(f"[pd] yazildi: [{letter}] -> {target_id}")

    wall_seconds = round(time.time() - wall_started, 2)
    report = {
        "song": song_id, "title": title, "duration": duration,
        "instruments": instruments,
        "sw_seconds": sw_seconds, "stage_seconds": stage_seconds,
        "wall_seconds": wall_seconds,
        "usd": round(wall_seconds * T4_USD_PER_SECOND, 4),
        "clip_scale": round(clip_scale, 4),
        "residue_db": residue,
        "residue_windows": residue_windows,
        "routing": {"V1": "o+p" if v1_both else "p", "V2": "o+p" if v2_both else "p"},
        "variants": names,
        "sum_residual": {name: sum_res[name] for name in names},
        "piano_level_db_vs_mix": piano_level_db,
        "metrics": metrics,
        "listen": listen,
        "key": key,
        "ids": written_ids,
    }
    return json.loads(json.dumps(report, default=float))


@app.function(image=fetch_image, volumes={DATA_DIR: volume}, timeout=120)
def find_songs(needles: list) -> dict:
    """Başlıkta geçen ada göre KAYNAK şarkıları bulur (deney çıktıları elenir)."""
    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    library = []
    for entry in sorted(root.iterdir()) if root.is_dir() else []:
        status_path = entry / "status.json"
        if not status_path.is_file():
            continue
        try:
            data = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("state") != "done" or data.get("source_song"):
            continue
        if not sorted(entry.glob("input.*")):
            continue
        library.append({"id": str(data.get("id", entry.name)),
                        "title": str(data.get("title") or entry.name[:12]),
                        "duration": float(data.get("duration") or 0.0)})
    found = {}
    for needle in needles:
        low = needle.lower()
        found[needle] = [item for item in library if low in item["title"].lower()]
    return {"library": library, "found": found}


@app.local_entrypoint()
def pd_run(songs: str = PD_DEFAULT_SONGS, dry: bool = False):
    """Madde 7 deneyi.

        modal run backend/experiment.py::pd_run --dry     # yalniz sarki eslemesi
        modal run backend/experiment.py::pd_run           # kosturur

    Sonuclar pd_out/<sarki>.json, anahtar pd_out/key.json (KULAK TESTINDEN
    ONCE ACMA). Kitapliktaki etiketler notr harf: [K], [M], ...
    """
    needles = [item.strip() for item in songs.split(",") if item.strip()]
    lookup = find_songs.remote(needles)
    chosen, problems = [], []
    for needle in needles:
        matches = lookup["found"][needle]
        if len(matches) == 1:
            chosen.append(matches[0])
        else:
            problems.append((needle, matches))

    print("\nKitapliktaki kaynak sarkilar:")
    for item in lookup["library"]:
        print(f"  {item['id'][:12]}  {item['duration']:>6.0f} sn  {item['title']}")
    print("\nEsleme:")
    for needle in needles:
        matches = lookup["found"][needle]
        label = ", ".join(f"{m['title']} ({m['duration']:.0f} sn)" for m in matches) or "YOK"
        print(f"  {needle:<24} -> {label}")
    if problems:
        raise SystemExit("\nBelirsiz ya da eksik eslesme var; --songs ile daha ozel ad ver "
                         "ya da eksik sarkiyi yukle.")
    if dry:
        return

    PD_OUT.mkdir(exist_ok=True)
    key_path = PD_OUT / "key.json"
    keys = json.loads(key_path.read_text("utf-8")) if key_path.is_file() else {}
    total_usd = 0.0
    for item in chosen:
        print(f"\n--- {item['title']} ---")
        report = run_pd.remote(item["id"])
        total_usd += report["usd"]
        slug = "".join(ch if ch.isalnum() else "_" for ch in item["title"])[:40]
        keys[item["id"]] = {"title": item["title"], "key": report.pop("key"),
                            "ids": report.pop("ids")}
        (PD_OUT / f"{slug}.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        key_path.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
        _print_pd(report)
    print(f"\nToplam ~${total_usd:.3f}. Anahtar {key_path} (kulak testinden once acma).")


def _print_pd(report: dict):
    print(f"\n{report['title']}  ({report['duration']:.0f} sn)  ${report['usd']:.4f}  "
          f"SW {report['sw_seconds']} sn, demucs {report['stage_seconds']}")
    print(f"  stem sirasi: {report['instruments']}")
    print(f"  artik dB (SW stem'ine gore): {report['residue_db']}")
    print(f"  yon: {report['routing']}   ortak clip_scale {report['clip_scale']}")
    print("  toplam artigi dB: "
          + ", ".join(f"{k}={v['residual_db']}" for k, v in report["sum_residual"].items()))
    print(f"  piyano/karisim dB: {report['piano_level_db_vs_mix']}")
    for name, table in report["metrics"].items():
        print(f"  [{name}] (V0'a gore)")
        for metric, summary in table.items():
            worst = ", ".join(f"{w['t']}={w['value']}" for w in summary["worst"])
            print(f"      {metric:<24} ort={summary['mean']}  en kotu: {worst}")
    print(f"  dinleme: {report['listen']}")


# --------------------------------------------------------------------------
# Kulak testi kesitleri: her harf için yalnız dinleme bölümleri
# --------------------------------------------------------------------------
# Dinleme bölümleri (normal + en kötü pencere) DİSKTEKİ FLAC master'lardan
# yeniden hesaplanıyor: böylece GPU'suz ve run_pd'den bağımsız; eski koşumlar
# (Zeus, Final Duet) da aynı yöntemle işleniyor. Her bölüm pencerenin çevresinde
# EXCERPT_SECONDS uzunluğunda, aralarında 1 sn sessizlik, kenarlarda 20 ms
# fade (aksi halde kesim yerlerinde tık olur). Harfler tam sürümle AYNI:
# kesit id'si `<id>-pd<harf>s`.

EXCERPT_SECONDS = 10.0
EXCERPT_GAP = 1.0
EXCERPT_FADE = 0.020

excerpt_image = modal.Image.debian_slim(python_version="3.11").apt_install(
    "ffmpeg"
).pip_install("numpy==1.26.4", "scipy==1.13.1", "soundfile==0.13.1")


def _pd_segment_start(center: float, total: float) -> float:
    return max(0.0, min(center - EXCERPT_SECONDS * 0.4, total - EXCERPT_SECONDS))


@app.function(
    image=excerpt_image,
    volumes={DATA_DIR: volume},
    timeout=1800,
    memory=16384,
)
def pd_excerpt_song(song_id: str, variants: dict, letters: dict) -> dict:
    """variants: {V0/V1p/...: hedef_id}; letters: {V0/V1p/...: harf}."""
    import numpy as np

    volume.reload()
    source_status = json.loads((_song_dir(song_id) / "status.json").read_text("utf-8"))
    title = str(source_status.get("title") or song_id[:12])

    def scale_of(target: str) -> float:
        data = json.loads((_song_dir(target) / "status.json").read_text("utf-8"))
        return float((data.get("experiment") or {}).get("clip_scale", 1.0))

    stems0, samplerate = _load_stems(variants["V0"])
    del stems0
    mix = _decode(_find_input(song_id), samplerate, 2)
    total = mix.shape[1] / samplerate
    sos = _pd_sos(samplerate)
    mixf = _pd_mix_features(mix, samplerate, sos)

    feats = {}
    for name, target in variants.items():
        stems, _ = _load_stems(target)
        scale = scale_of(target)
        feats[name] = _pd_features({k: v * scale for k, v in stems.items()},
                                   mix, samplerate, sos)
        del stems
    tables = {name: _pd_metrics(feats["V0"], feats[name], mixf, samplerate)
              for name in variants if name != "V0"}
    listen = _pd_listen(tables, mixf["E"])
    if not listen:
        raise ValueError("Dinleme bolumu secilemedi (sessiz sarki?)")

    centers = {kind: listen[kind]["index"] * PD_WINDOW_SEC + PD_WINDOW_SEC / 2
               for kind in ("normal", "worst")}
    starts = {kind: _pd_segment_start(center, total) for kind, center in centers.items()}
    length = int(EXCERPT_SECONDS * samplerate)
    gap = np.zeros((2, int(EXCERPT_GAP * samplerate)), dtype=np.float32)
    fade = int(EXCERPT_FADE * samplerate)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)

    def cut(stem):
        pieces = []
        for kind in ("normal", "worst"):
            begin = int(starts[kind] * samplerate)
            piece = stem[:, begin:begin + length].copy()
            if piece.shape[1] > 2 * fade:
                piece[:, :fade] *= ramp
                piece[:, -fade:] *= ramp[::-1]
            pieces.append(piece)
            if kind == "normal":
                pieces.append(gap)
        return np.concatenate(pieces, axis=1)

    ids = {}
    excerpt_seconds = None
    for name, target in variants.items():
        stems, _ = _load_stems(target)          # FLAC alanı: tam sürümle AYNI seviye
        short = {key: cut(value) for key, value in stems.items()}
        del stems
        letter = letters[name]
        excerpt_id = f"{song_id}-pd{letter.lower()}s"
        excerpt_seconds = short["bass"].shape[1] / samplerate
        _write_outputs(excerpt_id, f"[{letter} kisa] {title}", short, samplerate, 2,
                       round(excerpt_seconds, 3), song_id,
                       meta={"pd": "excerpt", "clip_scale": 1.0},
                       clip_scale=1.0, copy_analysis=False)
        ids[letters[name]] = excerpt_id
        print(f"[kesit] [{letter}] -> {excerpt_id} ({excerpt_seconds:.1f} sn)")

    return {
        "title": title, "duration": round(total, 1),
        "excerpt_seconds": round(float(excerpt_seconds), 1),
        "segments": {
            kind: {"full_start": _pd_fmt(starts[kind]),
                   "full_end": _pd_fmt(starts[kind] + EXCERPT_SECONDS),
                   "window": listen[kind]["t"], "score": listen[kind]["score"]}
            for kind in ("normal", "worst")
        },
        "excerpt_ids": ids,
    }


SHEET_CHECKS = (
    ("hepsi acik", "Tum kanallar acik. Cizirti, tik, ses bosluklari, denge bozuklugu?"),
    ("piyano solo", "Yalniz piyano. Baska bir sey (bas, gitar, davul, vokal) karisiyor mu? "
                    "Piyanonun bir kismi eksik mi?"),
    ("piyano kapali", "Piyano MUTE, gerisi acik. Piyanodan iz (hayalet) kaliyor mu?"),
    ("davul solo", "Yalniz davul. Baska bir sey (ozellikle bas/808, piyano) var mi? "
                   "Zil/hi-hat eksik mi?"),
    ("davul kapali", "Davul MUTE, gerisi acik. Zil/hi-hat/kick izi (hayalet) kaliyor mu?"),
    ("bas solo", "Yalniz bas. Bas gercekten var mi, yoksa ince/bos mu? "
                 "Baska bir sey karisiyor mu?"),
)


def _pd_sheet(title: str, result: dict) -> str:
    seg = result["segments"]
    letters = sorted(result["excerpt_ids"])
    normal_len = EXCERPT_SECONDS
    lines = [
        f"# Dinleme kagidi: {title}",
        "",
        f"Kitapliktaki `[X kisa]` sarkilari ({len(letters)} harf: {', '.join(letters)}) "
        f"her biri {result['excerpt_seconds']:.0f} sn.",
        "",
        "| kesit ici | bolum | tam surumde |",
        "|---|---|---|",
        f"| 0:00 - 0:{normal_len:04.1f} | 1. bolum (normal) | "
        f"{seg['normal']['full_start']} - {seg['normal']['full_end']} |",
        f"| 0:{normal_len:04.1f} - 0:{normal_len + EXCERPT_GAP:04.1f} | sessizlik | |",
        f"| 0:{normal_len + EXCERPT_GAP:04.1f} - 0:{result['excerpt_seconds']:04.1f} "
        f"| 2. bolum (en kotu pencere) | {seg['worst']['full_start']} - "
        f"{seg['worst']['full_end']} |",
        "",
        "Her kontrolde ayni sirayla butun harfleri dinle (ayni kanal ayarlari, ayni ses "
        "seviyesi). Harfleri kendi sirana gore dinleyebilirsin.",
        "",
        "| # | kontrol | ne dinlenir | EN IYI harf | BELIRGIN KUSURLU harfler | kusur hangi bolumde (1/2) |",
        "|---|---|---|---|---|---|",
    ]
    for number, (check, hint) in enumerate(SHEET_CHECKS, start=1):
        lines.append(f"| {number} | {check} | {hint} | | | |")
    lines += ["", "Not (serbest):", "", ""]
    return "\n".join(lines)


@app.local_entrypoint()
def pd_excerpts(songs: str = ""):
    """Kesit sürümleri + dinleme kağıtları.

        modal run backend/experiment.py::pd_excerpts

    pd_out/key.json'daki her şarkı için (ya da `songs` ile süzülmüş). Kağıtlar
    pd_out/sheets/ altında; harflerin NE OLDUĞUNU içermiyor.
    """
    key_path = PD_OUT / "key.json"
    if not key_path.is_file():
        raise SystemExit("pd_out/key.json yok; once pd_run calistir.")
    keys = json.loads(key_path.read_text("utf-8"))
    needles = [item.strip().lower() for item in songs.split(",") if item.strip()]
    sheets = PD_OUT / "sheets"
    sheets.mkdir(parents=True, exist_ok=True)

    for song_id, entry in keys.items():
        if needles and not any(n in entry["title"].lower() for n in needles):
            continue
        variants = {name: entry["ids"][letter] for letter, name in entry["key"].items()}
        letters = {name: letter for letter, name in entry["key"].items()}
        print(f"\n--- {entry['title']} ---")
        result = pd_excerpt_song.remote(song_id, variants, letters)
        entry["excerpt_ids"] = result["excerpt_ids"]
        key_path.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
        slug = "".join(ch if ch.isalnum() else "_" for ch in entry["title"])[:40]
        (sheets / f"{slug}.md").write_text(_pd_sheet(entry["title"], result), encoding="utf-8")
        seg = result["segments"]
        print(f"  1. bolum {seg['normal']['full_start']}-{seg['normal']['full_end']}, "
              f"2. bolum {seg['worst']['full_start']}-{seg['worst']['full_end']}, "
              f"kesit {result['excerpt_seconds']} sn")
    print(f"\nKagitlar: {sheets}")


# --------------------------------------------------------------------------
# Cızırtı: stem'e GÖRELİ darbe sayacı (kulak testi Zeus sonrası)
# --------------------------------------------------------------------------
# `::crackle`'ın eşiği MUTLAK (0.25): bas stem'inin tepesi 0.025, yani orada
# hiçbir şey yakalayamaz. Burada eşik yerel gürültü tabanına göre: ikinci fark
# (d2) blok başına medyan-mutlak-sapma ile ölçekleniyor, 12 katını aşan
# örnekler "darbe". Kulak testinde duyulan cızırtı (bas/piyano solo) bu ölçüyle
# aranıyor. Karışımın (girdi) kendisi de ölçülüyor: cızırtı şarkıda zaten
# varsa karışımda da görünür.

PD_IMPULSE_BLOCK = 2048
PD_IMPULSE_Z = 12.0


def _pd_impulses(mono, sr: int):
    """2 sn'lik pencere başına darbe sayısı (yerel MAD'e göre)."""
    import numpy as np

    d2 = np.diff(mono.astype(np.float64), n=2)
    blocks = len(d2) // PD_IMPULSE_BLOCK
    if blocks == 0:
        return np.zeros(0)
    shaped = d2[:blocks * PD_IMPULSE_BLOCK].reshape(blocks, PD_IMPULSE_BLOCK)
    global_rms = float(np.sqrt(np.mean(d2 ** 2))) + 1e-12
    scale = np.maximum(np.median(np.abs(shaped), axis=1) * 1.4826, 1e-3 * global_rms)
    flagged = (np.abs(shaped) / scale[:, None]) > PD_IMPULSE_Z
    positions = np.flatnonzero(flagged.ravel())
    win = int(PD_WINDOW_SEC * sr)
    count = len(mono) // win
    return np.bincount(np.minimum(positions // win, count - 1), minlength=count)[:count]


@app.function(image=excerpt_image, volumes={DATA_DIR: volume}, timeout=1800, memory=8192)
def pd_crackle_song(song_id: str, targets: dict, regions: list) -> dict:
    """targets: {harf: hedef_id}; regions: [[baslangic_sn, bitis_sn], ...]."""
    import numpy as np
    from scipy.signal import butter, sosfiltfilt

    volume.reload()
    mix = _decode(_find_input(song_id), 44100, 2)
    sr = 44100
    hp = butter(4, 2000, btype="high", fs=sr, output="sos")

    def summarize(counts, hf_share=None):
        def span(lo, hi):
            a, b = int(lo // PD_WINDOW_SEC), int(np.ceil(hi / PD_WINDOW_SEC))
            return int(counts[a:b].sum())
        entry = {"total": int(counts.sum()),
                 "regions": {f"{lo:g}-{hi:g}": span(lo, hi) for lo, hi in regions}}
        if hf_share is not None:
            entry["hf2k_share"] = {
                "all": round(float(np.mean(hf_share)), 5),
                **{f"{lo:g}-{hi:g}": round(float(np.mean(
                    hf_share[int(lo // PD_WINDOW_SEC):int(np.ceil(hi / PD_WINDOW_SEC))])), 5)
                   for lo, hi in regions}}
        return entry

    report = {"mix": summarize(_pd_impulses(mix.mean(axis=0), sr)), "letters": {}}
    for letter, target in targets.items():
        stems, _ = _load_stems(target)
        row = {}
        for name in ("bass", "piano"):
            mono = stems[name].mean(axis=0)
            energy = _pd_energy(mono, int(PD_WINDOW_SEC * sr))
            high = _pd_energy(sosfiltfilt(hp, mono), int(PD_WINDOW_SEC * sr))
            share = high / np.maximum(energy, 1e-12)
            row[name] = summarize(_pd_impulses(mono, sr), share)
        report["letters"][letter] = row
        del stems
    return json.loads(json.dumps(report, default=float))


@app.local_entrypoint()
def pd_crackle(song: str = "Zeus", regions: str = "0-10,145-160"):
    """Harf başına stem'e göreli darbe sayısı (bas + piyano) ve karışım.

        modal run backend/experiment.py::pd_crackle --song Zeus
    """
    keys = json.loads((PD_OUT / "key.json").read_text("utf-8"))
    matches = [(sid, item) for sid, item in keys.items()
               if song.lower() in item["title"].lower()]
    if len(matches) != 1:
        raise SystemExit(f"'{song}' icin {len(matches)} eslesme")
    song_id, entry = matches[0]
    spans = [[float(x) for x in part.split("-")] for part in regions.split(",")]
    report = pd_crackle_song.remote(song_id, dict(entry["ids"]), spans)
    labels = list(report["mix"]["regions"])
    print(f"\n{entry['title']}  (darbe sayilari; bolge: {', '.join(labels)} sn)")
    print(f"{'kaynak':<12}{'toplam':>8}" + "".join(f"{lab:>12}" for lab in labels))
    mix = report["mix"]
    print(f"{'karisim':<12}{mix['total']:>8}"
          + "".join(f"{mix['regions'][lab]:>12}" for lab in labels))
    for stem in ("bass", "piano"):
        print(f"\n{stem} stem'i  (darbe: toplam / bolgeler | >2 kHz enerji payi: tumu / bolgeler)")
        for letter, row in sorted(report["letters"].items()):
            item = row[stem]
            hf = item["hf2k_share"]
            print(f"  {letter:<8}{item['total']:>8}"
                  + "".join(f"{item['regions'][lab]:>12}" for lab in labels)
                  + f"   | {hf['all']:.5f}" + "".join(f" {hf[lab]:.5f}" for lab in labels))
