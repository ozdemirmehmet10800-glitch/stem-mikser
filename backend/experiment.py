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


@app.local_entrypoint()
def fetch(check_mirror: bool = True):
    """modal run backend/experiment.py::fetch"""
    report = fetch_weights.remote(check_mirror=check_mirror)
    print("\n--- agirlik raporu ---")
    for key, value in report.items():
        print(f"{key}: {value}")
