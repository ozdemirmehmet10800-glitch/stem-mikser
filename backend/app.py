"""Stem Mikser - Modal uygulaması.

Aşama 1: htdemucs_6s ile 6 kanallı ayrıştırma.

Yerel test:
    modal run backend/app.py --path sarki.mp3

Önemli: torch/numpy/soundfile gibi paketler YEREL ortamda kurulu değil.
Bu yüzden ağır importlar yalnızca uzak fonksiyonların içinde yapılır ve
uzak fonksiyonlar yerel entrypoint'e sadece düz Python tipleri döndürür
(PLAN.md kuralı).
"""

import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse

import modal

APP_NAME = "stem-mikser"
VOLUME_NAME = "stems-vol"
DATA_DIR = "/data"
WEIGHTS_DIR = "/weights"
MODEL_NAME = "htdemucs_6s"

MAX_UPLOAD_BYTES = 30 * 1024 * 1024  # 30 MB
MAX_DURATION_SEC = 10 * 60  # 10 dakika

# Telefona giden oynatma dosyaları.
#
# 256k: 160k'dan yükseltildi. Mikserde altı kayıplı akış ÜST ÜSTE toplanıyor
# ve bir stem solo yapıldığında onun kendi artefaktını maskeleyecek başka
# sinyal kalmıyor - tek bir akış dinlemekten daha zorlayıcı bir kullanım.
#
# 48 kHz: telefonun (ve çoğu Android cihazın) doğal çıkış hızı 48 kHz -
# ölçüldü. Dosyalar 44.1 kHz olunca decodeAudioData her açılışta yeniden
# örnekliyordu; 48 kHz'e sunucuda bir kez, iyi bir yeniden örnekleyiciyle
# (mümkünse soxr) geçmek hem o işi kaldırıyor hem açılışı hızlandırıyor.
# FLAC ASILLAR 44.1 kHz KALIYOR: model oradan çıkıyor, asıl kayıt o.
AAC_BITRATE = "256k"
STEM_SAMPLE_RATE = 48000
FLAC_SUBTYPE = "PCM_24"  # 24-bit kayıpsız master

# --- Aşama 9: Hi-Fi vokal yolu ------------------------------------------
# MSST (ZFTurbo, MIT) mimari dosyaları DEPODA: backend/vendor/msst/.
# Eskiden build sırasında curl ile iniyorlardı; temel imajda curl olmadığı
# için build patlıyordu (exit 127) ve build'in ağa bağlı olmasının pinli bir
# commit'te hiçbir faydası yok. Lisans/commit/yama notu: vendor/msst/README.md.
MSST_SHA = "84b1eac0887756b4f1a9d7a1ff49105939749ed2"
MSST_DIR = "/msst"
MSST_LOCAL = str(pathlib.Path(__file__).resolve().parent / "vendor" / "msst")
# Ağırlık aynası. Orijinal sahip (jarredou) HF hesabini silmis; bu kopya
# birebir ayni dosya (sha256 asagida). Ayrintili lisans notu NOTICE.md'de.
HIFI_CKPT_URL = ("https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/"
                 "a443a2985534b3bc815ef54a5d446c6a0390f974/BS-Rofo-SW-Fixed.ckpt")
HIFI_YAML_URL = ("https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/"
                 "a443a2985534b3bc815ef54a5d446c6a0390f974/BS-Rofo-SW-Fixed.yaml")

# --- Aşama 2: analiz parametreleri --------------------------------------
ANALYSIS_SR = 22050  # librosa'nın chroma_cqt varsayılanı
HOP_LENGTH = 512
BEATS_PER_BAR = 4  # 4/4 varsayımı
# Akor KALİTESİNİ belirleyen stem'ler: drums, vocals VE bass hariç.
# Bass dışarıda, çünkü evrik akorlarda (Ab/C) bas kökü yanlış gösteriyor:
# Ab majör C üzerinde çalındığında bas C'yi işaret edip akoru C/Cm okutuyordu.
QUALITY_STEMS = ("piano", "guitar", "other")
# Enerji kapısı ve librosa yedek beat takibi için kullanılan tam harmonik karışım
HARMONIC_STEMS = ("bass", "piano", "guitar", "other")
BASS_STEM = "bass"

NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
FLAT_NAMES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
NO_CHORD = "N"

# Bas chroma'daki kök ağırlığının şablon skoruna katkısı. 0.4 iken evrik
# akorları bozuyordu (Ab/C -> C), 0.0 iken de kalite hataları çıktı: referansta
# Eb olan yerde Ab/Eb, Fm olan yerde Db/F. 0.15 bas=kök yorumunu hafifçe
# destekliyor ama evriği ezmiyor.
ROOT_WEIGHT = 0.15
# Slash akor cezası: evrik akorlar kök konumundan çok daha nadir. Slash
# yalnızca ÜST stem'ler kök konumu yorumuna açıkça karşı çıkıyorsa yazılır -
# yani üst stem'lerde bas notasının ağırlığı kökün ağırlığını bu kadar
# aşıyorsa. Ceza olmadan akorların %23'ü slash çıkıyordu.
SLASH_PENALTY = 0.12
# Tona diyatonik akorlara verilen küçük sabit bonus. Skorlar birbirine yakınsa
# (üçlü zayıf) kararı çevirir, üçlü netse çeviremez - "üçlü zayıfken diyatonik
# akora öncelik ver" davranışı buradan çıkıyor. Fm yerine F okunması bu vaka.
KEY_WEIGHT = 0.08
# Viterbi geçiş matrisinde kendinde kalma olasılığı (akorlar yapışkan olsun)
SELF_TRANSITION = 0.85
# Benzerlikleri olasılığa çevirirken keskinleştirme üssü.
# 12 ve üzeri sentetik testte diziyi birebir buluyor; 4 ve 8 akor kaçırıyor.
# Yüksek tutmak gürültüye duyarlılığı artırır, 12 en düşük güvenli değer.
SHARPEN = 12.0
# Beat enerjisi, 90. yüzdeliğin bu katından düşükse akor yok (N)
N_ENERGY_RATIO = 0.10
# N durumunun sabit skoru: hiçbir triad bunu geçemiyorsa "akor yok".
# (N'in spektral şablonu yok; gerekçe _chord_states docstring'inde.)
N_SCORE = 0.5

# --- beat_this (CPJKU), eğitilmiş beat/downbeat modeli -------------------
# MIT lisans. torch>=2 istiyor -> 2.5.1 uyumlu. torchaudio'yu --no-deps ile
# atlıyoruz: beat_this/inference.py torchaudio'yu module düzeyinde import
# etmiyor, resampling icin soxr kullaniyor; biz de dosya okuma yapan
# File2Beats yerine kendi ffmpeg cozumumuzu Audio2Beats'e veriyoruz.
BEAT_THIS_CHECKPOINT = "final0"
BEAT_THIS_SR = 22050  # Audio2Beats icinde de bu orana resample ediliyor

volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

# --------------------------------------------------------------------------
# Düz tip bekçisi (PLAN.md: uzak fonksiyonlar torch/numpy nesnesi döndürmez)
#
# Not: bu yardımcı backend/smoke.py'de de var. Ortak bir modüle almak yerine
# kopyaladım; her dosya kendi başına calışabilsin ve imaja ek kaynak dosyası
# dahil etme ihtiyacı doğmasın.
# --------------------------------------------------------------------------
SCALAR_TYPES = (str, int, float, bool, type(None))

# --------------------------------------------------------------------------
# torchaudio kuralı
#
# torchaudio artık imajda KURULU. Sebep: beat_this/inference.py ->
# beat_this/preprocessing.py zinciri modül düzeyinde onu import ediyor ve
# LogMelSpect sınıfı mel spektrogram dönüşümü için kullanıyor - bu Audio2Beats
# yolunda, yani kaçınılmaz. Bu bir I/O kullanımı değil: mel dönüşümü saf torch
# hesabı, ses kodeki/backend'i devreye girmiyor. PLAN.md'nin endişesi yeni
# sürümlerdeki I/O backend sorunlarıydı, dönüşümler değil.
#
# Kural bu yüzden "torchaudio kurulu olmasın"dan "BİZİM kodumuz torchaudio
# I/O kullanmasın"a döndü ve aşağıdaki kontrol bunu her import'ta doğruluyor.
# Sürümü torch ile birebir eşleşiyor (2.5.1); torchaudio 2.5.1 zaten
# torch==2.5.1'i tam pinliyor.
#
# İğneler parça birleştirmeyle kuruluyor ki bu dosyadaki tanım satırının
# kendisi kontrole yakalanmasın.
# --------------------------------------------------------------------------
_TA = "torch" + "audio"
FORBIDDEN_TORCHAUDIO = (
    _TA + ".load", _TA + ".save", _TA + ".info",
    "import " + _TA, "from " + _TA,
)


def _check_no_torchaudio_io(source: str):
    """Kaynakta torchaudio I/O kullanımı varsa bulguları döndürür."""
    hits = []
    for lineno, line in enumerate(source.splitlines(), 1):
        code = line.split("#", 1)[0]
        for needle in FORBIDDEN_TORCHAUDIO:
            if needle in code:
                hits.append(f"satir {lineno}: {needle}")
    return hits


def _self_check_torchaudio():
    """Her import'ta kendi kaynağımızı tarar. Dönüş: taranan satır sayısı."""
    try:
        source = pathlib.Path(__file__).read_text(encoding="utf-8")
    except Exception as exc:  # kaynak mount edilmemişse
        print(f"[uyari] kendi kaynagim okunamadi, I/O kurali dogrulanamadi: {exc}")
        return None
    hits = _check_no_torchaudio_io(source)
    if hits:
        raise RuntimeError(
            "PLAN.md kurali ihlali - kodumuz ses I/O icin torchaudio kullaniyor: "
            + "; ".join(hits)
            + ". Okuma ffmpeg, yazma soundfile/ffmpeg ile yapilmali."
        )
    return len(source.splitlines())


_SELF_CHECK_LINES = _self_check_torchaudio()


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
    """Build aşaması: sürümleri doğrular, ağırlıkları imaja gömer."""
    import numpy as np
    import torch

    # 1) Sürümler: torch 2.5.1 sabit kalmalı ve torchaudio onunla birebir
    #    eşleşmeli. torchaudio yanlış sürümü çekip torch'u yükseltirse
    #    demucs'un checkpoint yüklemesi (weights_only değişikliği) kırılır.
    torch_version = str(torch.__version__).split("+")[0]
    if torch_version != "2.5.1":
        raise RuntimeError(f"torch surumu kaydi: beklenen 2.5.1, bulunan {torch_version}")

    audio_module = __import__(_TA)
    audio_version = str(audio_module.__version__).split("+")[0]
    if audio_version != torch_version:
        raise RuntimeError(
            f"{_TA} {audio_version} ile torch {torch_version} eslesmiyor"
        )
    print(f"torch {torch_version} / {_TA} {audio_version} eslesiyor")

    # 2) Kendi kaynağımız I/O kuralına uyuyor mu? (import anında tarandı)
    if _SELF_CHECK_LINES is None:
        raise RuntimeError(
            "build sirasinda kaynak taranamadi; I/O kurali dogrulanamadi"
        )
    print(f"I/O kurali: {_SELF_CHECK_LINES} satir tarandi, ihlal yok")

    # 3) Import zinciri gerçekten çalışıyor mu?
    import beat_this.inference  # noqa: F401
    import beat_this.preprocessing  # noqa: F401
    import demucs.apply  # noqa: F401
    import demucs.pretrained  # noqa: F401

    print("importlar tamam: beat_this.inference, beat_this.preprocessing, demucs")

    from demucs.pretrained import get_model

    model = get_model(MODEL_NAME)
    print(f"model: {MODEL_NAME}")
    print(f"sources: {list(model.sources)}")
    print(f"samplerate: {model.samplerate}  audio_channels: {model.audio_channels}")

    # beat_this: ağırlığı indir VE gerçekten çalıştır. Boru hattı burada,
    # build aşamasında doğrulanıyor; çalışma anında sürpriz olmasın.
    from beat_this.inference import Audio2Beats

    audio2beats = Audio2Beats(
        checkpoint_path=BEAT_THIS_CHECKPOINT, device="cpu", dbn=False
    )

    # Girdi biçimi beat_this kaynağından doğrulandı (inference.py,
    # Audio2Frames.signal2spect): 1B sinyal doğrudan kabul ediliyor; 2B ise
    # (örnek, kanal) varsayılıp signal.mean(1) ile mono'ya indiriliyor; sr
    # 22050 değilse soxr ile çevriliyor; sonra torch.float32 tensöre alınıyor.
    # Biz 1B float32 @ 22050 veriyoruz, yani hiçbir dönüşüm tetiklenmiyor.
    seconds = 12.0
    t = np.arange(int(seconds * BEAT_THIS_SR)) / BEAT_THIS_SR
    rng = np.random.default_rng(0)
    signal = np.zeros_like(t)
    # 120 BPM: her vuruşta perküsif gürültü patlaması + akor sesi
    for index in range(int(seconds * 2)):
        start = int(index * 0.5 * BEAT_THIS_SR)
        stop = min(start + 2200, signal.size)
        if stop <= start:
            continue
        envelope = np.exp(-12.0 * np.arange(stop - start) / BEAT_THIS_SR)
        strength = 1.0 if index % 4 == 0 else 0.5  # downbeat daha güçlü
        signal[start:stop] += strength * envelope * rng.standard_normal(stop - start)
    for freq in (220.0, 277.2, 329.6):  # A minör üçlüsü
        signal += 0.3 * np.sin(2 * np.pi * freq * t)
    probe_signal = (signal / np.abs(signal).max() * 0.9).astype(np.float32)

    if probe_signal.ndim != 1 or probe_signal.dtype != np.float32:
        raise RuntimeError(
            f"duman testi girdisi yanlis bicimde: ndim={probe_signal.ndim} "
            f"dtype={probe_signal.dtype} (1B float32 bekleniyor)"
        )

    # Build'de aranan: hata vermeden çalışsın ve doğru tipte diziler dönsün.
    # Beat sayısı 0 ise build PATLAMIYOR: model gerçek müzikle eğitildi,
    # sentetik bir sinyalde eşiği geçmemesi kurulumun bozuk olduğunu
    # göstermez. Gerçek doğrulama track_beats içinde, gerçek şarkıda yapılıyor.
    beats, downbeats = audio2beats(probe_signal, BEAT_THIS_SR)
    for name, values in (("beats", beats), ("downbeats", downbeats)):
        array = np.asarray(values)
        if array.ndim != 1:
            raise RuntimeError(f"{name} 1B dizi degil: shape={array.shape}")
        if array.size and not np.issubdtype(array.dtype, np.floating):
            raise RuntimeError(f"{name} kayan noktali degil: dtype={array.dtype}")

    print(
        f"beat_this[{BEAT_THIS_CHECKPOINT}] duman testi: "
        f"{len(beats)} beat, {len(downbeats)} downbeat, tipler dogru"
    )
    if len(beats) == 0:
        print(
            "[uyari] sentetik sinyalde 0 beat bulundu. Kurulum ve girdi bicimi "
            "dogrulandi; model gercek muzikle egitildigi icin bu beklenebilir. "
            "Gercek dogrulama: modal run backend/app.py::beats_only"
        )

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
    )
    # beat_this'in bağımlılıkları, elle sabitlenmiş. Ses I/O için değil, mel
    # spektrogram dönüşümü için gereken ses kütüphanesi de burada: sürümü
    # torch ile birebir eşleşiyor (2.5.1, torch==2.5.1'i tam pinliyor).
    .pip_install(
        "torchaudio==2.5.1",
        "einops==0.8.2",
        "rotary-embedding-torch==0.9.1",  # torch>=2.4 istiyor, 2.5.1 uyumlu
        "soxr==1.1.0",  # cp311 wheel'i var
        "tqdm==4.67.1",
    )
    # --no-deps: torchaudio çekmesin. Bağımlılıkları yukarıda verdik.
    .pip_install("beat-this==1.1.0", extra_options="--no-deps")
    # Hi-Fi vokal yolu (Aşama 9). librosa GEREKMİYOR: onu yalnız
    # mel_band_roformer istiyordu, o model elendi.
    .pip_install("beartype==0.19.0", "PyYAML==6.0.2")
    # Ağırlıklar build'de bu iki yola inecek ve imaja gömülecek.
    .env({"HF_HOME": WEIGHTS_DIR, "TORCH_HOME": WEIGHTS_DIR})
    .run_function(_warm_weights)
    # Build'den SONRA offline'a al: soğuk başlangıçta sessizce yeniden indirme
    # olursa gürültüsüzce yavaşlamak yerine hata versin.
    .env({"HF_HUB_OFFLINE": "1"})
    # MSST mimari dosyaları (MIT, pinli commit) depodan. copy=False bilinçli:
    # dosyalar konteyner açılışında bağlanıyor, imaj katmanına girmiyor, yani
    # burada bir şey değişse bile htdemucs ağırlığı yeniden indirilmiyor.
    # Modal'da mount katmanından SONRA build adımı olamaz - bu yüzden en sonda.
    .add_local_dir(MSST_LOCAL, MSST_DIR)
)

# Analiz imajı: torch YOK, GPU YOK. librosa 1.0.0 çıktı ama python>=3.12 +
# numpy>=2.1 istiyor ve büyük sürüm atlaması API riski taşıyor; 0.11.0
# separate_image ile aynı numpy'yi (1.26.4) kullanabiliyor.
analyze_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "librosa==0.11.0",
    "numpy==1.26.4",
    "numba==0.62.1",  # numpy<2.4 kısıtı 1.26.4 ile uyumlu
    "soundfile==0.13.1",
)

app = modal.App(APP_NAME)


# --------------------------------------------------------------------------
# Volume yardımcıları (konteyner içinde çalışır)
# --------------------------------------------------------------------------


def _song_dir(song_id: str) -> pathlib.Path:
    return pathlib.Path(DATA_DIR) / "songs" / song_id


# --------------------------------------------------------------------------
# Şarkı kimliği doğrulaması
#
# Kimlik, yüklenen dosyanın sha256'sı: 64 küçük harf onaltılık. Deney
# çıktılarının kimliği aynı hash + kısa bir ek (`...-cfp32`), onlar da
# kitaplıkta görünebiliyor (bkz. experiment.py), o yüzden ek de kabul edilir.
#
# Desen NOKTA, EĞİK ÇİZGİ ve ters eğik çizgiyi HİÇ kabul etmiyor - "..",
# "../", "%2e%2e" çözülmüş hali, mutlak yol, null bayt, hepsi eleniyor. Silme
# uçları model ağırlıklarına (/data/weights) ya da Volume'un başka bir yerine
# ASLA ulaşamasın; tek dosya silmek yerine bir dizini özyinelemeli silen bir
# uçta bunun bedeli ağır olurdu. `_safe_song_dir` ayrıca sonucun gerçekten
# /data/songs altında kaldığını da doğruluyor: desen bir gün gevşetilirse
# ikinci kapı devrede kalsın.
# --------------------------------------------------------------------------
SONG_ID_RE = re.compile(r"^[0-9a-f]{64}(-[a-z0-9]{1,12})?$")

# Bu durumlarda silinmiyor: ayrıştırma ya da Hi-Fi yükseltmesi sürüyor.
# Sadece kullanıcıyı korumak için değil - süren `separate` girdisini
# bulamayınca status.json'a "error" yazar ve kitaplıkta boş bir şarkı
# canlanırdı.
BUSY_STATES = ("queued", "separating", "analyzing")

# Çoklu silmede tek istekteki üst sınır. Tek kullanıcılı bir sistemde bunu
# aşmak kullanıcı hatasıdır; sınır, kazayla tüm kitaplığı tek istekte silen
# bir hatayı da yakalar.
MAX_DELETE_IDS = 200


def _is_valid_song_id(song_id) -> bool:
    return isinstance(song_id, str) and bool(SONG_ID_RE.match(song_id))


def _safe_song_dir(song_id: str) -> pathlib.Path:
    """Kimliği doğrulayıp şarkı klasörünü döndürür.

    Geçersiz kimlikte ya da (olmaması gereken bir durumda) sonuç
    /data/songs dışına çıkarsa ValueError atar.
    """
    if not _is_valid_song_id(song_id):
        raise ValueError(f"gecersiz sarki kimligi: {str(song_id)[:80]!r}")
    root = (pathlib.Path(DATA_DIR) / "songs").resolve()
    target = (root / song_id).resolve()
    if target != root / song_id or root not in target.parents:
        raise ValueError(f"sarki klasoru /data/songs disina cikiyor: {target}")
    return target


def _delete_block_reason(status):
    """Silmeyi engelleyen bir durum varsa açıklamasını döndürür."""
    if not status:
        return None
    state = str(status.get("state") or "")
    if state in BUSY_STATES:
        labels = {"queued": "sirada bekliyor", "separating": "ayristiriliyor",
                  "analyzing": "analiz ediliyor"}
        return (f"Sarki islenirken silinemez ({labels.get(state, state)}). "
                "Bitmesini bekleyip tekrar dene.")
    if _sub_is_running(status):
        return ("Alt parcalar ayrilirken silinemez. "
                "Bitmesini bekleyip tekrar dene.")
    if _lyrics_is_running(status):
        return ("Sozler hazirlanirken silinemez. "
                "Bitmesini bekleyip tekrar dene.")
    if _export_is_running(status):
        return ("Disa aktarma surerken silinemez. "
                "Bitmesini bekleyip tekrar dene.")
    if _tr_is_running(status):
        return ("Soz cevirisi surerken silinemez. "
                "Bitmesini bekleyip tekrar dene.")
    if _melody_is_running(status):
        return ("Hedef melodi hazirlanirken silinemez. "
                "Bitmesini bekleyip tekrar dene.")
    return None


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


def _decode_pcm(path: pathlib.Path, samplerate: int, channels: int):
    """ffmpeg ile (kanal, N) float32 numpy dizisi. torchaudio I/O yok.

    `separate` ve `hifi_smoke_run` AYNI işlevi çağırıyor, bilinçli: duman
    testinin parça (chunk) ızgarası üretimdekiyle birebir aynı olmak zorunda.
    Tek örneklik bir kayma bile örtüşme sınırlarını kaydırır ve deneydeki
    çıktıyla karşılaştırmayı anlamsız kılar.
    """
    import numpy as np

    proc = _run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ar", str(samplerate), "-ac", str(channels), "-",
        ]
    )
    return np.frombuffer(proc.stdout, dtype="<f4").reshape(-1, channels).T.copy()


# soxr bu imajın ffmpeg'inde var mı? Denenip öğreniliyor: "-filters"
# çıktısında görünmesi kütüphanenin BAĞLI olduğunu kanıtlamıyor, gerçek
# çağrıyı denemek kanıtlıyor. Sonuç konteyner ömrü boyunca hatırlanıyor.
_SOXR_OK = None


def _encode_stem_m4a(flac_path: pathlib.Path, m4a_path: pathlib.Path,
                     channels: int) -> str:
    """FLAC aslından oynatma dosyası: AAC, STEM_SAMPLE_RATE, AAC_BITRATE.

    Yeniden örnekleme (44.1 -> 48 kHz) soxr ile yapılıyor; bu ffmpeg
    yapısında soxr yoksa ffmpeg'in kendi (swr) örnekleyicisine düşülüyor.
    Hangisinin kullanıldığı log'a yazılıyor - sessizce kaliteden ödün
    vermeyelim.
    """
    global _SOXR_OK

    base = [
        "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(flac_path),
        "-c:a", "aac", "-b:a", AAC_BITRATE,
        "-ar", str(STEM_SAMPLE_RATE), "-ac", str(channels),
        "-movflags", "+faststart", str(m4a_path),
    ]
    # Filtre GİRDİDEN SONRA gelmek zorunda: "-i" kendinden sonraki ilk
    # belirteci girdi dosyası sayıyor, "-af"i araya sokmak komutu bozuyordu.
    input_end = base.index(str(flac_path)) + 1
    soxr = base[:input_end] + [
        "-af", f"aresample={STEM_SAMPLE_RATE}:resampler=soxr:precision=28",
    ] + base[input_end:]

    if _SOXR_OK is not False:
        try:
            _run(soxr)
            if _SOXR_OK is None:
                _SOXR_OK = True
                print("[encode] soxr kullaniliyor (precision 28)")
            return "soxr"
        except RuntimeError as error:
            if _SOXR_OK is True:
                raise
            _SOXR_OK = False
            print(f"[encode] soxr YOK, ffmpeg swr'ye dusuluyor: {str(error)[:200]}")

    _run(base)
    return "swr"


def _decode_mono(path: pathlib.Path, samplerate: int):
    """ffmpeg ile mono float32 numpy dizisi. torchaudio I/O yok."""
    import numpy as np

    proc = _run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ar", str(samplerate), "-ac", "1", "-",
        ]
    )
    return np.frombuffer(proc.stdout, dtype="<f4").copy()


def _track_beats_inline(song_id: str, device: str = "cuda") -> dict:
    """beat_this'i ÖZGÜN MIX üzerinde çalıştırıp beats.json yazar.

    Stem'ler değil orijinal karışım veriliyor: model tam mix üzerinde
    eğitildi, davul/vokal ipuçlarını da kullanıyor.
    """
    from beat_this.inference import Audio2Beats

    started = time.time()
    input_path = _find_input(song_id)
    # 1B mono float32 @ 22050 - Audio2Frames.signal2spect'in beklediği biçim,
    # hiçbir iç dönüşüm (mono indirme / resample) tetiklenmiyor.
    signal = _decode_mono(input_path, BEAT_THIS_SR)
    duration = len(signal) / BEAT_THIS_SR

    audio2beats = Audio2Beats(
        checkpoint_path=BEAT_THIS_CHECKPOINT, device=device, dbn=False
    )
    beats, downbeats = audio2beats(signal, BEAT_THIS_SR)

    beat_times = [round(float(value), 3) for value in beats]
    downbeat_times = [round(float(value), 3) for value in downbeats]

    # beats.json'daki bpm de analyze ile AYNI yöntemi kullanmalı: regresyon.
    # Burada medyan aralık vardı ve beats.json 130.43 derken chords.json 128.0
    # diyordu (beat_this zamanları 20 ms ızgarasında, medyan snap ediyor).
    bpm = None
    if len(beat_times) >= 2:
        estimate = _bpm_from_beats(beat_times)
        if estimate > 0:
            bpm = round(estimate, 2)

    # Gerçek doğrulama burada: build'deki sentetik testin aksine bu gerçek
    # müzik. Sonuç anlamsızsa sessizce librosa yedeğine düşmek yerine açık
    # hata veriyoruz - yoksa kayma sorununu yanlış yerde arardık.
    if not beat_times:
        raise ValueError(
            f"beat_this {duration:.1f} sn'lik kayitta hic beat bulamadi. "
            "Girdi bicimi 1B float32 @ 22050 (dogru); model ya da agirlik "
            "yuklemesi bozuk olabilir."
        )
    if bpm is None or not (60.0 <= bpm <= 200.0):
        raise ValueError(
            f"beat_this anlamsiz tempo buldu: bpm={bpm} "
            f"({len(beat_times)} beat / {duration:.1f} sn). "
            "60-200 araligi bekleniyor."
        )
    coverage = (beat_times[-1] - beat_times[0]) / duration if duration else 0.0
    if coverage < 0.5:
        print(
            f"[uyari] beat'ler kaydin yalnizca %{100 * coverage:.0f}'ini "
            "kapsiyor; parcanin bir bolumunde ritim bulunamamis olabilir"
        )

    data = {
        "beats": beat_times,
        "downbeats": downbeat_times,
        "bpm": bpm,
        "duration": round(duration, 3),
        "coverage": round(coverage, 3),
        "source": "beat_this",
        "checkpoint": BEAT_THIS_CHECKPOINT,
        "device": device,
        "seconds": round(time.time() - started, 2),
    }
    path = _song_dir(song_id) / "beats.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    volume.commit()
    print(
        f"[beat_this] {len(beat_times)} beat, {len(downbeat_times)} downbeat, "
        f"bpm={bpm}, {data['seconds']} sn"
    )
    return data


# --------------------------------------------------------------------------
# CPU fonksiyonları (hafif imaj, torch yok)
# --------------------------------------------------------------------------


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=120)
def probe(song_id: str, fallback_title: str = "") -> dict:
    """ffprobe ile süre/etiket okur, status.json'ı hazırlar.

    30 MB / 10 dk kapısı burada, GPU'ya girmeden CPU tarafında kapanır.
    """
    volume.reload()
    return _probe_input(song_id, fallback_title)


def _probe_input(song_id: str, fallback_title: str = "") -> dict:
    """probe()'un gövdesi, reload'suz. API konteyneri de bunu çağırıyor
    (imajında ffmpeg var, ayrı bir konteyner açmaya gerek yok)."""
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
# GPU: yalnızca beat/downbeat takibi
#
# Ayrı fonksiyon, çünkü zaten ayrıştırılmış şarkılar için 12 dakikalık bir
# yeniden ayrıştırmaya girmeden sadece beats.json üretebilmek gerekiyor.
# --------------------------------------------------------------------------


@app.function(
    image=separate_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=600,
    max_containers=1,  # min_containers YOK
)
def track_beats(song_id: str) -> dict:
    volume.reload()
    try:
        data = _track_beats_inline(song_id, device="cuda")
    except Exception as exc:
        _write_status(song_id, state="error", error=f"{type(exc).__name__}: {exc}")
        raise
    return _assert_plain(
        {
            "id": song_id,
            "beat_count": len(data["beats"]),
            "downbeat_count": len(data["downbeats"]),
            "bpm": data["bpm"],
            "seconds": data["seconds"],
        }
    )


# --------------------------------------------------------------------------
# GPU: ayrıştırma
# --------------------------------------------------------------------------


# --------------------------------------------------------------------------
# Aşama 9 - Hi-Fi vokal yolu (BS-Roformer SW)
# --------------------------------------------------------------------------
# Deneyin sonucu: vokal BS-Roformer SW'den, kalan beş stem htdemucs_6s'ten.
# Ayrıntılı ölçümler ve elenen adaylar PLAN.md'de.
#
# İKİ ŞEY DENEYDE ÖĞRENİLDİ, burada sabit:
#   fp32  - vokal geçişi fp16 olduğunda enstrümantalde duyulur cızırtı
#           kalıyor. Vokalin İÇİNDE duyulmuyor; "karışım - vokal"
#           çıkarmasından sonra açığa çıkıyor. fp32 cızırtıyı tamamen
#           kaldırdı (C-fp32 / C-fp32-ov4 temiz, C-ov4 fp16 hâlâ hafif
#           cızırtılı) - yani sebep örtüşme değil, hassasiyet.
#   overlap 2 - konfigin kendi değeri. 4'e çıkarmak cızırtıyı çözmedi,
#           yalnız süreyi artırdı.
#
# Ağırlık Volume'da, imajda DEĞİL: lisansı belirsiz bir checkpoint'i imaja
# gömmek istemiyoruz (bkz. NOTICE.md). Bedeli soğuk başlangıçta ~700 MB
# okuma, ölçülen model yükleme ~8.5 sn.

HIFI_CKPT = "bs_roformer_sw.ckpt"
HIFI_YAML = "bs_roformer_sw.yaml"
HIFI_CKPT_SHA256 = "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
HIFI_CKPT_BYTES = 699412152
HIFI_OVERLAP = 2
# Boru hattı sürümü (status.json `pipeline`, telefon önbellek anahtarına giriyor).
#   hifi_v1   vokal SW'den, kalan demucs'ta (2026-09-29 .. 2026-10-01; alan yoksa bu)
#   hifi_v2   vokal + piyano + davul SW'den, enstrümantal = karışım - üçü, demucs
#             yalnız bas/gitar/other için; demucs'un aynı isimli artığı other'a
#             (PLAN.md madde 7, kulak testiyle onaylandı: o yönü)
PIPELINE_HIFI = "hifi_v2"
PIPELINE_STANDARD = "standard"
HIFI_SW_STEMS = ("vocals", "piano", "drums")
QUALITIES = ("hifi", "standard")
DEFAULT_QUALITY = "hifi"


def _hifi_weights_dir() -> pathlib.Path:
    return pathlib.Path(DATA_DIR) / "weights"


def _verify_sha256(path: pathlib.Path, expected: str, expected_bytes: int):
    """Ağırlık doğrulaması. Tutmuyorsa HATA - sessizce yanlış model yok."""
    size = path.stat().st_size
    if size != expected_bytes:
        raise ValueError(
            f"{path.name} boyutu beklenenden farkli: {size} != {expected_bytes}"
        )
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    actual = digest.hexdigest()
    if actual != expected:
        raise ValueError(
            f"{path.name} sha256 UYUSMUYOR!\n  beklenen: {expected}\n  gelen   : {actual}"
        )


def _load_hifi_config(path: pathlib.Path) -> dict:
    """YAML'i GÜVENLİ yükler.

    Konfig `!!python/tuple` kullanıyor; `yaml.unsafe_load` bunu çözer ama
    rastgele kod çalıştırmaya da açar. Konfig lisansı belirsiz bir aynadan
    geldiği için SafeLoader'a YALNIZCA tuple kurucusu ekleniyor.
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


def _hifi_window(window_size: int, fade_size: int, device):
    """MSST'nin _getWindowingArray'i (MIT): doğrusal fade-in/out, ortası 1."""
    import torch

    window = torch.ones(window_size, device=device)
    window[:fade_size] = torch.linspace(0.0, 1.0, fade_size, device=device)
    window[-fade_size:] = torch.linspace(1.0, 0.0, fade_size, device=device)
    return window


def _hifi_demix(model, mix, config: dict, device: str = "cuda",
                overlap: int = None):
    """Örtüşmeli parça parça çıkarım, fp32.

    MSST'nin demix()'inin generic dalıyla AYNI algoritma; deneyde MSST'nin
    kendi kodu çağrılıp çıktılar örnek bazında karşılaştırıldı, 6 stem'de
    maksimum fark 0.000000 çıktı (bkz. PLAN.md, referans kontrolü).
    """
    import numpy as np
    import torch
    from torch.nn import functional as F

    chunk_size = int(config["audio"]["chunk_size"])
    batch_size = int(config.get("inference", {}).get("batch_size", 1))
    fade_size = chunk_size // 10
    # overlap yalnız alt parça deneyi (separate_sub) için; Hi-Fi yolu varsayılanı
    # (HIFI_OVERLAP) kullanıyor, yani davranışı DEĞİŞMEDİ.
    step = chunk_size // int(overlap or HIFI_OVERLAP)
    border = chunk_size - step

    mix = torch.as_tensor(mix, dtype=torch.float32, device=device)
    length_init = mix.shape[-1]
    if length_init > 2 * border and border > 0:
        mix = F.pad(mix, (border, border), mode="reflect")

    window_template = _hifi_window(chunk_size, fade_size, device)
    # roformer: model.num_stems; MDX23C: model'de yok, çıkış sayısı instruments'ın
    # uzunluğu (Aşama 10 davul). Hi-Fi/karaoke config'leri num_stems veriyor:
    # davranışları DEĞİŞMEDİ.
    model_cfg = config["model"]
    num_stems = int(model_cfg.get("num_stems")
                    or len((config.get("training") or {}).get("instruments") or [1]))
    result = torch.zeros((num_stems,) + tuple(mix.shape), dtype=torch.float32,
                         device=device)
    counter = torch.zeros(mix.shape[-1], dtype=torch.float32, device=device)

    batch_data = []
    batch_locations = []
    index = 0
    # autocast YOK: fp32. Deneyde fp16'nın bıraktığı hata "karışım - vokal"
    # çıkarmasından sonra cızırtı olarak duyuluyordu.
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
                if out.dim() == 3:
                    out = out.unsqueeze(1)
                window = window_template.clone()
                if index - step == 0:
                    window[:fade_size] = 1.0
                elif index >= mix.shape[1]:
                    window[-fade_size:] = 1.0
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
    if bool(np.isnan(array).any() or np.isinf(array).any()):
        # fp32'de beklenmiyor; olursa sessizce sıfırlamak yerine bilelim.
        raise ValueError("Hi-Fi vokal cikisinda NaN/Inf var")
    return array


def _hifi_stems(mix, samplerate: int, channels: int) -> tuple:
    """BS-Roformer SW: vokal, piyano ve davul (tek geçiş, altısı zaten üretiliyor).

    Dönen: ({isim: (2, N) float32}, saniye, model_yukleme_sn).
    """
    import sys
    import time as _time

    import torch

    weights = _hifi_weights_dir()
    ckpt = weights / HIFI_CKPT
    config_path = weights / HIFI_YAML
    if not ckpt.is_file() or not config_path.is_file():
        raise FileNotFoundError(
            f"Hi-Fi agirliklari yok: {ckpt}. "
            f"'modal run backend/app.py::fetch_hifi_weights' calistirilmali."
        )

    load_started = _time.time()
    _verify_sha256(ckpt, HIFI_CKPT_SHA256, HIFI_CKPT_BYTES)
    config = _load_hifi_config(config_path)
    if int(config["audio"]["sample_rate"]) != samplerate:
        raise ValueError(
            f"Hi-Fi modeli {config['audio']['sample_rate']} Hz bekliyor, "
            f"{samplerate} Hz verildi"
        )

    if MSST_DIR not in sys.path:
        sys.path.insert(0, MSST_DIR)
    from models.bs_roformer.bs_roformer import BSRoformer

    model = BSRoformer(**dict(config["model"]))
    state = torch.load(str(ckpt), map_location="cpu", weights_only=False)
    if isinstance(state, dict):
        for key in ("state_dict", "model", "model_state_dict"):
            if key in state and isinstance(state[key], dict):
                state = state[key]
                break
    if any(name.startswith("module.") for name in state):
        state = {name.removeprefix("module."): value for name, value in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        print(f"[hifi] ckpt eksik={len(missing)} fazla={len(unexpected)}")
    model.to("cuda")
    model.eval()
    model_load_seconds = round(_time.time() - load_started, 2)
    print(f"[hifi] model {model_load_seconds} sn'de hazir (sha256 dogrulandi)")

    started = _time.time()
    out = _hifi_demix(model, mix, config)
    names = list(config["training"]["instruments"])
    absent = [name for name in HIFI_SW_STEMS if name not in names]
    if absent:
        raise ValueError(f"Hi-Fi konfiginde stem yok: {absent} (var: {names})")
    stems = {name: out[names.index(name)].copy() for name in HIFI_SW_STEMS}
    seconds = round(_time.time() - started, 2)
    print(f"[hifi] {'/'.join(HIFI_SW_STEMS)} cikarimi {seconds} sn "
          f"(fp32, overlap {HIFI_OVERLAP}, stem sirasi {names})")

    del model, out
    torch.cuda.empty_cache()
    return stems, seconds, model_load_seconds


def _rms_f64(array) -> float:
    """numpy ya da (CPU) torch dizisinin RMS'i; test edilebilsin diye saf."""
    import numpy as np

    if hasattr(array, "detach"):
        array = array.detach().cpu().numpy()
    data = np.asarray(array, dtype=np.float64)
    return float(np.sqrt(np.mean(data ** 2))) if data.size else 0.0


def _hifi_v2_compose(stems, sources: list, sw: dict) -> dict:
    """demucs çıkışını hifi_v2 kuralına göre YERİNDE düzeltir.

    `stems`: demucs'un enstrümantal (karışım - SW stem'leri) üzerindeki çıkışı,
    (kaynak, 2, N). Enstrümantalden SW'nin aldığı her stem için demucs'un AYNI
    isimli çıkışı "artık"tır (SW'nin kaçırdığı parça): other'a eklenir, atılmaz,
    böylece toplam korunur ("o" yönü; kulak testinde "p" yönü piyano stem'ine
    gitar/ses kalıntısı getirdi). Sonra o stem SW'nin çıkışıyla DEĞİŞTİRİLİR.

    Dönen: {isim: artığın RMS'i}. numpy ve torch dizileriyle çalışır.
    """
    other_index = sources.index("other")
    residues = {}
    for name in HIFI_SW_STEMS:
        index = sources.index(name)
        replacement = sw[name]
        if tuple(replacement.shape) != tuple(stems[index].shape):
            raise ValueError(
                f"Hi-Fi {name} bicimi uyusmuyor: {tuple(replacement.shape)} "
                f"!= {tuple(stems[index].shape)}"
            )
        residue = stems[index]
        residues[name] = _rms_f64(residue)
        stems[other_index] = stems[other_index] + residue
        stems[index] = replacement
    return residues


@app.function(
    image=separate_image,
    volumes={DATA_DIR: volume},
    timeout=3600,
)
def fetch_hifi_weights() -> dict:
    """Hi-Fi ağırlığını Volume'a indirir ve sha256 doğrular.

        modal run backend/app.py::fetch_hifi

    Ağırlık depoda DAĞITILMIYOR, çalışma anında aynadan iniyor. Lisans
    durumu NOTICE.md'de açıkça yazılı.
    """
    import urllib.request

    volume.reload()
    target_dir = _hifi_weights_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    report = {}

    for name, url, sha, size in (
        (HIFI_CKPT, HIFI_CKPT_URL, HIFI_CKPT_SHA256, HIFI_CKPT_BYTES),
        (HIFI_YAML, HIFI_YAML_URL, None, None),
    ):
        target = target_dir / name
        if target.exists() and sha:
            try:
                _verify_sha256(target, sha, size)
                print(f"[atla] {name} zaten var ve dogrulandi")
                report[name] = {"downloaded": False, "sha256": sha}
                continue
            except ValueError:
                print(f"[yeniden] {name} dogrulanamadi, tekrar iniyor")

        print(f"[indir] {name} <- {url}")
        with urllib.request.urlopen(url, timeout=600) as response:
            target.write_bytes(response.read())
        if sha:
            _verify_sha256(target, sha, size)
            print(f"[dogrulandi] {name} sha256={sha}")
        report[name] = {"downloaded": True, "bytes": target.stat().st_size}

    volume.commit()
    return _assert_plain(report)


# --------------------------------------------------------------------------
# Mevcut şarkıların oynatma dosyalarını yeniden kodlama
# --------------------------------------------------------------------------
# GPU YOK, yeniden AYIRMA yok, akor/vuruş yeniden hesaplanmıyor. Kaynak
# `master/*.flac`, yani ayrıştırmanın kayıpsız çıktısı - ses ikinci kez
# kayıplı kodlamadan geçmiyor, ilk kez geçiyor.
#
# Akor ve vuruş dosyaları SANİYE cinsinden; örnekleme hızı değişikliği
# onları etkilemiyor, o yüzden dokunulmuyorlar.
#
# stems_version ARTIRILIYOR: telefon stem'leri stems/<id>/<ad>@<sürüm>.m4a
# anahtarıyla saklıyor. Artırılmazsa cihaz eski dosyaları çalmaya devam eder,
# üstelik sessizce.


@app.function(
    image=light_image,
    volumes={DATA_DIR: volume},
    timeout=3600,
)
def reencode_stems(song_ids: list, dry_run: bool = True) -> dict:
    """Verilen şarkıların m4a'larını FLAC asıllardan yeniden üretir."""
    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    report = {"dry_run": bool(dry_run), "songs": [], "resampler": "",
              "bitrate": AAC_BITRATE, "samplerate": STEM_SAMPLE_RATE}

    wanted = set(song_ids or [])
    for entry in sorted(root.iterdir()) if root.is_dir() else []:
        if wanted and entry.name not in wanted:
            continue
        status_path = entry / "status.json"
        master_dir = entry / "master"
        if not status_path.is_file() or not master_dir.is_dir():
            continue
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if status.get("state") != "done":
            print(f"[atla] {entry.name}: durum {status.get('state')}")
            continue

        flacs = sorted(master_dir.glob("*.flac"))
        if not flacs:
            continue
        item = {
            "id": str(status.get("id", entry.name)),
            "title": str(status.get("title") or entry.name[:12]),
            "stems": [path.stem for path in flacs],
            "was": {
                "samplerate": status.get("stem_samplerate") or status.get("samplerate"),
                "bitrate": status.get("stem_bitrate") or "160k",
                "stems_version": status.get("stems_version"),
            },
        }

        if dry_run:
            report["songs"].append(item)
            continue

        channels = int(status.get("channels") or 2)
        stems_dir = entry / "stems"
        stems_dir.mkdir(parents=True, exist_ok=True)
        started = time.time()
        for flac_path in flacs:
            resampler = _encode_stem_m4a(
                flac_path, stems_dir / f"{flac_path.stem}.m4a", channels
            )
            report["resampler"] = resampler
        status["stems"] = [path.stem for path in flacs]
        status["stem_samplerate"] = STEM_SAMPLE_RATE
        status["stem_bitrate"] = AAC_BITRATE
        status["stems_version"] = int(time.time())
        status["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2),
                               encoding="utf-8")
        item["seconds"] = round(time.time() - started, 1)
        item["stems_version"] = status["stems_version"]
        item["bytes"] = int(sum(
            (stems_dir / f"{path.stem}.m4a").stat().st_size for path in flacs
        ))
        report["songs"].append(item)
        print(f"[kodlandi] {item['title'][:40]}: {len(flacs)} stem, "
              f"{item['seconds']} sn, surum {item['stems_version']}")

    if not dry_run:
        volume.commit()
    return _assert_plain(report)


@app.local_entrypoint()
def reencode(yes: bool = False, song_id: str = ""):
    """Oynatma dosyalarını (m4a) FLAC asıllardan yeniden kodlar.

        modal run backend/app.py::reencode            # yalnız listeler
        modal run backend/app.py::reencode --yes      # uygular

    GPU yok, yeniden ayırma yok, akor/vuruş yeniden hesaplanmıyor.
    """
    ids = [song_id] if song_id else []
    report = reencode_stems.remote(ids, not yes)
    songs = report.get("songs") or []
    if not songs:
        print("Yeniden kodlanacak sarki yok (master/*.flac bulunamadi).")
        return

    print("")
    print(f"Hedef: AAC {report['bitrate']}, {report['samplerate']} Hz, "
          f"kaynak master/*.flac (44.1 kHz, 24-bit)")
    print("")
    for item in songs:
        was = item.get("was") or {}
        line = (f"  {item['title'][:44]:<46} {len(item['stems'])} stem   "
                f"{was.get('samplerate')} Hz / {was.get('bitrate')}")
        if not yes:
            print(line + "  ->  yeniden kodlanacak")
        else:
            print(line + f"  ->  bitti, {item.get('seconds')} sn, "
                  f"surum {item.get('stems_version')}")

    if not yes:
        print("")
        print(f"{len(songs)} sarki. Uygulamak icin:")
        print("  modal run backend/app.py::reencode --yes")
        return

    print("")
    print(f"{len(songs)} sarki yeniden kodlandi "
          f"(yeniden orneklemede {report.get('resampler')}).")
    print("Telefonda: uygulamayi ac, sarkilari bir kez ac - yeni dosyalar inecek.")


@app.local_entrypoint()
def fetch_hifi():
    """modal run backend/app.py::fetch_hifi"""
    print(fetch_hifi_weights.remote())


# --------------------------------------------------------------------------
# Hi-Fi GPU duman testi
# --------------------------------------------------------------------------
# Neden gerekiyor: yerel 122 test torch'suz bir ortamda koşuyor, yani
# /msst'ten import'u, BSRoformer'ın kurulmasını ve vendored attend.py'deki
# yamalı satırı (yalnız CUDA dalında çalışıyor) HİÇ çalıştırmıyor. Bu
# entrypoint üretimin kendi imajı, GPU'su ve Volume'uyla tam yolu koşturuyor.
#
# Volume'a HİÇBİR ŞEY YAZMIYOR: hiçbir status.json'a, stem'e, kitaplık
# girdisine dokunmuyor. Salt okuma + GPU.
#
# Karşılaştırma: aynı şarkının deneydeki C-fp32 vokali (`{id}-cfp32`) aynı
# modelden, aynı fp32 / overlap 2 ayarıyla çıktı. Aradaki tek meşru fark
# FLAC'in 24-bit nicelemesi (ve kaydederken uygulanan ortak clip_scale).
#
# Referans koşumunun koşulları `backend/experiment.py`'den OKUNARAK doğrulandı
# ve rapora yazılıyor; "SNR düşük çıktı, herhalde GPU/decode farklıdır"
# bahanesinin geçerli olup olmadığı buna bakılarak söylenebilsin diye.
REFERENCE_RUN = {
    # experiment.py::run_c -> @app.function(gpu="T4"), üretimdeki separate ile
    # aynı GPU.
    "gpu": "T4",
    # experiment.py::_decode, ffmpeg argümanları _decode_pcm ile BİREBİR aynı:
    # -nostdin -v error -i <yol> -f f32le -acodec pcm_f32le -ar <sr> -ac <ch> -
    # ardından frombuffer("<f4").reshape(-1, kanal).T.copy()
    "decode_identical": True,
    "decode": "experiment.py::_decode == app.py::_decode_pcm (ayni ffmpeg args)",
    # main() -> run_c.remote(id, fp32=True, suffix="cfp32"); num_overlap
    # varsayılanı 2, yani üretimdeki HIFI_OVERLAP ile aynı.
    "entrypoint": "experiment.py::run_c(fp32=True, suffix='cfp32')",
    "precision": "fp32",
    "num_overlap": 2,
    # Farklı olan tek şey: deneyin imajında librosa/ml_collections/tqdm da var
    # ve MSST dosyaları o koşumda Volume'dan geliyordu (artık depodan).
    # torch/numpy sürümleri aynı (2.5.1 / 1.26.4), yama içeriği aynı.
    "notes": "ayni torch 2.5.1 + numpy 1.26.4; MSST dosyalari o kosumda Volume'dan",
}


def _pick_source_song(must_contain: str) -> tuple:
    """En son yüklenen, başlığında `must_contain` geçen KAYNAK şarkı.

    Deney çıktıları (`source_song` alanı olanlar) eleniyor - onların
    `input.*` dosyası da yok.
    """
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
        if data.get("state") != "done" or data.get("source_song"):
            continue
        if not sorted(entry.glob("input.*")):
            continue
        title = str(data.get("title") or entry.name)
        if must_contain and must_contain.lower() not in title.lower():
            continue
        found.append((str(data.get("created_at") or ""),
                      str(data.get("id", entry.name)), title))
    if not found:
        raise FileNotFoundError(
            f"'{must_contain}' iceren, durumu done olan kaynak sarki bulunamadi"
        )
    found.sort(reverse=True)
    return found[0][1], found[0][2]


@app.function(
    image=separate_image,
    gpu="T4",                     # üretimdeki `separate` ile aynı
    volumes={DATA_DIR: volume},
    timeout=1800,
    max_containers=1,             # min_containers YOK: boştayken maliyet sıfır
)
def hifi_smoke_run(song_id: str = "", must_contain: str = "HAZBIN",
                   compare_suffix: str = "pdm", extra_suffix: str = "pdt") -> dict:
    """Üretim Hi-Fi SW yolunu (vokal/piyano/davul) baştan sona koşturur."""
    import sys

    import numpy as np
    import soundfile as sf
    import torch

    wall_started = time.time()
    volume.reload()

    report = {
        "torch": str(torch.__version__),
        "torch_cuda": str(torch.version.cuda),
        "cuda_available": bool(torch.cuda.is_available()),
        "gpu": (str(torch.cuda.get_device_name(0))
                if torch.cuda.is_available() else ""),
        "msst_commit": MSST_SHA,
        "msst_dir": MSST_DIR,
    }

    if not song_id:
        song_id, title = _pick_source_song(must_contain)
    else:
        status = _read_status(song_id) or {}
        title = str(status.get("title") or song_id[:12])
    report["song_id"] = song_id
    report["title"] = title

    # Örnekleme hızı/kanal sayısı Hi-Fi konfiginden. Üretimde bu ikisi demucs
    # modelinden okunuyor ve `_hifi_stems` konfigle uyuşmazsa hata veriyor;
    # burada demucs YÜKLENMİYOR (duman testinin konusu değil, ~10 sn ve ~1 GB
    # VRAM tasarrufu), o yüzden değerler konfigden alınıp üretimde beklenen
    # çiftle (44100/2) karşılaştırılıyor.
    config = _load_hifi_config(_hifi_weights_dir() / HIFI_YAML)
    samplerate = int(config["audio"]["sample_rate"])
    channels = int(config["audio"]["num_channels"])
    report["samplerate"] = samplerate
    report["channels"] = channels
    report["samplerate_channels_match_demucs"] = bool(
        (samplerate, channels) == (44100, 2)
    )

    # --- decode: üretimin KENDİ işlevi (parça ızgarası aynı olsun) --------
    decode_started = time.time()
    audio = _decode_pcm(_find_input(song_id), samplerate, channels)
    report["decode_seconds"] = round(time.time() - decode_started, 2)
    duration = round(audio.shape[1] / samplerate, 3)
    report["duration"] = duration
    report["samples"] = int(audio.shape[1])
    print(f"[smoke] {title} -> {tuple(audio.shape)} = {duration} sn")

    # --- yamalı satırı sayaçla izle --------------------------------------
    # Yama olmasa torch 2.5.1'de TypeError atıp ilk parçada düşerdi. Sayaç 0
    # kalırsa flash dalına hiç girilmemiş demektir: koşum yine geçerli ama
    # duman testi yamayı SINAMAMIŞ olur, bu yüzden raporda görünüyor.
    if MSST_DIR not in sys.path:
        sys.path.insert(0, MSST_DIR)
    from models.bs_roformer import attend as _attend

    report["patch_present"] = bool(hasattr(_attend, "_sdpa_kernel_compat"))
    set_priority_supported = None
    if hasattr(_attend, "sdpa_kernel") and hasattr(_attend, "INFERENCE_SDPA_BACKENDS"):
        try:
            with _attend.sdpa_kernel(_attend.INFERENCE_SDPA_BACKENDS,
                                     set_priority=True):
                pass
            set_priority_supported = True
        except TypeError:
            set_priority_supported = False
        except Exception as error:          # probe koşumu düşürmesin
            print(f"[smoke] set_priority sondasi basarisiz: {error!r}")
            set_priority_supported = None
    report["set_priority_supported"] = set_priority_supported

    calls = {"n": 0}
    original_compat = getattr(_attend, "_sdpa_kernel_compat", None)

    def _counted_compat():
        calls["n"] += 1
        return original_compat()

    if original_compat is not None:
        _attend._sdpa_kernel_compat = _counted_compat

    # --- üretim yolu: model + TAM şarkı, fp32, overlap 2 ------------------
    try:
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        sw_stems, demix_seconds, model_load_seconds = _hifi_stems(
            audio, samplerate, channels
        )
    finally:
        if original_compat is not None:
            _attend._sdpa_kernel_compat = original_compat

    report["sdpa_compat_calls"] = int(calls["n"])
    report["model_load_seconds"] = float(model_load_seconds)
    report["demix_seconds"] = float(demix_seconds)
    report["hifi_overlap"] = HIFI_OVERLAP
    report["pipeline"] = PIPELINE_HIFI
    if torch.cuda.is_available():
        report["vram_allocated_mb"] = round(
            torch.cuda.max_memory_allocated() / 1024**2, 1)
        report["vram_reserved_mb"] = round(
            torch.cuda.max_memory_reserved() / 1024**2, 1)

    # Üç SW stem'i (vokal, piyano, davul): şekil, seviye, NaN/Inf. _hifi_demix
    # zaten NaN/Inf'te hata veriyor; alanlar raporda dursun ki "kontrol
    # edildi" görünür olsun.
    report["stems"] = {}
    for name, array in sw_stems.items():
        report["stems"][name] = {
            "shape": [int(v) for v in array.shape],
            "rms": round(_rms_f64(array), 8),
            "peak": round(float(np.abs(array).max()), 6),
            "nan_or_inf": bool(np.isnan(array).any() or np.isinf(array).any()),
        }
    report["vocals_shape"] = report["stems"]["vocals"]["shape"]
    report["vocals_rms"] = report["stems"]["vocals"]["rms"]
    report["vocals_peak"] = report["stems"]["vocals"]["peak"]
    report["nan_or_inf"] = bool(any(v["nan_or_inf"] for v in report["stems"].values()))

    # --- deneydeki çıktılarla karşılaştırma -------------------------------
    def compare_stem(stem_name: str, reference_id: str) -> dict:
        ours = sw_stems[stem_name].astype(np.float64)
        reference_path = _song_dir(reference_id) / "master" / f"{stem_name}.flac"
        if not reference_path.is_file():
            return {
                "found": False,
                "reference": reference_id,
                "stem": stem_name,
                "note": (f"deney cikisi ({reference_id}/{stem_name}) Volume'da yok; "
                         "sekil, RMS ve NaN/Inf kontrolleri yapildi"),
            }
        data, reference_sr = sf.read(str(reference_path), dtype="float64",
                                     always_2d=True)
        theirs = data.T
        length = min(ours.shape[1], theirs.shape[1])
        first = ours[:, :length]
        second = theirs[:, :length]
        # Deney stem'leri ortak bir clip_scale'e BÖLÜNMÜŞ kaydedilmiş; ölçek
        # en küçük karelerle geri kestiriliyor.
        denominator = float(np.sum(second * second))
        scale = float(np.sum(first * second) / denominator) if denominator > 0 else 0.0
        diff = first - scale * second
        rms_ours = float(np.sqrt(np.mean(first ** 2)))
        rms_diff = float(np.sqrt(np.mean(diff ** 2)))
        max_diff = float(np.abs(diff).max())
        # FLAC PCM_24: ±1 tam ölçekte adım 2^-23; ölçek geri uygulandığı için
        # bizim birimlerimizde adım `scale` katı.
        quant_step = scale * 2.0 ** -23
        snr_db = (round(20.0 * float(np.log10(rms_ours / rms_diff)), 1)
                  if rms_diff > 0 and rms_ours > 0 else 999.0)

        # Kararın ÜÇ kademesi: >=90 dB niceleme düzeyinde aynı, 60-90 dB
        # duyulmaz ama gerçek küçük fark (UYARI), altı HATA.
        verdict_note = ""
        if snr_db >= 90.0:
            verdict = "ayni (FLAC niceleme duzeyinde)"
            verdict_level = "ok"
        elif snr_db >= 60.0:
            verdict = ("fark duyulmaz duzeyde; deney GPU'su veya decode "
                       "farkli olabilir")
            verdict_level = "uyari"
            # Bu bahane BURADA GEÇERSİZ ve bunu biliyoruz: deney de T4'te ve
            # AYNI decode'la koştu (reference_run).
            if (REFERENCE_RUN["gpu"] == "T4"
                    and REFERENCE_RUN["decode_identical"]):
                verdict_note = (
                    "AMA deney de T4'te ve ayni decode ile kostu, yani GPU/"
                    "decode farki bu araligi ACIKLAMIYOR - sebep baska "
                    "(vendored dosya, agirlik, overlap, precision?)"
                )
        else:
            verdict = "FARK VAR"
            verdict_level = "hata"

        # Kestirilen ölçek = üretim/deney. Deney stem'leri clip_scale >= 1'e
        # BÖLÜNMÜŞ kaydedildiği için deney/üretim oranı 1.0 ya da biraz altı
        # olmak zorunda. 1.01'in üstü kazanç hatası demek; 0.7'nin altı
        # şüpheli (clip_scale büyük bir tepeden gelmiş olabilir).
        ratio = round(1.0 / scale, 6) if scale > 0 else -1.0
        scale_note = ""
        if ratio < 0.0:
            scale_level = "hata"
            scale_note = "olcek kestirilemedi: referans sessiz ya da isaret ters"
        elif ratio > 1.01:
            scale_level = "hata"
            scale_note = ("deney/uretim orani 1.01'in ustunde: normalizasyon "
                          "ya da ref_mean tarafinda kazanc hatasi")
        elif ratio < 0.7:
            scale_level = "uyari"
            scale_note = ("deney/uretim orani 0.7'nin altinda: clip_scale "
                          "beklenenden buyuk, tepeler karsilastirilmali")
        else:
            scale_level = "ok"

        return {
            "found": True,
            "stem": stem_name,
            "reference": reference_id,
            "reference_samplerate": int(reference_sr),
            "reference_samples": int(theirs.shape[1]),
            "length_match": bool(ours.shape[1] == theirs.shape[1]),
            "reference_run": dict(REFERENCE_RUN),
            "clip_scale_estimated": round(scale, 6),
            "ratio_reference_over_ours": ratio,
            "scale_level": scale_level,
            "scale_note": scale_note,
            "max_abs_diff": float(f"{max_diff:.3e}"),
            "rms_diff": float(f"{rms_diff:.3e}"),
            "snr_db": snr_db,
            "flac_quant_step": float(f"{quant_step:.3e}"),
            "max_diff_in_quant_steps": (round(max_diff / quant_step, 2)
                                        if quant_step > 0 else -1.0),
            "verdict": verdict,
            "verdict_level": verdict_level,
            "verdict_note": verdict_note,
        }

    # vokal: HER varyantta aynı SW çıktısı (V0 = compare_suffix); piyano ve
    # davul: V2o (extra_suffix), o yönünde bu iki stem TAM SW çıktısı.
    report["compare"] = compare_stem("vocals", f"{song_id}-{compare_suffix}")
    report["compare_extra"] = {
        name: compare_stem(name, f"{song_id}-{extra_suffix}")
        for name in ("piano", "drums")
    }

    # --- import yalıtımı: üretim yolu ne yükledi? ------------------------
    # Üretim YALNIZCA bs_roformer'ı kullanıyor. mel_band_roformer (deneyin A
    # ve E kolları) ve utils.model_utils (referans kontrolü) canlı yolda
    # İMPORT EDİLMEMELİ - edilirse imajda olmayan bir bağımlılığa (librosa,
    # ml_collections) sessizce bağlanmış oluruz.
    loaded = sorted(
        name for name in sys.modules
        if name == "models" or name.startswith("models.")
        or name == "utils" or name.startswith("utils.")
    )
    forbidden = sorted(
        name for name in loaded
        if "mel_band_roformer" in name or name == "utils"
        or name.startswith("utils.")
    )
    report["loaded_modules"] = [str(name) for name in loaded]
    report["forbidden_modules"] = [str(name) for name in forbidden]
    report["import_isolation_ok"] = bool(not forbidden)

    report["wall_seconds"] = round(time.time() - wall_started, 2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return _assert_plain(report)


@app.local_entrypoint()
def hifi_smoke(song_id: str = "", must_contain: str = "HAZBIN",
               compare_suffix: str = "pdm", extra_suffix: str = "pdt"):
    """Hi-Fi SW yolunun (vokal/piyano/davul) GPU duman testi (Volume'a yazmıyor).

        modal run backend/app.py::hifi_smoke
        modal run backend/app.py::hifi_smoke --song-id <id>

    Varsayılan referanslar HAZBIN'in madde 7 deney çıktıları: `pdm` = V0 (vokal
    her varyantta aynı SW çıktısı), `pdt` = V2o (piyano ve davul tam SW çıktısı).
    Deney şarkıları silindikten sonra referans bulunamaz: karşılaştırma atlanır,
    şekil/RMS/NaN kontrolleri yine yapılır (UYARI verir, hata değil).
    """
    report = hifi_smoke_run.remote(song_id=song_id, must_contain=must_contain,
                                   compare_suffix=compare_suffix,
                                   extra_suffix=extra_suffix)

    problems = []
    warnings = []
    if report.get("nan_or_inf"):
        problems.append("vokal cikisinda NaN/Inf var")
    if not report.get("import_isolation_ok"):
        problems.append("canli yol fazla modul import etti: "
                        f"{report.get('forbidden_modules')}")
    if not report.get("patch_present"):
        problems.append("attend.py'de _sdpa_kernel_compat yok (yama kayip)")
    compares = {"vocals": report.get("compare") or {}}
    compares.update(report.get("compare_extra") or {})
    for stem_name, compare in compares.items():
        if not compare.get("found"):
            warnings.append(f"{stem_name}: karsilastirma yapilamadi: {compare.get('note')}")
            continue
        if not compare.get("length_match"):
            problems.append(f"{stem_name}: uzunluklar tutmuyor: parca izgarasi "
                            "kaymis olabilir")
        # SNR üç kademeli: >=90 dB sessiz geç, 60-90 dB UYARI, altı HATA.
        line = (f"{stem_name}: {compare.get('reference')} ile SNR "
                f"{compare.get('snr_db')} dB, max fark "
                f"{compare.get('max_abs_diff')} -> {compare.get('verdict')}")
        if compare.get("verdict_note"):
            line += f" | {compare.get('verdict_note')}"
        if compare.get("verdict_level") == "hata":
            problems.append(line)
        elif compare.get("verdict_level") == "uyari":
            warnings.append(line)
        # Ölçek: >1.01 HATA, <0.7 UYARI.
        if compare.get("scale_note"):
            scale_line = (f"{stem_name}: deney/uretim orani "
                          f"{compare.get('ratio_reference_over_ours')}: "
                          f"{compare.get('scale_note')}")
            if compare.get("scale_level") == "hata":
                problems.append(scale_line)
            else:
                warnings.append(scale_line)
    for stem_name, info in (report.get("stems") or {}).items():
        if info.get("rms", 0) <= 0:
            warnings.append(f"{stem_name}: SW stem'i tamamen sessiz (sarki icin normal olabilir)")
    if report.get("sdpa_compat_calls") == 0:
        warnings.append("flash kapali, yamali satir uretimde de calismiyor; "
                        "yama gereksiz ama zararsiz")
    if not report.get("samplerate_channels_match_demucs"):
        warnings.append("konfig 44100/2 demiyor; uretimde uyusmazlik kontrolu "
                        "_hifi_stems icinde yapiliyor")

    print("")
    print("=" * 72)
    print(f"{report.get('title')}  ({report.get('duration')} sn, "
          f"{report.get('samples')} ornek)")
    print(f"torch {report.get('torch')} / cuda {report.get('torch_cuda')} / "
          f"{report.get('gpu')}")
    print(f"model yukleme {report.get('model_load_seconds')} sn, cikarim "
          f"{report.get('demix_seconds')} sn, toplam {report.get('wall_seconds')} sn, "
          f"vram {report.get('vram_allocated_mb')} MB")
    print(f"vokal sekli {report.get('vocals_shape')}, rms "
          f"{report.get('vocals_rms')}, tepe {report.get('vocals_peak')}, "
          f"NaN/Inf: {report.get('nan_or_inf')}")
    print(f"yamali satir cagri sayisi: {report.get('sdpa_compat_calls')} "
          f"(set_priority destegi: {report.get('set_priority_supported')})")
    print(f"yuklenen models/utils modulleri: {report.get('loaded_modules')}")
    print(f"boru hatti: {report.get('pipeline')}; SW stem'leri: "
          + ", ".join(f"{k} rms {v.get('rms')} tepe {v.get('peak')}"
                      for k, v in (report.get("stems") or {}).items()))
    for stem_name, compare in compares.items():
        if not compare.get("found"):
            continue
        run = compare.get("reference_run") or {}
        print(f"[{stem_name}] referans {compare.get('reference')}: "
              f"SNR {compare.get('snr_db')} dB, max fark "
              f"{compare.get('max_abs_diff')} = "
              f"{compare.get('max_diff_in_quant_steps')} FLAC niceleme adimi; "
              f"oran {compare.get('ratio_reference_over_ours')} "
              f"({compare.get('scale_level')}); karar: {compare.get('verdict')}")
        if compare.get("verdict_note"):
            print(f"       {compare.get('verdict_note')}")
    for line in warnings:
        print(f"UYARI: {line}")
    print("=" * 72)
    if problems:
        for line in problems:
            print(f"HATA: {line}")
        raise SystemExit(1)
    print("DUMAN TESTI GECTI")


# --------------------------------------------------------------------------
# Aşama 10 - alt parçalar (oturum 1: vokal -> ana / arka)
# --------------------------------------------------------------------------
# CANLI SİSTEME BAĞLI DEĞİL: bu bölümdeki hiçbir şey `separate`, `api` ya da
# status.json'ın canlı alanlarına dokunmuyor; yalnız `modal run` ile deney.
#
# Model: becruily/mel-band-roformer-karaoke (Mel-Band Roformer, 2 çıkış:
# Vocals = ANA vokal, Instrumental = müzik + arka vokal). Lisansı belirsiz
# (model kartı yok; HF tartışması #1'de sahibi "ticari olmadıkça serbest"
# demiş), kişisel kullanım, bkz. NOTICE.md. Ağırlık depoda DEĞİL, Volume'a
# sha256 doğrulamalı iniyor.
#
# Girdi iki yoldan denenir (PLAN.md Aşama 10 notu): "stem" = SW vokal stem'i,
# "mix" = tam karışım. Karaoke modelleri genelde tam karışımla eğitilir,
# "izole vokalle eğitildi" varsayımı DOĞRULANMADI. İki yolda da:
#     ana = model çıktısı,  arka = SW vokal - ana
# yani ana + arka = SW vokal yapısal olarak (float'ta) tam tutar.

SUB_WEIGHTS_SUBDIR = "weights-sub"
SUB_EXP_SUBDIR = "sub-exp"
SUB_KARAOKE_REV = "0c149975cfaa261c7d87baf54330a9da85bcf888"
SUB_KARAOKE_BASE = ("https://huggingface.co/becruily/mel-band-roformer-karaoke/"
                    f"resolve/{SUB_KARAOKE_REV}")
SUB_KARAOKE_CKPT = "mel_band_roformer_karaoke_becruily.ckpt"
SUB_KARAOKE_CKPT_SHA256 = "d3aa262ac01df870b9fc033e9c7b6cad33fe04fc9c148b6c40841326a515a0e0"
SUB_KARAOKE_CKPT_BYTES = 1719139254
SUB_KARAOKE_YAML = "config_karaoke_becruily.yaml"
SUB_KARAOKE_YAML_SHA256 = "cd37b0dcc285fc22d88090415722ac7127ee1d9ea2f3346c3b8d8fcc61e0c74b"
SUB_KARAOKE_YAML_BYTES = 1724
# Örtüşme: config 8 diyor; üretimdeki Hi-Fi gibi 2 ile başlıyoruz (maliyet 4x
# düşük). Deneyde --overlap ile değiştirilebilir.
SUB_OVERLAP = 2
SUB_USD_PER_SECOND = 0.000164     # T4, PLAN.md maliyet tablosuyla aynı
SUB_WINDOW_SEC = 2.0
SUB_EXCERPT_SECONDS = 10.0
SUB_EXCERPT_GAP = 1.0
SUB_EXCERPT_FADE = 0.020
SUB_PATHS = ("stem", "mix")
SUB_DRUM_OVERLAP = 4     # MDX23C config inference.num_overlap (config değeri)

# --- Üretim kapıları (PLAN.md Aşama 10, ölçümle onaylı) ---------------------
# 1) "Vokal yok": SW vokal RMS < -50 dBFS => model ÇALIŞMAZ, GPU açılmaz. Bu
#    kontrol API konteynerinde (CPU, ffmpeg astats) yapılıyor. Ölçüm: 6 gerçek
#    vokal -17.5..-25.1 dBFS, Final Duet -118.7 dBFS.
# 2) Lead payı = ana güç / (ana + arka güç): < 0.10 güvenilmez (dosya YAZILMAZ),
#    0.10-0.50 yazılır + "ayrım güvenilmez olabilir" rozeti, >= 0.50 temiz.
#    Ölçüm (stem yolu): Zeus 0.98, Usseewa 0.96, HAZBIN 0.76, NEM slowed 0.37,
#    Ado 8D 0.249, Below The Surface 0.02.
SUB_SILENT_DBFS = -50.0
SUB_LEAD_UNRELIABLE = 0.10
SUB_LEAD_WARN = 0.50
SUB_RUNNING_STALE_SECONDS = 2400     # bundan uzun "running" = takılmış, yeniden denenebilir
SUB_PART_NAMES = ("lead", "backing")

# --- Gruplar (Aşama 10): her ana kanalın KENDİ durumu, KENDİ dosyaları ---------
# vocals: durum `status.sub` (eski ad, canlıdaki istemciler bunu okuyor; DEĞİŞMEDİ)
# drums : durum `status.sub_drums`
# Dosyalar ortak dizinde (`master/sub`, `stems/sub`), adları farklı: bir grubun
# yazımı/yeniden koşumu ötekinin dosyasına ve durumuna DOKUNMAZ.
# 5 kanal. Model artığı (davul - toplam, güç payı HER ŞARKIDA < %1) AYRI kanal
# DEĞİL: sunucuda toms'a eklenir, toplam yine tam (PLAN.md Aşama 10 oturum 5).
SUB_DRUM_PARTS = ("kick", "snare", "toms", "hihat", "cymbals")
# Yumuşak uyarı (SERT KAPI YOK): toms güç payı >= %8 VE toms tonal (HPSS) payı >= 0.9
# => `reliability: "warn"` ("Tom kanalına başka enstrüman sızmış olabilir").
# Eşik 6 şarkıdan türedi, KULAKLA DOĞRULANACAK (PLAN.md).
SUB_DRUM_WARN_TOMS_POWER = 0.08
SUB_DRUM_WARN_TOMS_TONAL = 0.9
SUB_GROUP_CFG = {
    "vocals": {"stem": "vocals", "key": "sub", "parts": SUB_PART_NAMES},
    "drums": {"stem": "drums", "key": "sub_drums", "parts": SUB_DRUM_PARTS},
}
SUB_ALL_PARTS = tuple(name for cfg in SUB_GROUP_CFG.values() for name in cfg["parts"])
# "Davul yok" kapısı (CPU, GPU açılmaz). Eşik canlı şarkıların davul
# seviyelerinden türetildi (bkz. PLAN.md Aşama 10, oturum 4).
SUB_DRUMS_SILENT_DBFS = -50.0

# --- DrumSep MDX23C (aufr33 & jarredou), 6 çıkış: kick snare toms hh ride crash.
# Orijinal kaynak (jarredou GitHub/HF) SİLİNMİŞ (404, 2026-10-01). İki BAĞIMSIZ
# aynada checkpoint sha256'sı BİREBİR aynı (Sucial/MSST-WebUI, lainlives/audio-
# separator-models), SW modelindekiyle aynı mantık: aynı hash = orijinal dosya.
# Lisans BELİRSİZ, kişisel kullanım: NOTICE.md.
SUB_DRUM_CKPT = "drumsep_mdx23c_aufr33_jarredou.ckpt"
SUB_DRUM_CKPT_URL = ("https://huggingface.co/Sucial/MSST-WebUI/resolve/"
                     "90b617b15bd0dc0b784f3d361faca1b51173fe44/All_Models/multi_stem_models/"
                     "aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.ckpt")
SUB_DRUM_CKPT_SHA256 = "d2a4aa53eb584d21eead358a4e66d1882ad182911be018f052b5da73be9096d0"
SUB_DRUM_CKPT_BYTES = 437652699
SUB_DRUM_YAML = "drumsep_mdx23c_aufr33_jarredou.yaml"
SUB_DRUM_YAML_URL = ("https://huggingface.co/lainlives/audio-separator-models/resolve/"
                     "3b39120409f3c2d50e9cc4c391f4169131e9d643/"
                     "aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.yaml")
SUB_DRUM_YAML_SHA256 = "440a13f67461b2cdad2bb1cb86c08ff27a8ec53093c4a24d4d7fc2c19cb9f5f5"
SUB_DRUM_YAML_BYTES = 2417
# Model çıkışları (config.training.instruments, küçük harf) -> parça adları.
# ride + crash SUNUCUDA tek "cymbals"; model artığı (davul - toplam) toms'a eklenir.
SUB_DRUM_MODEL_OUTPUTS = ("kick", "snare", "toms", "hh", "ride", "crash")


def _sub_lead_share(lead_rel_db: float, backing_rel_db: float) -> float:
    """Ana gücün (ana + arka) gücüne oranı; dB değerleri vokale göre."""
    lead = 10.0 ** (float(lead_rel_db) / 10.0)
    backing = 10.0 ** (float(backing_rel_db) / 10.0)
    total = lead + backing
    return lead / total if total > 0 else 0.0


def _sub_lead_gate(share: float) -> str:
    """'unreliable' | 'warn' | 'ok'."""
    if share < SUB_LEAD_UNRELIABLE:
        return "unreliable"
    if share < SUB_LEAD_WARN:
        return "warn"
    return "ok"


def _sub_vocal_gate(rms_dbfs: float) -> str:
    """'no_vocals' | 'ok'."""
    return "no_vocals" if float(rms_dbfs) < SUB_SILENT_DBFS else "ok"


_ASTATS_RMS = re.compile(r"RMS level dB:\s*(-?inf|[-+]?\d+(?:\.\d+)?)", re.IGNORECASE)


def _parse_astats_rms(text: str) -> float:
    """ffmpeg astats çıktısından GENEL (Overall) RMS seviyesi, dBFS.

    Çıktıda önce kanal bölümleri, en sonda 'Overall' bölümü var; son 'Overall'dan
    sonraki ilk 'RMS level dB' alınır. Tamamen sessizlikte ffmpeg '-inf' yazar:
    -200 sayılıyor.
    """
    index = text.rfind("Overall")
    if index < 0:
        raise ValueError("astats ciktisinda 'Overall' bolumu yok")
    match = _ASTATS_RMS.search(text, index)
    if not match:
        raise ValueError("astats ciktisinda 'RMS level dB' yok")
    value = match.group(1).lower()
    if value.endswith("inf"):
        return -200.0
    return float(value)


def _sub_vocal_level(path: pathlib.Path) -> float:
    """SW vokal stem'inin RMS seviyesi (dBFS), CPU'da, model/torch YOK."""
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-v", "info", "-i", str(path),
         "-af", "astats=metadata=0:reset=0", "-f", "null", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")[-1500:] if proc.stderr else ""
        raise RuntimeError(f"ffmpeg astats basarisiz (kod {proc.returncode}): {err}")
    return _parse_astats_rms(proc.stderr.decode("utf-8", "replace"))


def _sub_is_running(status, group=None) -> bool:
    """Alt ayrım sürüyor mu? (group verilmezse HERHANGİ bir grup.) Çok uzun
    süredir 'running' ise TAKILMIŞ sayılır."""
    groups = [group] if group else list(SUB_GROUP_CFG)
    for name in groups:
        sub = (status or {}).get(SUB_GROUP_CFG[name]["key"]) or {}
        if sub.get("state") != "running":
            continue
        started = float(sub.get("started") or 0)
        if (time.time() - started) < SUB_RUNNING_STALE_SECONDS:
            return True
    return False


def _sub_drop(song_id: str) -> bool:
    """Alt parçaları ve status.sub'ı siler (ana şarkı yeniden işlenirken).

    Ana stem değişince alt parçaların toplamı artık tutmaz; bayat bırakılmaz.
    Dönen: bir şey silindi mi.
    """
    song_dir = _song_dir(song_id)
    removed = False
    for part in (song_dir / "master" / "sub", song_dir / "stems" / "sub"):
        if part.exists():
            shutil.rmtree(part, ignore_errors=True)
            removed = True
    status_path = song_dir / "status.json"
    if status_path.is_file():
        data = json.loads(status_path.read_text(encoding="utf-8"))
        dropped = False
        for cfg in SUB_GROUP_CFG.values():          # TÜM gruplar (vokal + davul)
            if cfg["key"] in data:
                data.pop(cfg["key"])
                dropped = True
        if dropped:
            status_path.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
            removed = True
    if removed:
        volume.commit()
    return removed


def _sub_remove_part_files(song_id: str, parts) -> None:
    """YALNIZ verilen parçaların dosyaları (öteki grubun dosyalarına dokunma)."""
    song_dir = _song_dir(song_id)
    legacy = ("drumsother",) if "toms" in parts else ()   # oturum 4 denemesinden kalma
    for name in (*parts, *legacy):
        (song_dir / "master" / "sub" / f"{name}.flac").unlink(missing_ok=True)
        (song_dir / "stems" / "sub" / f"{name}.m4a").unlink(missing_ok=True)

# GPU imajı. Hi-Fi `separate_image`ından AYRI: Mel-Band Roformer'ın mel filtre
# bankası librosa istiyor ve canlı imaja (demucs ağırlığını build'de gömen,
# deploy edilmiş) librosa eklemek onu yeniden build ettirirdi. demucs YOK.
sub_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "torch==2.5.1",
        "numpy==1.26.4",
        "soundfile==0.13.1",
    )
    .pip_install(
        "einops==0.8.2",
        "rotary-embedding-torch==0.9.1",
        "beartype==0.19.0",
        "librosa==0.11.0",         # mel filtre bankası + davul metriği (HPSS)
        "numba==0.62.1",
        "PyYAML==6.0.2",
        "tqdm==4.67.1",
        # MDX23C (davul): utils.model_utils import ediyor ve config'i ConfigDict
        # (öznitelik erişimi) olarak bekliyor. experiment.py imajıyla AYNI sürüm.
        "ml-collections==1.0.0",
    )
    .add_local_dir(MSST_LOCAL, MSST_DIR)
)

# Kesit/yazım imajı: torch YOK.
sub_cpu_image = light_image.pip_install("numpy==1.26.4", "soundfile==0.13.1")

_SUB_CONTAINER_START = time.time()
_SUB_FIRST_CALL = True


def _sub_weights_dir() -> pathlib.Path:
    return pathlib.Path(DATA_DIR) / SUB_WEIGHTS_SUBDIR


def _sub_exp_dir(song_id: str) -> pathlib.Path:
    """Deney çıktı klasörü; kimlik doğrulanıyor (yol dışarı çıkamaz)."""
    if not _is_valid_song_id(song_id):
        raise ValueError(f"gecersiz sarki kimligi: {str(song_id)[:80]!r}")
    return pathlib.Path(DATA_DIR) / SUB_EXP_SUBDIR / song_id


@app.function(
    image=light_image,
    volumes={DATA_DIR: volume},
    timeout=3600,
)
def fetch_sub_weights() -> dict:
    """Karaoke ağırlığını Volume'a indirir ve sha256 doğrular.

        modal run backend/app.py::sub_fetch

    Ağırlık depoda DAĞITILMIYOR. İndirme geçici adla yapılıp doğrulanınca
    yerine konuyor: yarım/bozuk dosya asla gerçek adla durmaz. 1.7 GB olduğu
    için belleğe okunmuyor, parça parça yazılıyor.
    """
    import urllib.request

    volume.reload()
    target_dir = _sub_weights_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    report = {}

    for name, sha, size in (
        (SUB_KARAOKE_CKPT, SUB_KARAOKE_CKPT_SHA256, SUB_KARAOKE_CKPT_BYTES),
        (SUB_KARAOKE_YAML, SUB_KARAOKE_YAML_SHA256, SUB_KARAOKE_YAML_BYTES),
    ):
        target = target_dir / name
        if target.exists():
            try:
                _verify_sha256(target, sha, size)
                print(f"[atla] {name} zaten var ve dogrulandi")
                report[name] = {"downloaded": False, "sha256": sha}
                continue
            except ValueError:
                print(f"[yeniden] {name} dogrulanamadi, tekrar iniyor")

        url = f"{SUB_KARAOKE_BASE}/{name}"
        partial = target_dir / (name + ".part")
        print(f"[indir] {name} <- {url}")
        started = time.time()
        with urllib.request.urlopen(url, timeout=600) as response, \
                partial.open("wb") as handle:
            while True:
                block = response.read(8 * 1024 * 1024)
                if not block:
                    break
                handle.write(block)
        try:
            _verify_sha256(partial, sha, size)
        except ValueError:
            partial.unlink(missing_ok=True)
            raise
        partial.replace(target)
        seconds = round(time.time() - started, 1)
        print(f"[dogrulandi] {name} {seconds} sn, sha256={sha}")
        report[name] = {"downloaded": True, "bytes": int(target.stat().st_size),
                        "seconds": seconds}

    volume.commit()
    return _assert_plain(report)


@app.local_entrypoint()
def sub_fetch():
    print(json.dumps(fetch_sub_weights.remote(), ensure_ascii=False, indent=2))


def _sub_load_karaoke():
    """Karaoke modelini yükler (cuda). Dönen: (model, config, vokal_indeksi, sn)."""
    import sys

    import torch

    weights = _sub_weights_dir()
    ckpt = weights / SUB_KARAOKE_CKPT
    config_path = weights / SUB_KARAOKE_YAML
    if not ckpt.is_file() or not config_path.is_file():
        raise FileNotFoundError(
            f"Karaoke agirliklari yok: {ckpt}. "
            f"'modal run backend/app.py::sub_fetch' calistirilmali."
        )
    started = time.time()
    _verify_sha256(ckpt, SUB_KARAOKE_CKPT_SHA256, SUB_KARAOKE_CKPT_BYTES)
    _verify_sha256(config_path, SUB_KARAOKE_YAML_SHA256, SUB_KARAOKE_YAML_BYTES)
    config = _load_hifi_config(config_path)
    if int(config["audio"]["sample_rate"]) != 44100:
        raise ValueError(f"beklenmeyen ornekleme hizi: {config['audio']['sample_rate']}")
    names = [str(item).lower() for item in config["training"]["instruments"]]
    if "vocals" not in names:
        raise ValueError(f"karaoke konfiginde 'vocals' yok: {names}")

    if MSST_DIR not in sys.path:
        sys.path.insert(0, MSST_DIR)
    from models.bs_roformer.mel_band_roformer import MelBandRoformer

    model = MelBandRoformer(**dict(config["model"]))
    state = torch.load(str(ckpt), map_location="cpu", weights_only=False)
    if isinstance(state, dict):
        for key in ("state_dict", "model", "model_state_dict"):
            if key in state and isinstance(state[key], dict):
                state = state[key]
                break
    if any(name.startswith("module.") for name in state):
        state = {name.removeprefix("module."): value for name, value in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        # strict=False sessiz geçerse yanlış mimariyle rastgele ağırlık çalışır.
        raise ValueError(f"karaoke ckpt uyusmuyor: eksik={len(missing)} fazla={len(unexpected)} "
                         f"(ilk eksikler: {missing[:3]})")
    model.to("cuda")
    model.eval()
    seconds = round(time.time() - started, 2)
    print(f"[sub] karaoke modeli {seconds} sn'de hazir; ciktilar={names}")
    return model, config, names.index("vocals"), seconds


def _sub_rms(array) -> float:
    import numpy as np

    data = np.asarray(array, dtype=np.float64)
    return float(np.sqrt(np.mean(data ** 2))) if data.size else 0.0


def _sub_db(value: float, reference: float) -> float:
    import math

    if value <= 0.0 or reference <= 0.0:
        return -200.0
    return round(20.0 * math.log10(value / reference), 2)


def _sub_window_levels(array, reference_rms: float, samplerate: int) -> list:
    """2 sn'lik pencerelerde RMS, `reference_rms`'e göre dB (liste, düz float)."""
    import numpy as np

    size = int(SUB_WINDOW_SEC * samplerate)
    count = array.shape[1] // size
    return [_sub_db(float(np.sqrt(np.mean(array[:, i * size:(i + 1) * size].astype(np.float64) ** 2))),
                    reference_rms) for i in range(count)]


def _sub_metrics(vocal, lead, backing, samplerate: int) -> dict:
    """Ana/arka/SW vokal arasındaki ölçümler (hepsi düz Python)."""
    import numpy as np

    vocal_rms = _sub_rms(vocal)
    peak = max(float(abs(vocal).max()), float(abs(lead).max()), float(abs(backing).max()))
    scale = 1.0 / max(1.0, 1.01 * peak)           # FLAC'a yazılırken uygulanacak ortak ölçek

    def quantize(x):
        return np.round(x.astype(np.float64) * scale * 8388607.0) / 8388607.0

    err = lead.astype(np.float64) + backing.astype(np.float64) - vocal.astype(np.float64)
    err_q = quantize(lead) + quantize(backing) - quantize(vocal)

    mono_lead = lead.mean(axis=0).astype(np.float64)
    mono_back = backing.mean(axis=0).astype(np.float64)
    denominator = float(np.sqrt(np.dot(mono_lead, mono_lead) * np.dot(mono_back, mono_back)))
    correlation = float(np.dot(mono_lead, mono_back) / denominator) if denominator > 0 else 0.0

    window = _sub_window_levels(backing, vocal_rms, samplerate)
    return {
        "vocal_rms_db": _sub_db(vocal_rms, 1.0),
        "lead_rel_db": _sub_db(_sub_rms(lead), vocal_rms),
        "backing_rel_db": _sub_db(_sub_rms(backing), vocal_rms),
        "sum_err_db": _sub_db(_sub_rms(err), vocal_rms),
        "sum_err_flac24_db": _sub_db(_sub_rms(err_q), vocal_rms),
        "lead_backing_corr": round(correlation, 4),
        "backing_windows_over_m20db": int(sum(1 for v in window if v > -20.0)),
        "windows": len(window),
        "backing_window_db": window,
        "peak": round(peak, 4),
    }


def _sub_produce(song_id: str, status: dict, vocal, lead, backing, metrics: dict,
                 seconds: dict) -> dict:
    """Kapıyı uygular; güvenilirse dosyaları ve status.sub'ı yazar.

    Sıra: ÖNCE dosyalar, SONRA status (state=done gören okuyucu dosyaları
    bulur). Güvenilmezse (lead payı < 0.10) HİÇBİR dosya yazılmaz.
    """
    import numpy as np
    import soundfile as sf

    share = _sub_lead_share(metrics["lead_rel_db"], metrics["backing_rel_db"])
    gate = _sub_lead_gate(share)
    base = {
        "lead_share": round(share, 4),
        "lead_rel_db": metrics["lead_rel_db"],
        "backing_rel_db": metrics["backing_rel_db"],
        "sum_err_db": metrics["sum_err_db"],
        "sum_err_flac24_db": metrics["sum_err_flac24_db"],
        "parent_stems_version": status.get("stems_version"),
        "parent_pipeline": status.get("pipeline"),
        "model": {"name": "becruily/mel-band-roformer-karaoke", "rev": SUB_KARAOKE_REV,
                  "input": "stem", "overlap": SUB_OVERLAP},
        "thresholds": {"silent_dbfs": SUB_SILENT_DBFS, "unreliable": SUB_LEAD_UNRELIABLE,
                       "warn": SUB_LEAD_WARN},
        "seconds": seconds,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    song_dir = _song_dir(song_id)
    # Yeniden koşumda eski dosyalar kalmasın; YALNIZ vokal parçaları (davul
    # grubunun dosyaları ve durumu korunur).
    _sub_remove_part_files(song_id, SUB_PART_NAMES)

    if gate == "unreliable":
        sub = {**base, "state": "unreliable", "parts": {}}
        _write_status(song_id, sub=sub)
        print(f"[sub] GUVENILMEZ: lead payi {share:.3f} < {SUB_LEAD_UNRELIABLE}; dosya yazilmadi")
        return sub

    # Tepe 1'i aşarsa (model taşırması) ikisi ORTAK ölçekle yazılır; aşmıyorsa dokunulmaz.
    peak = max(float(abs(lead).max()), float(abs(backing).max()))
    scale = 1.0 if peak <= 1.0 else 1.0 / (1.01 * peak)
    master_dir = song_dir / "master" / "sub"
    stems_dir = song_dir / "stems" / "sub"
    master_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)
    for name, array in (("lead", lead), ("backing", backing)):
        flac_path = master_dir / f"{name}.flac"
        sf.write(str(flac_path), (array * np.float32(scale)).T, 44100,
                 subtype=FLAC_SUBTYPE, format="FLAC")
        _encode_stem_m4a(flac_path, stems_dir / f"{name}.m4a", 2)
    sub = {**base, "state": "done", "reliability": gate,
           "version": int(time.time()), "clip_scale": round(scale, 6),
           "parts": {"vocals": list(SUB_PART_NAMES)}}
    _write_status(song_id, sub=sub)
    print(f"[sub] yazildi: lead payi {share:.3f} ({gate}), surum {sub['version']}")
    return sub


@app.function(
    image=sub_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=1800,
    max_containers=1,       # min_containers YOK: boştayken maliyet sıfır
)
def separate_sub(song_id: str, paths: str = "stem", overlap: int = SUB_OVERLAP,
                 experiment: bool = False, production: bool = False,
                 group: str = "vocals") -> dict:
    """Vokali ana / arka vokale böler.

    paths: "stem" (SW vokal stem'i girdi), "mix" (tam karışım girdi) ya da
    "stem,mix". Model BİR kez yüklenir. Ana = model çıktısı, arka = SW vokal -
    ana (her iki yolda).

    experiment=True: `/data/sub-exp/<id>/<yol>/` altına ana/arka float32 WAV
    yazılır (kulak testi kesitleri için). Canlı şarkıya HİÇBİR ŞEY yazılmaz;
    status.json'a dokunulmaz. (Üretimde `stems/sub/` + `status.sub` sonraki
    oturumların işi.)

    production=True: üretim modu (API'den). Yalnız "stem" yolu; lead payı kapısı
    uygulanır; güvenilirse `master/sub/` + `stems/sub/` + `status.sub` yazılır,
    güvenilmezse yalnız `status.sub` (state=unreliable). Hata olursa
    `status.sub.state = "error"`. "Vokal yok" kapısı BURADA DEĞİL, API'de (CPU):
    GPU konteyneri açılmadan elenir.

    Dönen: ölçümler, süreler ve maliyet tahmini (düz Python).
    """
    global _SUB_FIRST_CALL

    if group not in SUB_GROUP_CFG:
        raise ValueError(f"bilinmeyen grup: {group!r}")
    key = SUB_GROUP_CFG[group]["key"]
    if production:
        try:
            if group == "drums":
                return _separate_sub_drums_impl(song_id, overlap, True)
            return _separate_sub_impl(song_id, "stem", overlap, False, True)
        except Exception as error:     # durumu "çalışıyor"da bırakma
            with contextlib.suppress(Exception):
                volume.reload()
                _write_status(song_id, **{key: {
                    "state": "error", "error": str(error)[:300],
                    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}})
            raise
    if group == "drums":
        return _separate_sub_drums_impl(song_id, overlap, False)
    return _separate_sub_impl(song_id, paths, overlap, experiment, False)


def _separate_sub_impl(song_id: str, paths: str, overlap: int, experiment: bool,
                       production: bool) -> dict:
    global _SUB_FIRST_CALL

    import numpy as np
    import soundfile as sf
    import torch

    call_started = time.time()
    cold = _SUB_FIRST_CALL
    boot_seconds = round(call_started - _SUB_CONTAINER_START, 2) if cold else 0.0
    _SUB_FIRST_CALL = False

    wanted = [item.strip() for item in paths.split(",") if item.strip()]
    if not wanted or any(item not in SUB_PATHS for item in wanted):
        raise ValueError(f"paths 'stem' ve/veya 'mix' olmali: {paths!r}")
    overlap = int(overlap)
    if overlap < 1:
        raise ValueError("overlap >= 1 olmali")

    volume.reload()
    status = json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8"))
    vocal_path = _song_dir(song_id) / "master" / "vocals.flac"
    if not vocal_path.is_file():
        raise FileNotFoundError(f"master/vocals.flac yok: {song_id}")
    data, vocal_rate = sf.read(str(vocal_path), dtype="float32", always_2d=True)
    if int(vocal_rate) != 44100:
        raise ValueError(f"SW vokal 44100 Hz bekleniyordu: {vocal_rate}")
    vocal = np.ascontiguousarray(data.T)
    duration = vocal.shape[1] / 44100.0

    model, config, vocal_index, load_seconds = _sub_load_karaoke()
    torch.cuda.reset_peak_memory_stats()

    out = {}
    for path_name in wanted:
        if path_name == "stem":
            model_input = vocal
        else:
            model_input = _decode_pcm(_find_input(song_id), 44100, 2)
            if model_input.shape[1] != vocal.shape[1]:
                # SW çıkışı karışımla aynı uzunlukta olmalı; farklıysa en kısaya kırp.
                limit = min(model_input.shape[1], vocal.shape[1])
                print(f"[sub] uyari: karisim {model_input.shape[1]} != vokal {vocal.shape[1]}, "
                      f"{limit} orneğe kirpiliyor")
                model_input = model_input[:, :limit]
        infer_started = time.time()
        estimated = _hifi_demix(model, model_input, config, overlap=overlap)
        infer_seconds = round(time.time() - infer_started, 2)
        lead = estimated[vocal_index].astype(np.float32)
        length = min(lead.shape[1], vocal.shape[1])
        lead = np.ascontiguousarray(lead[:, :length])
        reference = vocal[:, :length]
        backing = (reference - lead).astype(np.float32)

        metrics = _sub_metrics(reference, lead, backing, 44100)
        metrics["infer_s"] = infer_seconds
        metrics["realtime_x"] = round(duration / infer_seconds, 2) if infer_seconds else 0.0
        out[path_name] = metrics
        if production:
            metrics["production"] = _sub_produce(
                song_id, status, reference, lead, backing, metrics,
                {"model_load": load_seconds, "infer": infer_seconds})
        print(f"[sub] {path_name}: {infer_seconds} sn (gercek zamanin {metrics['realtime_x']}x), "
              f"ana {metrics['lead_rel_db']} dB, arka {metrics['backing_rel_db']} dB, "
              f"toplam hata {metrics['sum_err_db']} dB")

        if experiment:
            target = _sub_exp_dir(song_id) / path_name
            target.mkdir(parents=True, exist_ok=True)
            sf.write(str(target / "lead.wav"), lead.T, 44100, subtype="FLOAT", format="WAV")
            sf.write(str(target / "backing.wav"), backing.T, 44100, subtype="FLOAT", format="WAV")
        del estimated, lead, backing
        torch.cuda.empty_cache()

    if experiment:
        volume.commit()
    wall = round(time.time() - call_started, 2)
    billed = round(wall + boot_seconds, 2)
    return _assert_plain({
        "song_id": song_id,
        "title": str(status.get("title") or song_id[:12]),
        "duration": round(duration, 2),
        "overlap": overlap,
        "cold_start": bool(cold),
        "boot_s": boot_seconds,
        "model_load_s": load_seconds,
        "wall_s": wall,
        "billed_estimate_s": billed,
        "cost_usd_estimate": round(billed * SUB_USD_PER_SECOND, 4),
        "peak_vram_mb": round(float(torch.cuda.max_memory_allocated()) / 1024 ** 2, 1),
        "torch": str(torch.__version__).split("+")[0],
        "paths": out,
    })


# --------------------------------------------------------------------------
# Davul alt ayrımı (Aşama 10, oturum 4): SW davul stem'i -> kick, snare, toms,
# hihat, cymbals (ride + crash); artık toms'a eklenir (5 kanal).
# --------------------------------------------------------------------------


@app.function(
    image=light_image,
    volumes={DATA_DIR: volume},
    timeout=3600,
)
def fetch_drum_weights() -> dict:
    """DrumSep MDX23C ağırlığını Volume'a indirir ve sha256 doğrular.

        modal run backend/app.py::drum_fetch

    Geçici adla iner, doğrulanınca yerine konur; 438 MB parça parça yazılır.
    """
    import urllib.request

    volume.reload()
    target_dir = _sub_weights_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    report = {}
    for name, url, sha, size in (
        (SUB_DRUM_CKPT, SUB_DRUM_CKPT_URL, SUB_DRUM_CKPT_SHA256, SUB_DRUM_CKPT_BYTES),
        (SUB_DRUM_YAML, SUB_DRUM_YAML_URL, SUB_DRUM_YAML_SHA256, SUB_DRUM_YAML_BYTES),
    ):
        target = target_dir / name
        if target.exists():
            try:
                _verify_sha256(target, sha, size)
                print(f"[atla] {name} zaten var ve dogrulandi")
                report[name] = {"downloaded": False, "sha256": sha}
                continue
            except ValueError:
                print(f"[yeniden] {name} dogrulanamadi, tekrar iniyor")
        partial = target_dir / (name + ".part")
        print(f"[indir] {name} <- {url}")
        started = time.time()
        with urllib.request.urlopen(url, timeout=600) as response, \
                partial.open("wb") as handle:
            while True:
                block = response.read(8 * 1024 * 1024)
                if not block:
                    break
                handle.write(block)
        try:
            _verify_sha256(partial, sha, size)
        except ValueError:
            partial.unlink(missing_ok=True)
            raise
        partial.replace(target)
        print(f"[dogrulandi] {name} {round(time.time() - started, 1)} sn, sha256={sha}")
        report[name] = {"downloaded": True, "bytes": int(target.stat().st_size)}
    volume.commit()
    return _assert_plain(report)


@app.local_entrypoint()
def drum_fetch():
    print(json.dumps(fetch_drum_weights.remote(), ensure_ascii=False, indent=2))


def _sub_load_drumsep():
    """DrumSep MDX23C'yi yükler (cuda). Dönen: (model, config sözlüğü, çıkış adları, sn).

    Config dönüşümü: MDX23C `config.audio.n_fft` gibi ÖZNİTELİK erişimi istiyor
    (MSST ml_collections.ConfigDict veriyor); yükleyici dict döndürüyor, o yüzden
    `ConfigDict`'e sarılıyor. `!!python/tuple` _load_hifi_config'te güvenli çözülüyor.
    Yükleme STRICT: eksik/fazla anahtar hata verir.
    """
    import sys

    import torch

    weights = _sub_weights_dir()
    ckpt = weights / SUB_DRUM_CKPT
    config_path = weights / SUB_DRUM_YAML
    if not ckpt.is_file() or not config_path.is_file():
        raise FileNotFoundError(
            f"DrumSep agirliklari yok: {ckpt}. "
            f"'modal run backend/app.py::drum_fetch' calistirilmali."
        )
    started = time.time()
    _verify_sha256(ckpt, SUB_DRUM_CKPT_SHA256, SUB_DRUM_CKPT_BYTES)
    _verify_sha256(config_path, SUB_DRUM_YAML_SHA256, SUB_DRUM_YAML_BYTES)
    config = _load_hifi_config(config_path)
    if int(config["audio"]["sample_rate"]) != 44100:
        raise ValueError(f"beklenmeyen ornekleme hizi: {config['audio']['sample_rate']}")
    outputs = [str(item).lower() for item in config["training"]["instruments"]]
    if tuple(outputs) != SUB_DRUM_MODEL_OUTPUTS:
        raise ValueError(f"DrumSep cikislari beklenenden farkli: {outputs}")

    if MSST_DIR not in sys.path:
        sys.path.insert(0, MSST_DIR)
    from ml_collections import ConfigDict
    from models.mdx23c_tfc_tdf_v3 import TFC_TDF_net

    model = TFC_TDF_net(ConfigDict(config))
    state = torch.load(str(ckpt), map_location="cpu", weights_only=False)
    if isinstance(state, dict):
        for key in ("state_dict", "model", "model_state_dict"):
            if key in state and isinstance(state[key], dict):
                state = state[key]
                break
    if any(name.startswith("module.") for name in state):
        state = {name.removeprefix("module."): value for name, value in state.items()}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:
        raise ValueError(f"DrumSep ckpt uyusmuyor: eksik={len(missing)} fazla={len(unexpected)} "
                         f"(ilk eksikler: {missing[:3]})")
    model.to("cuda")
    model.eval()
    seconds = round(time.time() - started, 2)
    print(f"[sub] DrumSep modeli {seconds} sn'de hazir; ciktilar={outputs}")
    return model, config, outputs, seconds


def _sub_harmonic_shares(signals: dict, samplerate: int) -> dict:
    """Her sinyalin HARMONİK (tonal) enerji payı (HPSS), 0-1.

    Sızıntı göstergesi: davul stem'ine sızan piyano/müzik tonal olduğu için
    harmonik payı yüksek. Hangi parçanın (kick/snare/toms/...) tonal
    içerik taşıdığı buradan okunuyor. Aynı 8 parça (8 sn, eşit aralıklı) tüm
    sinyallerde kullanılır; bir sinyalin enerjisi ihmal edilebilirse None.
    """
    import librosa
    import numpy as np

    length = min(array.shape[1] for array in signals.values())
    segment = int(8 * samplerate)
    count = 8
    if length <= segment * 2:
        starts = [0]
        segment = length
    else:
        starts = [int(i * (length - segment) / (count - 1)) for i in range(count)]
    out = {}
    for name, array in signals.items():
        mono = array.mean(axis=0)
        harmonic = percussive = 0.0
        for begin in starts:
            piece = mono[begin:begin + segment].astype(np.float32)
            magnitude = np.abs(librosa.stft(piece, n_fft=2048, hop_length=512))
            h, p = librosa.decompose.hpss(magnitude, kernel_size=31, margin=1.0)
            harmonic += float(np.sum(h.astype(np.float64) ** 2))
            percussive += float(np.sum(p.astype(np.float64) ** 2))
        total = harmonic + percussive
        out[name] = round(harmonic / total, 4) if total > 1e-9 else None
    return out


def _sub_drum_metrics(drums, parts: dict, other, samplerate: int) -> dict:
    """Parçaların davula göre seviyeleri, toplam hatası, tonal pay.

    `parts`: 5 NİHAİ parça (toms artığı İÇERİYOR, toplamları davula eşit).
    `other`: toms'a eklenen model artığı; yalnız raporlama için (`merged_other_power_share`).
    """
    import numpy as np

    drums_rms = _sub_rms(drums)
    drums_power = drums_rms ** 2
    levels = {}
    for name, array in parts.items():
        rms = _sub_rms(array)
        levels[name] = {
            "rel_db": _sub_db(rms, drums_rms),
            "power_share": round(float(rms ** 2 / drums_power), 4) if drums_power > 0 else 0.0,
            "peak": round(float(abs(array).max()), 4),
        }
    total = sum(parts.values())
    err = total.astype(np.float64) - drums.astype(np.float64)
    peak = max(float(abs(drums).max()), *(float(abs(a).max()) for a in parts.values()))
    scale = 1.0 / max(1.0, 1.01 * peak)

    def quantize(x):
        return np.round(x.astype(np.float64) * scale * 8388607.0) / 8388607.0

    err_q = sum(quantize(a) for a in parts.values()) - quantize(drums)
    assigned = sum(v["power_share"] for v in levels.values())
    other_rms = _sub_rms(other)
    signals = {"drums": drums, **parts}
    return {
        "drums_rms_db": _sub_db(drums_rms, 1.0),
        "levels": levels,
        "assigned_power_share": round(assigned, 4),
        "merged_other_power_share": round(float(other_rms ** 2 / drums_power), 4)
        if drums_power > 0 else 0.0,
        "sum_err_db": _sub_db(_sub_rms(err), drums_rms),
        "sum_err_flac24_db": _sub_db(_sub_rms(err_q), drums_rms),
        "harmonic_share": _sub_harmonic_shares(signals, samplerate),
        "peak": round(peak, 4),
    }


def _sub_drum_gate(metrics: dict) -> str:
    """Davul YUMUŞAK uyarısı: 'warn' | 'ok'. SERT KAPI YOK (dosyalar hep yazılır).

    toms güç payı >= %8 ve toms tonal payı >= 0.9 -> tom kanalına başka enstrüman
    (piyano/bas) sızmış olabilir. Ölçüm: BTS (%9.4 / 0.96) ve NEM-slowed (%14 / 0.98)
    uyarı alır; Usseewa, Zeus, Ado, HAZBIN almaz. Kulakla doğrulanacak.
    """
    toms_power = (metrics.get("levels", {}).get("toms") or {}).get("power_share", 0.0)
    toms_tonal = (metrics.get("harmonic_share") or {}).get("toms")
    if toms_tonal is not None and toms_power >= SUB_DRUM_WARN_TOMS_POWER \
            and toms_tonal >= SUB_DRUM_WARN_TOMS_TONAL:
        return "warn"
    return "ok"


def _sub_produce_drums(song_id: str, status: dict, drums, parts: dict, other, metrics: dict,
                       seconds: dict) -> dict:
    """Davul parçalarını yazar (yalnız davul dosyaları ve `status.sub_drums`)."""
    import numpy as np
    import soundfile as sf

    gate = _sub_drum_gate(metrics)
    base = {
        "merged_other_power_share": metrics["merged_other_power_share"],
        "toms_tonal_share": (metrics.get("harmonic_share") or {}).get("toms"),
        "sum_err_db": metrics["sum_err_db"],
        "sum_err_flac24_db": metrics["sum_err_flac24_db"],
        "levels": {k: v["rel_db"] for k, v in metrics["levels"].items()},
        "parent_stems_version": status.get("stems_version"),
        "parent_pipeline": status.get("pipeline"),
        "model": {"name": "aufr33-jarredou DrumSep MDX23C", "ckpt_sha256": SUB_DRUM_CKPT_SHA256,
                  "input": "stem", "overlap": SUB_DRUM_OVERLAP, "cymbals": "ride+crash",
                  "residue": "toms"},
        "seconds": seconds,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    song_dir = _song_dir(song_id)
    _sub_remove_part_files(song_id, SUB_DRUM_PARTS)       # yalnız davul dosyaları
    everything = dict(parts)
    peak = max(float(abs(a).max()) for a in everything.values())
    scale = 1.0 if peak <= 1.0 else 1.0 / (1.01 * peak)
    master_dir = song_dir / "master" / "sub"
    stems_dir = song_dir / "stems" / "sub"
    master_dir.mkdir(parents=True, exist_ok=True)
    stems_dir.mkdir(parents=True, exist_ok=True)
    for name in SUB_DRUM_PARTS:
        flac_path = master_dir / f"{name}.flac"
        sf.write(str(flac_path), (everything[name] * np.float32(scale)).T, 44100,
                 subtype=FLAC_SUBTYPE, format="FLAC")
        _encode_stem_m4a(flac_path, stems_dir / f"{name}.m4a", 2)
    sub = {**base, "state": "done", "reliability": gate, "version": int(time.time()),
           "clip_scale": round(scale, 6), "parts": {"drums": list(SUB_DRUM_PARTS)}}
    _write_status(song_id, sub_drums=sub)
    print(f"[sub] davul yazildi ({gate}): toms payi "
          f"{metrics['levels']['toms']['power_share']}, surum {sub['version']}")
    return sub


def _separate_sub_drums_impl(song_id: str, overlap: int, production: bool) -> dict:
    """SW davul stem'ini alt parçalara böler. production=False: yalnız ölçüm,
    HİÇBİR ŞEY yazılmaz."""
    global _SUB_FIRST_CALL

    import numpy as np
    import soundfile as sf
    import torch

    call_started = time.time()
    cold = _SUB_FIRST_CALL
    boot_seconds = round(call_started - _SUB_CONTAINER_START, 2) if cold else 0.0
    _SUB_FIRST_CALL = False
    overlap = int(overlap)
    if overlap < 1:
        raise ValueError("overlap >= 1 olmali")

    volume.reload()
    status = json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8"))
    drums_path = _song_dir(song_id) / "master" / "drums.flac"
    if not drums_path.is_file():
        raise FileNotFoundError(f"master/drums.flac yok: {song_id}")
    data, rate = sf.read(str(drums_path), dtype="float32", always_2d=True)
    if int(rate) != 44100:
        raise ValueError(f"SW davul 44100 Hz bekleniyordu: {rate}")
    drums = np.ascontiguousarray(data.T)
    duration = drums.shape[1] / 44100.0

    model, config, outputs, load_seconds = _sub_load_drumsep()
    torch.cuda.reset_peak_memory_stats()
    infer_started = time.time()
    estimated = _hifi_demix(model, drums, config, overlap=overlap)
    infer_seconds = round(time.time() - infer_started, 2)
    del model
    torch.cuda.empty_cache()

    by_output = {name: estimated[index].astype(np.float32) for index, name in enumerate(outputs)}
    length = min(drums.shape[1], *(a.shape[1] for a in by_output.values()))
    drums = drums[:, :length]
    parts = {
        "kick": by_output["kick"][:, :length],
        "snare": by_output["snare"][:, :length],
        "toms": by_output["toms"][:, :length],
        "hihat": by_output["hh"][:, :length],
        # ride + crash SUNUCUDA tek kanal
        "cymbals": (by_output["ride"][:, :length] + by_output["crash"][:, :length]),
    }
    other = (drums - sum(parts.values())).astype(np.float32)
    # Artık (güç payı < %1) AYRI kanal değil: toms'a eklenir, toplam davula TAM eşit.
    parts["toms"] = (parts["toms"] + other).astype(np.float32)
    del estimated, by_output

    metrics = _sub_drum_metrics(drums, parts, other, 44100)
    metrics["infer_s"] = infer_seconds
    metrics["realtime_x"] = round(duration / infer_seconds, 2) if infer_seconds else 0.0
    print(f"[sub] davul: {infer_seconds} sn (gercek zamanin {metrics['realtime_x']}x), "
          f"toms'a eklenen artik payi {metrics['merged_other_power_share']}, "
          f"toplam hata {metrics['sum_err_db']} dB")
    if production:
        metrics["production"] = _sub_produce_drums(
            song_id, status, drums, parts, other, metrics,
            {"model_load": load_seconds, "infer": infer_seconds})

    wall = round(time.time() - call_started, 2)
    billed = round(wall + boot_seconds, 2)
    return _assert_plain({
        "song_id": song_id,
        "title": str(status.get("title") or song_id[:12]),
        "group": "drums",
        "duration": round(duration, 2),
        "overlap": overlap,
        "cold_start": bool(cold),
        "boot_s": boot_seconds,
        "model_load_s": load_seconds,
        "wall_s": wall,
        "billed_estimate_s": billed,
        "cost_usd_estimate": round(billed * SUB_USD_PER_SECOND, 4),
        "peak_vram_mb": round(float(torch.cuda.max_memory_allocated()) / 1024 ** 2, 1),
        "torch": str(torch.__version__).split("+")[0],
        "metrics": metrics,
    })


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=120)
def sub_find(needles: list) -> dict:
    """Başlığında iğne geçen KAYNAK şarkılar: {iğne: [kimlik, başlık]}."""
    volume.reload()
    found = {}
    for needle in needles:
        try:
            song_id, title = _pick_source_song(needle)
        except FileNotFoundError:
            continue
        found[needle] = [song_id, title]
    return _assert_plain(found)


def _sub_read_wav(path: pathlib.Path):
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    if int(rate) != 44100:
        raise ValueError(f"{path.name}: 44100 Hz bekleniyordu ({rate})")
    return np.ascontiguousarray(data.T)


def _sub_segment_means(levels, count: int) -> list:
    """Art arda `count` pencerenin ortalaması (liste uzunluğu len-count+1)."""
    return [sum(levels[i:i + count]) / count for i in range(len(levels) - count + 1)]


def _sub_clock(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds // 60}:{seconds % 60:02d}"


@app.function(image=sub_cpu_image, volumes={DATA_DIR: volume}, timeout=1800, memory=16384)
def sub_excerpt_song(song_id: str, letters: dict) -> dict:
    """Kör dinleme kesitleri: her yol bir kütüphane şarkısı (`<id>-sb<harf>s`).

    letters: {"stem": "a", "mix": "b"} (kimin hangi harf olduğu yalnız
    çağıranın anahtar dosyasında). Her kesit 10 sn + 1 sn sessizlik + 10 sn:
      1. bölüm: iki yolun ARKA vokalinin ortalama olarak en güçlü olduğu yer
                (arka vokal belirgin mi, doğru mu?)
      2. bölüm: iki yolun ANA vokalinin en çok ayrıştığı yer (zor vaka)
    Seçim iki yolun ortalamasından yapılıyor: bir yola kayırma yok.
    Kanallar: lead (ana), backing (arka), other (müzik = karışım - SW vokal).
    Üçü de ORTAK ölçekle (iki harf arasında seviye farkı "daha iyi" yanılgısı
    yaratmasın) yazılır.
    """
    import numpy as np
    import soundfile as sf

    volume.reload()
    status = json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8"))
    title = str(status.get("title") or song_id[:12])
    vocal_data, rate = sf.read(str(_song_dir(song_id) / "master" / "vocals.flac"),
                               dtype="float32", always_2d=True)
    vocal = np.ascontiguousarray(vocal_data.T)
    mix = _decode_pcm(_find_input(song_id), 44100, 2)
    length = min(vocal.shape[1], mix.shape[1])
    vocal, mix = vocal[:, :length], mix[:, :length]
    instrumental = (mix - vocal).astype(np.float32)

    base = _sub_exp_dir(song_id)
    stems = {}
    for path_name in SUB_PATHS:
        lead = _sub_read_wav(base / path_name / "lead.wav")[:, :length]
        backing = _sub_read_wav(base / path_name / "backing.wav")[:, :length]
        stems[path_name] = {"lead": lead, "backing": backing}

    vocal_rms = _sub_rms(vocal)
    window = int(SUB_WINDOW_SEC * 44100)
    windows = length // window
    count = int(round(SUB_EXCERPT_SECONDS / SUB_WINDOW_SEC))
    if windows < 2 * count + 1:
        raise ValueError("sarki iki kesit icin cok kisa")

    back_stem = _sub_window_levels(stems["stem"]["backing"], vocal_rms, 44100)
    back_mix = _sub_window_levels(stems["mix"]["backing"], vocal_rms, 44100)
    back_level = [(a + b) / 2.0 for a, b in zip(back_stem, back_mix)]
    diff = stems["stem"]["lead"] - stems["mix"]["lead"]
    diff_level = _sub_window_levels(diff, vocal_rms, 44100)

    # Vokalin olmadığı pencereler (SW vokal çok sessiz) seçilmesin.
    vocal_level = _sub_window_levels(vocal, vocal_rms, 44100)
    active = [level > -30.0 for level in vocal_level]

    def best(levels, forbidden=None):
        means = _sub_segment_means(levels, count)
        best_index, best_value = None, None
        for index, value in enumerate(means):
            if not all(active[index:index + count]):
                continue
            if forbidden is not None and not (
                    index + count < forbidden[0] or index > forbidden[1]):
                continue
            if best_value is None or value > best_value:
                best_index, best_value = index, value
        if best_index is None:      # tamamen etkin pencere yoksa etkinlik şartını gevşet
            for index, value in enumerate(means):
                if forbidden is not None and not (
                        index + count < forbidden[0] or index > forbidden[1]):
                    continue
                if best_value is None or value > best_value:
                    best_index, best_value = index, value
        return best_index, best_value

    first, first_value = best(back_level)
    if first is None:
        raise ValueError("1. kesit bolumu secilemedi")
    second, second_value = best(diff_level, forbidden=(first - 1, first + count))
    if second is None:
        raise ValueError("2. kesit bolumu secilemedi")

    starts = {"backing": first * SUB_WINDOW_SEC, "disagree": second * SUB_WINDOW_SEC}
    seg = int(SUB_EXCERPT_SECONDS * 44100)
    gap = np.zeros((2, int(SUB_EXCERPT_GAP * 44100)), dtype=np.float32)
    fade = int(SUB_EXCERPT_FADE * 44100)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)

    def cut(array):
        pieces = []
        for kind in ("backing", "disagree"):
            begin = int(starts[kind] * 44100)
            piece = array[:, begin:begin + seg].copy()
            piece[:, :fade] *= ramp
            piece[:, -fade:] *= ramp[::-1]
            pieces.append(piece)
            if kind == "backing":
                pieces.append(gap)
        return np.concatenate(pieces, axis=1)

    short_other = cut(instrumental)
    cuts = {name: {"lead": cut(s["lead"]), "backing": cut(s["backing"])}
            for name, s in stems.items()}
    peak = max(float(abs(short_other).max()),
               *(float(abs(v).max()) for s in cuts.values() for v in s.values()))
    scale = max(1.01 * peak, 1.0)
    excerpt_seconds = short_other.shape[1] / 44100.0

    ids = {}
    for path_name, letter in letters.items():
        excerpt_id = f"{song_id}-sb{letter.lower()}s"
        song_dir = _song_dir(excerpt_id)
        master_dir, stems_dir = song_dir / "master", song_dir / "stems"
        master_dir.mkdir(parents=True, exist_ok=True)
        stems_dir.mkdir(parents=True, exist_ok=True)
        parts = {"lead": cuts[path_name]["lead"], "backing": cuts[path_name]["backing"],
                 "other": short_other}
        for name, array in parts.items():
            flac_path = master_dir / f"{name}.flac"
            sf.write(str(flac_path), (array / scale).T, 44100, subtype=FLAC_SUBTYPE,
                     format="FLAC")
            _encode_stem_m4a(flac_path, stems_dir / f"{name}.m4a", 2)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        (song_dir / "status.json").write_text(json.dumps({
            "id": excerpt_id,
            "title": f"[{letter.upper()} kisa] {title}",
            "state": "done", "progress": 100,
            "duration": round(excerpt_seconds, 3),
            "stems": list(parts),
            "created_at": now, "updated_at": now,
            "source_song": song_id,
            "experiment": {"sub": "excerpt", "clip_scale": round(scale, 4)},
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        ids[letter] = excerpt_id
        print(f"[kesit] [{letter}] -> {excerpt_id} ({excerpt_seconds:.1f} sn)")

    volume.commit()
    return _assert_plain({
        "title": title,
        "duration": round(length / 44100.0, 1),
        "excerpt_seconds": round(excerpt_seconds, 1),
        "clip_scale": round(scale, 4),
        "segments": {
            "backing": {"full_start": _sub_clock(starts["backing"]),
                        "full_end": _sub_clock(starts["backing"] + SUB_EXCERPT_SECONDS),
                        "mean_backing_db": round(first_value, 1)},
            "disagree": {"full_start": _sub_clock(starts["disagree"]),
                         "full_end": _sub_clock(starts["disagree"] + SUB_EXCERPT_SECONDS),
                         "mean_lead_diff_db": round(second_value, 1)},
        },
        "excerpt_ids": ids,
    })


SUB_SHEET_CHECKS = (
    ("hepsi acik", "Ana + arka + muzik hepsi acik. Cizirti, faz bozulmasi, "
                   "kayip/eksik ses, vokalde ince/bos duyulma?"),
    ("ana solo", "Yalniz ana. Arka vokal/koro hala duyuluyor mu? Ana vokalin bir kismi "
                 "eksik mi (kesik, boguk)?"),
    ("arka solo", "Yalniz arka. Gercekten arka vokal mi? Ana vokal sizdiriyor mu? "
                  "Yalniz yanki/artefakt mi duyuluyor?"),
    ("ana kapali", "Ana MUTE, arka + muzik acik (karaoke). Ana vokal izi (hayalet) "
                   "kaliyor mu? Arka vokal duyuluyor mu?"),
)


def _sub_sheet(title: str, result: dict) -> str:
    seg = result["segments"]
    letters = sorted(result["excerpt_ids"])
    length = SUB_EXCERPT_SECONDS
    lines = [
        f"# Dinleme kagidi (alt parca, vokal): {title}",
        "",
        f"Kitapliktaki `[X kisa]` sarkilari ({len(letters)} harf: {', '.join(letters)}) "
        f"her biri {result['excerpt_seconds']:.0f} sn. Kanallar: lead (ana), backing "
        f"(arka), other (muzik).",
        "",
        "| kesit ici | bolum | tam surumde |",
        "|---|---|---|",
        f"| 0:00 - 0:{length:04.1f} | 1. bolum (arka vokalin en guclu oldugu yer) | "
        f"{seg['backing']['full_start']} - {seg['backing']['full_end']} |",
        f"| 0:{length:04.1f} - 0:{length + SUB_EXCERPT_GAP:04.1f} | sessizlik | |",
        f"| 0:{length + SUB_EXCERPT_GAP:04.1f} - 0:{result['excerpt_seconds']:04.1f} | "
        f"2. bolum (iki harfin ana vokalinin en cok ayristigi yer) | "
        f"{seg['disagree']['full_start']} - {seg['disagree']['full_end']} |",
        "",
        "Her kontrolde ayni sirayla butun harfleri dinle (ayni kanal ayarlari, ayni ses "
        "seviyesi).",
        "",
        "| # | kontrol | ne dinlenir | EN IYI harf | BELIRGIN KUSURLU harfler | kusur hangi bolumde (1/2) |",
        "|---|---|---|---|---|---|",
    ]
    for number, (check, hint) in enumerate(SUB_SHEET_CHECKS, start=1):
        lines.append(f"| {number} | {check} | {hint} | | | |")
    lines += ["", "Not (serbest): hangi harf 'gercek arka vokal'a daha yakin?", "", ""]
    return "\n".join(lines)


@app.local_entrypoint()
def sub_experiment(songs: str = "Final Duet,HAZBIN,Below The Surface",
                   overlap: int = SUB_OVERLAP, dry: bool = False):
    """Vokal alt ayrımı deneyi: iki girdi yolu (SW stem / tam karışım).

        modal run backend/app.py::sub_fetch                 # bir kez
        modal run backend/app.py::sub_experiment

    Çıktılar backend/sub_out/ altında: report.json (ölçümler), key.json (harf
    anahtarı: dinlemeden ÖNCE açma), sheets/*.md (dinleme kağıtları, harfin ne
    olduğunu içermez). Kesitler kitaplıkta `[X kisa]` şarkıları olarak görünür.
    """
    import random

    out_dir = pathlib.Path(__file__).resolve().parent / "sub_out"
    sheets = out_dir / "sheets"
    sheets.mkdir(parents=True, exist_ok=True)
    needles = [item.strip() for item in songs.split(",") if item.strip()]
    found = sub_find.remote(needles)
    for needle in needles:
        if needle not in found:
            print(f"[uyari] '{needle}' iceren kaynak sarki bulunamadi")
    if dry:
        print(json.dumps(found, ensure_ascii=False, indent=2))
        return

    key_path, report_path = out_dir / "key.json", out_dir / "report.json"
    keys = json.loads(key_path.read_text("utf-8")) if key_path.is_file() else {}
    reports = json.loads(report_path.read_text("utf-8")) if report_path.is_file() else {}
    pool = list("abcdefghjkmnpqrstuvwxyz")
    total_cost = 0.0

    for needle in needles:
        if needle not in found:
            continue
        song_id, title = found[needle]
        print(f"\n--- {title} ---")
        result = separate_sub.remote(song_id, ",".join(SUB_PATHS), overlap, True)
        reports[song_id] = result
        total_cost += result["cost_usd_estimate"]
        _print_sub_result(result)

        # Harfler her şarkıda rastgele; yol -> harf eşlemesi YALNIZ key.json'da.
        letters = random.sample(pool, len(SUB_PATHS))
        mapping = dict(zip(SUB_PATHS, letters))
        excerpt = sub_excerpt_song.remote(song_id, mapping)
        keys[song_id] = {"title": title,
                         "key": {letter: path for path, letter in mapping.items()},
                         "ids": excerpt["excerpt_ids"]}
        slug = "".join(ch if ch.isalnum() else "_" for ch in title)[:40]
        (sheets / f"{slug}.md").write_text(_sub_sheet(title, excerpt), encoding="utf-8")
        seg = excerpt["segments"]
        print(f"  1. bolum {seg['backing']['full_start']}-{seg['backing']['full_end']} "
              f"(arka ort. {seg['backing']['mean_backing_db']} dB), "
              f"2. bolum {seg['disagree']['full_start']}-{seg['disagree']['full_end']}, "
              f"kesit {excerpt['excerpt_seconds']} sn, ortak olcek {excerpt['clip_scale']}")
        key_path.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
        report_path.write_text(json.dumps(reports, ensure_ascii=False, indent=2),
                               encoding="utf-8")

    print(f"\nToplam maliyet tahmini: ${total_cost:.3f}")
    print(f"Kagitlar: {sheets}  |  ANAHTAR (dinleme bitmeden acma): {key_path}")


def _print_sub_result(result: dict):
    print(f"  {result['duration']} sn, overlap {result['overlap']}, "
          f"{'SOGUK' if result['cold_start'] else 'sicak'} baslangic "
          f"(boot {result['boot_s']} sn), model {result['model_load_s']} sn, "
          f"toplam {result['wall_s']} sn, VRAM {result['peak_vram_mb']} MB, "
          f"~${result['cost_usd_estimate']}")
    for path_name, m in result["paths"].items():
        print(f"  [{path_name:4}] cikarim {m['infer_s']} sn ({m['realtime_x']}x) | "
              f"ana {m['lead_rel_db']} dB, arka {m['backing_rel_db']} dB (vokale gore) | "
              f"toplam hata {m['sum_err_db']} dB (FLAC24 {m['sum_err_flac24_db']} dB) | "
              f"ana-arka korelasyon {m['lead_backing_corr']} | "
              f"arka >-20 dB pencere {m['backing_windows_over_m20db']}/{m['windows']}")


@app.function(image=sub_cpu_image, volumes={DATA_DIR: volume}, timeout=900, memory=8192)
def sub_levels(stem: str = "vocals") -> list:
    """Her KAYNAK şarkının SW `stem` ("vocals" | "drums") seviyesi (GPU yok, model yok).

    `vokal yok` kapısının eşiğini canlı kitaplıktan türetmek için. Dönen her
    kayıt: kimlik, başlık, süre, RMS ve tepe (dBFS), 2 sn pencerelerin %95'lik
    dilimi ve -50 dBFS üstü pencere oranı.
    """
    import numpy as np
    import soundfile as sf

    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    found = []
    for entry in sorted(root.iterdir()) if root.is_dir() else []:
        status_path = entry / "status.json"
        vocal_path = entry / "master" / f"{stem}.flac"
        if not status_path.is_file() or not vocal_path.is_file():
            continue
        try:
            data = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("state") != "done" or data.get("source_song"):
            continue
        audio, rate = sf.read(str(vocal_path), dtype="float32", always_2d=True)
        audio = audio.T
        rms = _sub_rms(audio)
        size = int(SUB_WINDOW_SEC * rate)
        count = audio.shape[1] // size
        windows = sorted(_sub_db(float(np.sqrt(np.mean(
            audio[:, i * size:(i + 1) * size].astype(np.float64) ** 2))), 1.0)
            for i in range(count))
        found.append({
            "id": str(data.get("id", entry.name)),
            "title": str(data.get("title") or entry.name[:12]),
            "pipeline": str(data.get("pipeline") or "hifi_v1"),
            "duration": round(audio.shape[1] / float(rate), 1),
            "rms_dbfs": _sub_db(rms, 1.0),
            "peak_dbfs": _sub_db(float(abs(audio).max()), 1.0),
            "p95_window_dbfs": windows[int(0.95 * (len(windows) - 1))] if windows else -200.0,
            "windows_over_m50": int(sum(1 for v in windows if v > -50.0)),
            "windows": len(windows),
        })
    return _assert_plain(found)


@app.local_entrypoint()
def sub_validate(silent_below: float = -70.0, min_seconds: float = 10.0,
                 skip: str = "", dry: bool = False):
    """Eşik doğrulaması: kesitsiz, yalnız stem yolu, yalnız metrik.

        modal run backend/app.py::sub_validate --dry      # yalnız seviyeler (CPU)
        modal run backend/app.py::sub_validate

    Vokal RMS'i `silent_below` dBFS altındaysa (ya da şarkı `min_seconds`'tan
    kısaysa) model ÇALIŞTIRILMAZ, GPU harcanmaz. `skip`: virgüllü başlık
    iğneleri (zaten ölçülmüş şarkılar). Sonuç: backend/sub_out/validate.json.
    """
    import math

    levels = sub_levels.remote()
    skips = [item.strip().lower() for item in skip.split(",") if item.strip()]
    print(f"{'baslik':44} {'sure':>6} {'RMS':>8} {'tepe':>7} {'p95':>7} {'>-50':>9}")
    for item in levels:
        print(f"{item['title'][:44]:44} {item['duration']:6.1f} {item['rms_dbfs']:8.1f} "
              f"{item['peak_dbfs']:7.1f} {item['p95_window_dbfs']:7.1f} "
              f"{item['windows_over_m50']:4}/{item['windows']:<4}")
    out_dir = pathlib.Path(__file__).resolve().parent / "sub_out"
    out_dir.mkdir(parents=True, exist_ok=True)
    results = {"levels": levels, "runs": {}, "skipped_silent": [], "skipped_other": []}
    if dry:
        (out_dir / "validate.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        return

    total_cost = 0.0
    for item in levels:
        title = item["title"]
        if any(needle in title.lower() for needle in skips):
            results["skipped_other"].append(title)
            continue
        if item["rms_dbfs"] < silent_below or item["duration"] < min_seconds:
            print(f"[atla] {title[:40]}: vokal RMS {item['rms_dbfs']} dBFS / "
                  f"{item['duration']} sn -> model calistirilmadi")
            results["skipped_silent"].append(title)
            continue
        print(f"\n--- {title} ---")
        run = separate_sub.remote(item["id"], "stem", SUB_OVERLAP, False)
        metrics = run["paths"]["stem"]
        lead_power = 10.0 ** (metrics["lead_rel_db"] / 10.0)
        back_power = 10.0 ** (metrics["backing_rel_db"] / 10.0)
        share = lead_power / (lead_power + back_power)
        results["runs"][item["id"]] = {
            "title": title, "lead_rel_db": metrics["lead_rel_db"],
            "backing_rel_db": metrics["backing_rel_db"], "lead_share": round(share, 4),
            "backing_windows_over_m20db": metrics["backing_windows_over_m20db"],
            "windows": metrics["windows"], "infer_s": metrics["infer_s"],
            "cost_usd_estimate": run["cost_usd_estimate"],
            "cold_start": run["cold_start"],
        }
        total_cost += run["cost_usd_estimate"]
        print(f"  ana {metrics['lead_rel_db']} dB, arka {metrics['backing_rel_db']} dB, "
              f"LEAD PAYI {share:.3f}, arka >-20 dB pencere "
              f"{metrics['backing_windows_over_m20db']}/{metrics['windows']}, "
              f"~${run['cost_usd_estimate']}")
        (out_dir / "validate.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nToplam maliyet tahmini: ${total_cost:.3f}")
    (out_dir / "validate.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=300)
def sub_gate_check(song_id: str) -> dict:
    """API'nin "vokal yok" kapısının AYNISI (ffmpeg astats, CPU, GPU açılmaz).

    Canlı doğrulama için: `modal run backend/app.py::sub_gate`. status'a YAZMAZ.
    """
    volume.reload()
    vocal_path = _song_dir(song_id) / "master" / "vocals.flac"
    level = round(_sub_vocal_level(vocal_path), 2)
    status = json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8"))
    return _assert_plain({"title": str(status.get("title") or ""), "vocal_rms_dbfs": level,
                          "gate": _sub_vocal_gate(level),
                          "sub": str((status.get("sub") or {}).get("state"))})


@app.local_entrypoint()
def sub_gate(songs: str = "Zeus,Final Duet"):
    needles = [item.strip() for item in songs.split(",") if item.strip()]
    for needle, (song_id, _title) in sub_find.remote(needles).items():
        print(needle, json.dumps(sub_gate_check.remote(song_id), ensure_ascii=False))


@app.function(image=sub_cpu_image, volumes={DATA_DIR: volume}, timeout=600, memory=8192)
def sub_files_check(song_id: str) -> dict:
    """Üretilen alt parça m4a'larını doğrular: boyut, süre, örnekleme hızı ve
    ana vokal m4a'sına göre toplam hatası (AAC gürültüsü dahil). status'a YAZMAZ."""
    import numpy as np

    volume.reload()
    base = _song_dir(song_id) / "stems"
    out = {}
    decoded = {}
    for name, path in (("lead", base / "sub" / "lead.m4a"),
                       ("backing", base / "sub" / "backing.m4a"),
                       ("vocals", base / "vocals.m4a")):
        info = {"exists": path.is_file()}
        if info["exists"]:
            info["bytes"] = int(path.stat().st_size)
            probe = _run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=codec_name,sample_rate,channels:format=duration",
                          "-of", "json", str(path)])
            data = json.loads(probe.stdout.decode("utf-8"))
            stream = data["streams"][0]
            info.update({"codec": stream["codec_name"],
                         "sample_rate": int(stream["sample_rate"]),
                         "channels": int(stream["channels"]),
                         "duration": round(float(data["format"]["duration"]), 2)})
            decoded[name] = _decode_pcm(path, 48000, 2)
        out[name] = info
    if len(decoded) == 3:
        length = min(array.shape[1] for array in decoded.values())
        total = decoded["lead"][:, :length] + decoded["backing"][:, :length]
        reference = decoded["vocals"][:, :length]
        out["sum_vs_vocals_m4a_db"] = _sub_db(_sub_rms(total - reference), _sub_rms(reference))
    return _assert_plain(out)


@app.local_entrypoint()
def sub_files(song: str = "Zeus"):
    for needle, (song_id, _title) in sub_find.remote([song]).items():
        print(needle, json.dumps(sub_files_check.remote(song_id), ensure_ascii=False, indent=1))


@app.local_entrypoint()
def drum_validate(skip: str = "", silent_below: float = -70.0, min_seconds: float = 10.0,
                  overlap: int = SUB_DRUM_OVERLAP, dry: bool = False):
    """Davul alt ayrımı ölçümü: kesitsiz, yalnız metrik, HİÇBİR ŞEY yazılmaz.

        modal run backend/app.py::drum_validate --dry      # yalnız davul seviyeleri (CPU)
        modal run backend/app.py::drum_validate

    Davul RMS'i `silent_below` dBFS altındaysa (ya da şarkı `min_seconds`'tan
    kısaysa) model ÇALIŞTIRILMAZ. Sonuç: backend/sub_out/drum_validate.json.
    """
    levels = sub_levels.remote("drums")
    skips = [item.strip().lower() for item in skip.split(",") if item.strip()]
    print(f"{'baslik':44} {'sure':>6} {'RMS':>8} {'tepe':>7} {'p95':>7} {'>-50':>9}")
    for item in levels:
        print(f"{item['title'][:44]:44} {item['duration']:6.1f} {item['rms_dbfs']:8.1f} "
              f"{item['peak_dbfs']:7.1f} {item['p95_window_dbfs']:7.1f} "
              f"{item['windows_over_m50']:4}/{item['windows']:<4}")
    out_dir = pathlib.Path(__file__).resolve().parent / "sub_out"
    out_dir.mkdir(parents=True, exist_ok=True)
    results = {"levels": levels, "runs": {}, "skipped_silent": [], "skipped_other": []}
    path = out_dir / "drum_validate.json"
    if dry:
        path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        return

    total_cost = 0.0
    for item in levels:
        title = item["title"]
        if any(needle in title.lower() for needle in skips):
            results["skipped_other"].append(title)
            continue
        if item["rms_dbfs"] < silent_below or item["duration"] < min_seconds:
            print(f"[atla] {title[:40]}: davul RMS {item['rms_dbfs']} dBFS / "
                  f"{item['duration']} sn -> model calistirilmadi")
            results["skipped_silent"].append(title)
            continue
        print(f"\n--- {title} ---")
        run = separate_sub.remote(item["id"], "stem", overlap, False, False, "drums")
        m = run["metrics"]
        results["runs"][item["id"]] = {"title": title, "drums_rms_dbfs": item["rms_dbfs"], **{
            k: run[k] for k in ("duration", "overlap", "cold_start", "model_load_s", "wall_s",
                                "billed_estimate_s", "cost_usd_estimate", "peak_vram_mb")},
            "infer_s": m["infer_s"], "realtime_x": m["realtime_x"], "levels": m["levels"],
            "merged_other_power_share": m["merged_other_power_share"],
            "assigned_power_share": m["assigned_power_share"],
            "sum_err_db": m["sum_err_db"], "sum_err_flac24_db": m["sum_err_flac24_db"],
            "harmonic_share": m["harmonic_share"]}
        total_cost += run["cost_usd_estimate"]
        levels_text = ", ".join(f"{k} {v['rel_db']}" for k, v in m["levels"].items())
        print(f"  {run['duration']} sn, overlap {run['overlap']}, "
              f"{'SOGUK' if run['cold_start'] else 'sicak'}, model {run['model_load_s']} sn, "
              f"cikarim {m['infer_s']} sn ({m['realtime_x']}x), toplam {run['wall_s']} sn, "
              f"VRAM {run['peak_vram_mb']} MB, ~${run['cost_usd_estimate']}")
        print(f"  davula gore dB: {levels_text}")
        print(f"  toms'a eklenen artik guc payi {m['merged_other_power_share']}, atanan toplam {m['assigned_power_share']}, "
              f"toplam hata {m['sum_err_db']} dB (FLAC24 {m['sum_err_flac24_db']} dB)")
        print(f"  tonal (harmonik) pay: {m['harmonic_share']}")
        path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nToplam maliyet tahmini: ${total_cost:.3f}")
    path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=600)
def sub_probe_clone(song_id: str) -> dict:
    """Bir şarkının KLONU (`<id>-dpt`): master vokal/davul + alt parçalar + status.

    Davul üretim yolunun vokal alt ayrımını bozmadığını CANLI şarkıya dokunmadan
    denemek için. Klon `source_song` taşır; `sub_cleanup` siler.
    """
    volume.reload()
    source = _song_dir(song_id)
    clone_id = song_id + "-dpt"
    target = _song_dir(clone_id)
    shutil.rmtree(target, ignore_errors=True)
    (target / "master").mkdir(parents=True)
    for name in ("vocals.flac", "drums.flac"):
        shutil.copyfile(source / "master" / name, target / "master" / name)
    for sub_dir in (("master", "sub"), ("stems", "sub")):
        if (source.joinpath(*sub_dir)).is_dir():
            shutil.copytree(source.joinpath(*sub_dir), target.joinpath(*sub_dir))
    data = json.loads((source / "status.json").read_text(encoding="utf-8"))
    data.update({"id": clone_id, "source_song": song_id,
                 "title": "[dpt] " + str(data.get("title") or "")})
    (target / "status.json").write_text(json.dumps(data, ensure_ascii=False, indent=2),
                                        encoding="utf-8")
    volume.commit()
    return _assert_plain({"clone": clone_id})


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=300)
def sub_probe_state(song_id: str) -> dict:
    """Alt parça dosyalarının sha256'sı ve iki grubun durumu (okuma)."""
    volume.reload()
    base = _song_dir(song_id)
    files = {}
    for sub_dir in (("master", "sub"), ("stems", "sub")):
        folder = base.joinpath(*sub_dir)
        if folder.is_dir():
            for path in sorted(folder.iterdir()):
                files["/".join(sub_dir) + "/" + path.name] = hashlib.sha256(
                    path.read_bytes()).hexdigest()[:16]
    status = json.loads((base / "status.json").read_text(encoding="utf-8"))
    brief = lambda sub: None if not sub else {  # noqa: E731
        k: sub.get(k) for k in ("state", "version", "reliability", "lead_share",
                                "merged_other_power_share", "parent_stems_version")}
    return _assert_plain({"files": files, "sub": brief(status.get("sub")),
                          "sub_drums": brief(status.get("sub_drums")),
                          "stems_version": status.get("stems_version"),
                          "pipeline": status.get("pipeline")})


@app.local_entrypoint()
def drum_coexist(song: str = "Zeus"):
    """Davul üretim yolu, VOKAL alt ayrımı yapılmış bir şarkının KLONUNDA: vokal
    dosyaları ve durumu birebir kalmalı. Klon sonda silinir."""
    found = sub_find.remote([song])
    if song not in found:
        raise SystemExit(f"'{song}' bulunamadi")
    source_id, title = found[song]
    print(f"kaynak: {title}")
    clone = sub_probe_clone.remote(source_id)["clone"]
    try:
        before = sub_probe_state.remote(clone)
        print("once :", json.dumps(before, ensure_ascii=False))
        run = separate_sub.remote(clone, "stem", SUB_DRUM_OVERLAP, False, True, "drums")
        print(f"davul koştu: {run['wall_s']} sn, ~${run['cost_usd_estimate']}, "
              f"durum {run['metrics']['production']['state']}")
        after = sub_probe_state.remote(clone)
        print("sonra:", json.dumps(after, ensure_ascii=False))
        vocal_files = [k for k in before["files"] if any(
            k.endswith(f"/{name}.flac") or k.endswith(f"/{name}.m4a") for name in SUB_PART_NAMES)]
        same_files = all(after["files"].get(k) == before["files"][k] for k in vocal_files)
        print(f"vokal dosyalari ({len(vocal_files)}) ayni: {same_files}")
        print(f"vokal durumu (status.sub) ayni: {after['sub'] == before['sub']}")
        print(f"stems_version/pipeline ayni: "
              f"{after['stems_version'] == before['stems_version'] and after['pipeline'] == before['pipeline']}")
        print(f"davul parcalari yazildi: "
              f"{sorted(k for k in after['files'] if k.endswith('.m4a') and not any(k.endswith('/' + n + '.m4a') for n in SUB_PART_NAMES))}")
        print(f"davul durumu: {after['sub_drums']}")
        # Tersi: vokal yeniden yazımı davul dosyalarını bozmaz (parça dosyaları ayrı silinir).
    finally:
        print(json.dumps(sub_cleanup_run.remote(dry_run=False, only=source_id), ensure_ascii=False))


@app.function(image=sub_cpu_image, volumes={DATA_DIR: volume}, timeout=300)
def sub_cleanup_run(dry_run: bool = True, only: str = "") -> dict:
    """`<id>-sb<harf>s` kesit şarkılarını ve /data/sub-exp'i siler.

    only: doluysa YALNIZ bu kaynak şarkı kimliğinin (öneki) kesitleri ve
    sub-exp klasörü silinir; diğerleri kalır.
    """
    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    pattern = re.compile(r"^[0-9a-f]{64}-(sb[a-z]s|dpt)$")   # kesitler + davul probe klonu
    removed = []
    for entry in sorted(root.iterdir()) if root.is_dir() else []:
        if not pattern.match(entry.name):
            continue
        if only and not entry.name.startswith(only):
            continue
        status_path = entry / "status.json"
        try:
            data = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not data.get("source_song"):          # yalnız deney kesitleri
            continue
        removed.append(entry.name)
        if not dry_run:
            shutil.rmtree(_safe_song_dir(entry.name))
    exp_root = pathlib.Path(DATA_DIR) / SUB_EXP_SUBDIR
    if only:
        exp_root = exp_root / only if _is_valid_song_id(only) else exp_root / "yok"
    exp_bytes = 0
    if exp_root.is_dir():
        exp_bytes = sum(p.stat().st_size for p in exp_root.rglob("*") if p.is_file())
        if not dry_run:
            shutil.rmtree(exp_root)
    if not dry_run:
        volume.commit()
    return _assert_plain({"dry_run": bool(dry_run), "excerpt_songs": removed,
                          "sub_exp_bytes": int(exp_bytes)})


@app.local_entrypoint()
def sub_cleanup(yes: bool = False, only: str = ""):
    """Deney kesitlerini ve geçici çıktıları temizler (varsayılan: yalnız göster).

    --only <kaynak sarki kimligi>: yalniz o sarkinin kesitleri.
    """
    print(json.dumps(sub_cleanup_run.remote(dry_run=not yes, only=only),
                     ensure_ascii=False, indent=2))


# --------------------------------------------------------------------------
# Şarkı sözleri (Aşama 11)
#
# İKİ mod, tek şema: "auto" (Whisper large-v3 çıkarır) ve "pasted" (kullanıcının
# yapıştırdığı metin sese hizalanır). Girdi SW vokal stem'i. VAD YOK (reverb'li
# vokalde sesi konuşma saymıyor: NEM slowed'da söz hata oranı 0.97), onun yerine
# vokal enerjisinden enerji maskesi. Ölçümler PLAN.md Aşama 11'de.
# Ana şarkı yeniden işlenince sözler SİLİNMEZ: `parent_stems_version` ile
# karşılaştırılıp "eski ayrıştırmadan" diye işaretlenir (`_lyr_stale`).
# Yapıştırılan metin yalnız Volume'da (lyrics.json) durur; depoya girmez.
# --------------------------------------------------------------------------

LYRICS_LANGS = ("tr", "en", "ja")
LYRICS_MODES = ("auto", "pasted")
LYRICS_MODEL = "large-v3"
LYRICS_HF_HOME = "/data/weights-lyrics/hf"      # deneyde indirilen faster-whisper ağırlığı
LYRICS_RATE = 16000
LYRICS_HOP = 0.05                    # sn: enerji çerçevesi
LYRICS_SILENT_DBFS = SUB_SILENT_DBFS  # "vokal yok" kapısıyla AYNI sayı (-50 dBFS)
LYRICS_SILENCE_MIN_SECONDS = 2.0     # >= bu kadar sessizlik "enstrümantal bölge"
LYRICS_BREATH_GAP_SECONDS = 0.5      # bundan kısa boşluklar nefes sayılır
LYRICS_MAX_CHARS = 30000
LYRICS_MAX_LINES = 400
LYRICS_RUNNING_STALE_SECONDS = 2400
LYRICS_MIN_LINE_SECONDS = 0.2        # süzgeç: bundan kısa satır uydurma sayılır
LYRICS_MIN_LINE_LETTERS = 2          # süzgeç: harf sayısı bundan az
LYRICS_MAX_REPEATS = 3               # süzgeç: aynı satırın art arda en çok bu kadarı
LYRICS_ACTIVE_LINE_FRACTION = 0.3    # süzgeç: kelimesiz satırın en az %30'u sesli
# "Metin sesle uyuşmuyor olabilir" (yapıştır ve hizala): uyuşan hizalamalarda
# ortalama kelime olasılığı 0.49-0.77, uyuşmayanlarda 0.05-0.15 ölçüldü (4 çift);
# sessiz satır oranı zayıf bir işaret (uyuşmayanda 0 ve 0.05, uyuşanda 0).
LYRICS_MISMATCH_PROB = 0.30
LYRICS_MISMATCH_SILENT_RATIO = 0.03
LYRICS_MISMATCH_SILENT_LINES = 2
LYRICS_USD_PER_SECOND = SUB_USD_PER_SECOND

_LYR_NVIDIA = "/usr/local/lib/python3.11/site-packages/nvidia"
# AYRI imaj: separate_image (Hi-Fi) ve sub_image'a DOKUNULMAZ.
lyrics_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("torch==2.5.1", "torchaudio==2.5.1", "numpy==1.26.4")
    .pip_install(
        "faster-whisper==1.2.1",
        "ctranslate2==4.6.0",       # CUDA 12 + cuDNN 9 (torch 2.5.1 cu124 ile birlikte çalıştı)
        "stable-ts==2.19.1",        # NOT: depo arşivli (2026-05-30); sürüm pinli
        "soundfile==0.13.1",
    )
    .env({
        "HF_HOME": LYRICS_HF_HOME,
        "LD_LIBRARY_PATH": f"{_LYR_NVIDIA}/cudnn/lib:{_LYR_NVIDIA}/cublas/lib:"
                           f"{_LYR_NVIDIA}/cuda_runtime/lib",
    })
)


def _lyrics_is_running(status) -> bool:
    lyr = (status or {}).get("lyrics") or {}
    if lyr.get("state") != "running":
        return False
    return (time.time() - float(lyr.get("started") or 0)) < LYRICS_RUNNING_STALE_SECONDS


def _lyr_stale(status) -> bool:
    """Sözler başka bir ayrıştırmadan mı? (Ana şarkı sonradan yeniden işlendi.)"""
    lyr = (status or {}).get("lyrics") or {}
    if lyr.get("state") != "done":
        return False
    return lyr.get("parent_stems_version") != (status or {}).get("stems_version")


def _lyr_check_text(text) -> tuple:
    """Yapıştırılan metni satırlara böler. Dönen: (satırlar, hata ya da None).

    Boş satırlar atılır, her satır kırpılır, denetim karakterleri silinir.
    """
    if not isinstance(text, str):
        return [], "metin gerekli"
    if len(text) > LYRICS_MAX_CHARS:
        return [], f"metin en fazla {LYRICS_MAX_CHARS} karakter olabilir"
    cleaned = "".join(ch for ch in text if ch in "\n\r\t" or ch >= " ")
    lines = [" ".join(line.split()) for line in cleaned.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return [], "metin bos"
    if len(lines) > LYRICS_MAX_LINES:
        return [], f"en fazla {LYRICS_MAX_LINES} satir olabilir"
    return lines, None


def _lyr_levels(audio):
    """LYRICS_HOP çerçevelerinde RMS, dBFS (mono 16 kHz diziden)."""
    import numpy as np

    size = int(LYRICS_HOP * LYRICS_RATE)
    count = len(audio) // size
    frames = audio[: count * size].reshape(count, size).astype(np.float64)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-9))


def _lyr_activity(levels):
    """(aktif çerçeve maskesi, eşik dBFS, p95). Eşik: mutlak -50 ile (tepe - 40 dB)'nin büyüğü."""
    import numpy as np

    p95 = float(np.percentile(levels, 95))
    threshold = max(LYRICS_SILENT_DBFS, p95 - 40.0)
    return levels > threshold, threshold, p95


def _lyr_fill_gaps(active, max_gap_frames: int):
    """Kısa nefes boşluklarını aktif say."""
    out = active.copy()
    n = len(out)
    i = 0
    while i < n:
        if out[i]:
            i += 1
            continue
        j = i
        while j < n and not out[j]:
            j += 1
        if i > 0 and j < n and (j - i) <= max_gap_frames:
            out[i:j] = True
        i = j
    return out


def _lyr_silences(active):
    """Ardışık sessiz çerçeve aralıkları >= LYRICS_SILENCE_MIN_SECONDS: [(a, b)] (b hariç)."""
    filled = _lyr_fill_gaps(active, int(LYRICS_BREATH_GAP_SECONDS / LYRICS_HOP))
    regions = []
    n = len(filled)
    i = 0
    while i < n:
        if filled[i]:
            i += 1
            continue
        j = i
        while j < n and not filled[j]:
            j += 1
        if (j - i) * LYRICS_HOP >= LYRICS_SILENCE_MIN_SECONDS:
            regions.append((i, j))
        i = j
    return regions


def _lyr_lines_in_silence(lines, silences) -> int:
    """Süresinin >= %50'si enstrümantal (sessiz) bölgeye düşen satır sayısı."""
    count = 0
    for line in lines:
        a, b = int(line["start"] / LYRICS_HOP), int(line["end"] / LYRICS_HOP)
        span = max(b - a, 1)
        covered = sum(max(0, min(b, e) - max(a, s)) for s, e in silences)
        if covered / span >= 0.5:
            count += 1
    return count


def _lyr_join(words) -> str:
    """Kelimelerden satır metni: boşluklu yazıda (tr/en) arada boşluk, Japoncada bitişik."""
    if any(w["w"].startswith(" ") or w["w"].endswith(" ") for w in words):
        return " ".join(w["w"].strip() for w in words if w["w"].strip())
    return "".join(w["w"] for w in words).strip()


def _lyr_mask_filter(lines, active):
    """Enerji maskesi: orta noktası sessiz çerçevede kalan KELİMELER atılır; kelimesi
    kalmayan (ya da kelime bilgisi yokken çerçevelerinin %30'undan azı sesli) satır
    atılır. Satır aralığı kalan kelimelerden yeniden hesaplanır."""
    n = len(active)
    out = []
    for line in lines:
        words = line.get("words") or []
        if words:
            alive = []
            for w in words:
                mid = int(((w["s"] + w["e"]) / 2) / LYRICS_HOP)
                if 0 <= mid < n and active[mid]:
                    alive.append(w)
            if not alive:
                continue
            line = dict(line, words=alive, start=alive[0]["s"], end=alive[-1]["e"],
                        text=_lyr_join(alive))
        else:
            a = int(line["start"] / LYRICS_HOP)
            b = max(int(line["end"] / LYRICS_HOP), a + 1)
            if b > n or active[a:b].mean() < LYRICS_ACTIVE_LINE_FRACTION:
                continue
        out.append(line)
    return out


def _lyr_clean_lines(lines):
    """Kısa ve tekrar süzgeçleri (yalnız auto): çok kısa süreli ya da harfsiz satırlar
    ve aynı satırın art arda LYRICS_MAX_REPEATS'ten fazla tekrarı atılır."""
    kept = []
    for line in lines:
        text = str(line.get("text") or "").strip()
        letters = sum(1 for ch in text if ch.isalpha())
        if letters < LYRICS_MIN_LINE_LETTERS:
            continue
        if (line["end"] - line["start"]) < LYRICS_MIN_LINE_SECONDS:
            continue
        kept.append(dict(line, text=text))
    out, run = [], 0
    for line in kept:
        if out and out[-1]["text"] == line["text"]:
            run += 1
            if run >= LYRICS_MAX_REPEATS:
                continue
        else:
            run = 0
        out.append(line)
    return out


def _lyr_quality(lines, silences) -> dict:
    probs = [w["p"] for line in lines for w in (line.get("words") or []) if "p" in w]
    silent = _lyr_lines_in_silence(lines, silences)
    return {
        "silent_lines": silent,
        "silent_line_ratio": round(silent / max(len(lines), 1), 4),
        "mean_word_prob": round(sum(probs) / len(probs), 3) if probs else None,
    }


def _lyr_mismatch(quality: dict) -> bool:
    """Yapıştırılan metin sesle uyuşmuyor olabilir mi? (yalnız pasted)"""
    prob = quality.get("mean_word_prob")
    if prob is not None and prob < LYRICS_MISMATCH_PROB:
        return True
    return (quality["silent_lines"] >= LYRICS_MISMATCH_SILENT_LINES
            and quality["silent_line_ratio"] >= LYRICS_MISMATCH_SILENT_RATIO)


def _lyr_doc(source: str, language: str, lines, duration: float, version: int) -> dict:
    """lyrics.json şeması (schema 1). Zamanlar ŞARKI saniyesinde (hızdan bağımsız)."""
    return {
        "schema": 1, "version": version, "source": source, "language": language,
        "duration": round(float(duration), 2),
        "lines": [
            {"t": round(float(line["start"]), 2), "e": round(float(line["end"]), 2),
             "text": str(line["text"]),
             "w": [[round(float(w["s"]), 2), round(float(w["e"]), 2), str(w["w"]).strip()]
                   for w in (line.get("words") or [])],
             **({"c": 0} if line.get("c") == 0 else {}),      # düşük güven: eşleşmeyen satır
             **({"m": 1} if line.get("m") else {})}           # elle konan zaman (çapa)
            for line in lines
        ],
    }


def _lyr_language_windows(audio, count: int = 4):
    """Vokal enerjisi en yüksek, birbiriyle çakışmayan 30 sn'lik pencereler."""
    import numpy as np

    size = 30 * LYRICS_RATE
    if len(audio) <= size:
        return [audio]
    step = 10 * LYRICS_RATE
    starts = list(range(0, len(audio) - size + 1, step))
    ranked = sorted(starts, key=lambda s: -float(np.mean(audio[s:s + size].astype(np.float64) ** 2)))
    chosen = []
    for start in ranked:
        if all(abs(start - other) >= size for other in chosen):
            chosen.append(start)
        if len(chosen) == count:
            break
    return [audio[s:s + size] for s in sorted(chosen)]


def _lyr_pick_language(window_scores) -> tuple:
    """Pencere başına {dil: olasılık} listesinden tr/en/ja içinde kazanan.

    Yalnız desteklenen üç dil sayılır (ilk sürümde tek dil, tr/en/ja). Dönen:
    (dil, ayrıntı). Skor yoksa dil None."""
    totals = {lang: 0.0 for lang in LYRICS_LANGS}
    for scores in window_scores:
        for lang in LYRICS_LANGS:
            totals[lang] += float(scores.get(lang, 0.0))
    count = max(len(window_scores), 1)
    mean = {lang: round(totals[lang] / count, 3) for lang in LYRICS_LANGS}
    if not window_scores or max(totals.values()) <= 0:
        return None, {"windows": len(window_scores), "scores": mean}
    return max(totals, key=totals.get), {"windows": len(window_scores), "scores": mean}


def _lyr_detect_language(model, audio) -> tuple:
    scores = []
    for window in _lyr_language_windows(audio):
        _, _, all_probs = model.detect_language(audio=window)
        scores.append({lang: float(prob) for lang, prob in all_probs})
    return _lyr_pick_language(scores)


def _lyr_segments(result) -> list:
    """stable-ts sonucundan satır sözlükleri (kelime olasılıklarıyla)."""
    lines = []
    for seg in result.segments:
        words = [{"s": float(w.start), "e": float(w.end), "w": w.word,
                  "p": float(getattr(w, "probability", 0.0) or 0.0)}
                 for w in (seg.words or [])]
        lines.append({"start": float(seg.start), "end": float(seg.end),
                      "text": str(seg.text).strip(), "words": words})
    return lines


# --- Yapıştır ve hizala v2: otomatik çıkarmayla eşleştir, çapalar arasında yerel hizala ---
#
# Eski yöntem metnin TAMAMINI tek `align()` çağrısına veriyordu. Metinde bir nakarat tekrarı
# eksikse hizalayıcı sonraki satırları o tekrarın sesine yapıştırıyordu (Bağımlı: 9 satır
# 66-83 sn erken). Yeni yol: (1) sesten otomatik kelimeler (varsa kayıtlı), (2) yapıştırılan
# kelimelerle bulanık SIRALI eşleştirme (Needleman-Wunsch), (3) yeterince eşleşen satırlar
# ÇAPA: yalnız kendi küçük pencerelerinde hizalanır, (4) eşleşmeyen satır dizileri iki çapa
# arasındaki pencerede, vokal enerjisine göre hizalanır ve "düşük güven" (c: 0) işaretlenir,
# (5) elle girilen zamanlar (manual) çapadır. Eşleşme çok düşükse eski global yola düşülür.

LYRICS_MATCH_SIM = 0.6
LYRICS_MATCH_GAP = -0.5
LYRICS_MATCH_MAX_CELLS = 9_000_000
LYRICS_ANCHOR_MIN_RATIO = 0.35         # tüm metnin bundan azı eşleşirse global yola dön
LYRICS_MISMATCH_MATCH_RATIO = 0.5      # eşleşme oranı bundan azsa "metin sesle uyuşmuyor" uyarısı
LYRICS_GAP_MIN_TOKENS = 4              # ses var, metin yok: en az kaç kelime
LYRICS_GAP_MIN_SECONDS = 2.0
LYRICS_PAD_BASE = 0.4                  # çapa penceresi payı (sn)
LYRICS_PAD_PER_WORD = 0.5              # eşleşmeyen baştaki/sondaki her kelime için ek pay
LYRICS_PAD_PER_CHAR = 0.18             # Japonca: karakter başına
LYRICS_PAD_MAX = 3.0
LYRICS_MANUAL_LEAD = 0.25              # elle konan zamandan bu kadar önce başlayan pencere
LYRICS_MIN_WINDOW = 0.25
LYRICS_CLUSTER_GAP = 5.0               # bir satırın eşleşen kelimeleri arası en çok bu kadar (aykırı eşleşme elemesi)
LYRICS_TIMES_MIN_GAP = 0.05            # satır başları arası en az (elle düzeltme)


def _lyr_norm_token(text: str) -> str:
    import unicodedata

    text = unicodedata.normalize("NFKC", text).replace("I", "ı").replace("İ", "i").lower()
    return "".join(ch for ch in text if ch.isalnum())


def _lyr_line_tokens(line: str, language: str) -> list:
    """Eşleştirme belirteçleri: tr/en kelime, Japonca karakter."""
    if language == "ja":
        return [t for t in (_lyr_norm_token(ch) for ch in line) if t]
    return [t for t in (_lyr_norm_token(word) for word in line.split()) if t]


def _lyr_auto_tokens(words, language: str) -> list:
    """Otomatik kelimeler [(s, e, w)] -> [(belirteç, s, e)] (Japoncada karakterlere bölünür)."""
    out = []
    for start, end, word in words:
        if language == "ja":
            chars = [c for c in (_lyr_norm_token(ch) for ch in str(word)) if c]
            span = (float(end) - float(start)) / max(len(chars), 1)
            for k, char in enumerate(chars):
                out.append((char, float(start) + k * span, float(start) + (k + 1) * span))
        else:
            token = _lyr_norm_token(str(word))
            if token:
                out.append((token, float(start), float(end)))
    return out


def _lyr_similarity(a: str, b: str) -> float:
    import difflib

    if a == b:
        return 1.0
    if len(a) <= 2 or len(b) <= 2:
        return 0.0                       # kısa belirteçler yalnız birebir eşleşir
    if abs(len(a) - len(b)) > max(2, 0.4 * max(len(a), len(b))):
        return 0.0
    if a[0] != b[0] and a[-1] != b[-1]:
        return 0.0                       # ucuz eleme: ne baslangic ne bitis ortak (nadir kayip, buyuk hiz)
    return difflib.SequenceMatcher(None, a, b).ratio()


def _lyr_match(pasted: list, auto: list) -> dict:
    """Sıralı bulanık eşleştirme: {yapıştırılan indeks: otomatik indeks}. Sıra korunur.

    Needleman-Wunsch (eşleşme 2*benzerlik-0.8 >= 0.4, eşleşmeme -1, boşluk -0.5). Hücre sayısı
    LYRICS_MATCH_MAX_CELLS'ten büyükse ValueError (çağıran global yola düşer).
    """
    n, m = len(pasted), len(auto)
    if n == 0 or m == 0:
        return {}
    if n * m > LYRICS_MATCH_MAX_CELLS:
        raise ValueError(f"eslestirme cok buyuk: {n}x{m}")
    gap = LYRICS_MATCH_GAP
    cache = {}

    def score(i, j):
        key = (pasted[i], auto[j])
        value = cache.get(key)
        if value is None:
            sim = _lyr_similarity(*key)
            value = (sim * 2 - 0.8) if sim >= LYRICS_MATCH_SIM else -1.0
            cache[key] = value
        return value

    trace = [bytearray(m + 1) for _ in range(n + 1)]
    previous = [j * gap for j in range(m + 1)]
    for j in range(1, m + 1):
        trace[0][j] = 2
    for i in range(1, n + 1):
        current = [i * gap] + [0.0] * m
        row = trace[i]
        row[0] = 1
        for j in range(1, m + 1):
            diagonal = previous[j - 1] + score(i - 1, j - 1)
            up = previous[j] + gap
            left = current[j - 1] + gap
            best = diagonal
            move = 0
            if up > best:
                best, move = up, 1
            if left > best:
                best, move = left, 2
            current[j] = best
            row[j] = move
        previous = current
    pairs = {}
    i, j = n, m
    while i > 0 or j > 0:
        move = trace[i][j] if (i > 0 and j > 0) else (1 if i > 0 else 2)
        if move == 0:
            if score(i - 1, j - 1) > 0:
                pairs[i - 1] = j - 1
            i -= 1
            j -= 1
        elif move == 1:
            i -= 1
        else:
            j -= 1
    return pairs


def _lyr_gaps(pairs: dict, auto: list, language: str) -> list:
    """Sesten çıkan ama metinde karşılığı olmayan bölümler: [[t0, t1, belirteç sayısı]]."""
    matched = set(pairs.values())
    minimum = LYRICS_GAP_MIN_TOKENS * (2 if language == "ja" else 1)
    runs = []
    j = 0
    while j < len(auto):
        if j in matched:
            j += 1
            continue
        k = j
        while k < len(auto) and k not in matched:
            k += 1
        t0, t1 = auto[j][1], auto[k - 1][2]
        if (k - j) >= minimum and (t1 - t0) >= LYRICS_GAP_MIN_SECONDS:
            runs.append([round(t0, 1), round(t1, 1), k - j])
        j = k
    return runs


def _lyr_main_cluster(matched: list, auto: list) -> list:
    """Satırın eşleşen kelimelerinden zaman olarak tutarlı en büyük küme. Ortak bir kelimenin başka
    yerdeki tesadüfi eşleşmesi (aykırı) pencereyi onlarca saniye açıp hizalamayı yanlış yere atıyordu
    (Bağımlı'da bir satır 188 sn'ye düştü). Ardışık eşleşmeler arası > LYRICS_CLUSTER_GAP ise küme biter."""
    if len(matched) < 2:
        return matched
    clusters, current = [], [matched[0]]
    for before, after in zip(matched, matched[1:]):
        if auto[after[1]][1] - auto[before[1]][2] > LYRICS_CLUSTER_GAP:
            clusters.append(current)
            current = []
        current.append(after)
    clusters.append(current)
    return max(clusters, key=len)


def _lyr_plan(line_tokens: list, pairs: dict, auto: list, manual: dict, language: str) -> list:
    """Satır başına {kind: anchor|manual|free, ...}. line_tokens: satır başına belirteç listesi.

    Çapa: satırın belirteçlerinin en az yarısı (en az 2; 1-2 belirteçli satırda 1) otomatik
    kelimelerle eşleşmiş. Pencere: ilk/son eşleşen kelimenin otomatik zamanı +- pay (baştaki /
    sondaki eşleşmeyen her kelime için ek pay).
    """
    import math

    per_unit = LYRICS_PAD_PER_CHAR if language == "ja" else LYRICS_PAD_PER_WORD
    plan = []
    offset = 0
    for index, tokens in enumerate(line_tokens):
        count = len(tokens)
        matched = [(pos, pairs[offset + pos]) for pos in range(count) if (offset + pos) in pairs]
        matched = _lyr_main_cluster(matched, auto)
        entry = {"kind": "free", "tokens": count, "matched": len(matched)}
        if index in manual:
            entry.update(kind="manual", start=float(manual[index]))
        elif matched:
            need = 1 if count <= 2 else max(2, math.ceil(count / 2))
            if len(matched) >= need:
                p0, a0 = matched[0]
                p1, a1 = matched[-1]
                pad_start = min(LYRICS_PAD_MAX, LYRICS_PAD_BASE + per_unit * p0)
                pad_end = min(LYRICS_PAD_MAX, LYRICS_PAD_BASE + per_unit * (count - 1 - p1))
                entry.update(kind="anchor", start=max(0.0, auto[a0][1] - pad_start),
                             end=auto[a1][2] + pad_end)
        plan.append(entry)
        offset += count
    return plan


def _lyr_blocks(plan: list, duration: float) -> list:
    """Planı hizalama bloklarına böler. Blok: {kind, lines, lo, hi}.

    anchor: tek satır, pencere kendi çapası. manual: elle zamandan sonraki eşleşmeyen satırlara
    kadar ve sonraki zorunlu başlangıca (çapa/elle) dek. free: ardışık eşleşmeyen satırlar, önceki
    bloğun sonu ile sonraki zorunlu başlangıç arası.
    """
    blocks = []
    count = len(plan)
    cursor = 0.0
    i = 0

    def next_start(j):
        return plan[j]["start"] if j < count else float(duration)

    while i < count:
        entry = plan[i]
        if entry["kind"] == "anchor":
            blocks.append({"kind": "anchor", "lines": [i], "lo": entry["start"], "hi": entry["end"]})
            cursor = entry["end"]
            i += 1
        elif entry["kind"] == "manual":
            j = i + 1
            while j < count and plan[j]["kind"] == "free":
                j += 1
            hi = next_start(j)
            lo = max(0.0, entry["start"] - LYRICS_MANUAL_LEAD)
            blocks.append({"kind": "manual", "lines": list(range(i, j)), "lo": lo,
                           "hi": max(hi, lo + LYRICS_MIN_WINDOW)})
            cursor = hi
            i = j
        else:
            j = i
            while j < count and plan[j]["kind"] == "free":
                j += 1
            blocks.append({"kind": "free", "lines": list(range(i, j)), "lo": cursor,
                           "hi": next_start(j)})
            cursor = next_start(j)
            i = j
    return blocks


def _lyr_even_lines(texts: list, lo: float, hi: float) -> list:
    """Hizalanamayan bloklarda satırları pencereye eşit dağıt (düşük güven)."""
    count = max(len(texts), 1)
    step = max(hi - lo, 0.1 * count) / count
    out = []
    for k, text in enumerate(texts):
        start = lo + k * step
        end = start + max(step * 0.9, 0.1)
        words = text.split() or [text]
        span = (end - start) / len(words)
        out.append({"start": start, "end": end, "text": text, "c": 0,
                    "words": [{"s": start + n * span, "e": start + (n + 1) * span, "w": w, "p": 0.0}
                              for n, w in enumerate(words)]})
    return out


def _lyr_align_window(model, audio, keep, lo: float, hi: float, texts: list, language: str, gate: bool):
    """Pencerede hizalama; başarısızsa None. gate: sessiz çerçeveler sıfırlanır (eşleşmeyen satırlar)."""
    import numpy as np

    first = int(lo / LYRICS_HOP)
    last = min(int(hi / LYRICS_HOP) + 1, len(keep))
    segment = audio[int(lo * LYRICS_RATE):int(hi * LYRICS_RATE)]
    if len(segment) < int(0.2 * LYRICS_RATE):
        return None
    if gate:
        size = int(LYRICS_HOP * LYRICS_RATE)
        segment = segment.copy()
        for k in range(first, last):
            if not keep[k]:
                a = (k - first) * size
                segment[a:a + size] = 0.0
    try:
        result = model.align(segment.astype(np.float32), "\n".join(texts), language=language,
                             original_split=True)
    except Exception as error:
        print(f"[soz] pencere hizalama hatasi ({lo:.1f}-{hi:.1f}): {type(error).__name__}: {str(error)[:120]}")
        return None
    segments = list(result.segments)
    if len(segments) != len(texts):
        return None
    lines = []
    for text, seg in zip(texts, segments):
        words = [{"s": float(w.start) + lo, "e": float(w.end) + lo, "w": w.word,
                  "p": float(getattr(w, "probability", 0.0) or 0.0)} for w in (seg.words or [])]
        if not words:
            return None
        lines.append({"start": words[0]["s"], "end": words[-1]["e"], "text": text, "words": words})
    return lines


def _lyr_run_anchored(model, audio, active, duration: float, language: str, texts: list,
                      auto_words: list, manual: dict) -> tuple:
    """Eşleştir, planla, blok blok hizala. Dönen: (satırlar, bilgi). Eşleşme çok düşükse ValueError."""
    line_tokens = [_lyr_line_tokens(text, language) for text in texts]
    flat = [token for tokens in line_tokens for token in tokens]
    auto = _lyr_auto_tokens(auto_words, language)
    if not flat or not auto:
        raise ValueError("eslestirilecek belirtec yok")
    pairs = _lyr_match(flat, [token for token, _, _ in auto])
    ratio = len(pairs) / len(flat)
    if ratio < LYRICS_ANCHOR_MIN_RATIO and not manual:
        raise ValueError(f"eslesme orani dusuk: {ratio:.2f}")
    plan = _lyr_plan(line_tokens, pairs, auto, manual, language)
    blocks = _lyr_blocks(plan, duration)
    keep = _lyr_fill_gaps(active, int(0.3 / LYRICS_HOP))
    out = [None] * len(texts)
    cursor = 0.0
    for block in blocks:
        lo = max(block["lo"], cursor)
        hi = min(max(block["hi"], lo + LYRICS_MIN_WINDOW), float(duration))
        lo = min(lo, max(hi - LYRICS_MIN_WINDOW, 0.0))
        idxs = block["lines"]
        block_texts = [texts[i] for i in idxs]
        free = block["kind"] == "free"
        if free:
            # eşleşmeyen satırlar: yalnız pencerenin SESLİ kısmına sığdır
            a, b = int(lo / LYRICS_HOP), min(int(hi / LYRICS_HOP) + 1, len(keep))
            voiced = [k for k in range(a, b) if keep[k]]
            if voiced:
                lo, hi = max(lo, voiced[0] * LYRICS_HOP), min(hi, (voiced[-1] + 1) * LYRICS_HOP)
        aligned = None
        if hi - lo >= LYRICS_MIN_WINDOW and (not free or hi - lo >= 0.3 * len(block_texts)):
            aligned = _lyr_align_window(model, audio, keep, lo, hi, block_texts, language, gate=free)
        if aligned is None:
            aligned = _lyr_even_lines(block_texts, lo, hi)
            confident = False
        else:
            confident = not free
        for k, line in zip(idxs, aligned):
            line = dict(line)
            if not confident or free:
                line["c"] = 0
            if block["kind"] == "manual" and k == idxs[0]:
                line["m"] = 1
                line.pop("c", None)
            out[k] = line
        cursor = max(cursor, aligned[-1]["end"])
    # sıra ve uç düzeltmesi
    previous_start = -1.0
    for line in out:
        if line["start"] <= previous_start:
            shift = previous_start + 0.01 - line["start"]
            line["start"] += shift
            line["end"] += shift
        line["end"] = max(line["end"], line["start"] + 0.1)
        previous_start = line["start"]
    low = [i for i, line in enumerate(out) if line.get("c") == 0]
    info = {
        "method": "anchored", "pasted_tokens": len(flat), "auto_tokens": len(auto),
        "matched_tokens": len(pairs), "match_ratio": round(ratio, 3),
        "anchor_lines": sum(1 for p in plan if p["kind"] == "anchor"),
        "manual_lines": sum(1 for p in plan if p["kind"] == "manual"),
        "low_confidence_lines": low, "gaps": _lyr_gaps(pairs, auto, language)[:12],
    }
    return out, info


def _lyr_run_global(model, audio, language: str, texts: list) -> list:
    """Eski yol: metnin tamamı tek hizalama (eşleşme kullanılamıyorsa yedek)."""
    result = model.align(audio, "\n".join(texts), language=language, original_split=True)
    return _lyr_segments(result)


def _lyr_apply_times(doc: dict, sets: list, duration: float) -> tuple:
    """Elle düzeltilen satır başlarını belgeye uygular (CPU, API'de). Dönen: (yeni belge, hata).

    Her {i, t}: satırın başlangıcı t olur, bitiş ve kelime zamanları aynı farkla kayar, `m: 1`
    işaretlenir ve `c` kalkar. Önceki satırın bitişi yeni başlangıca taşarsa kısaltılır. Sonuçta
    satır başları en az LYRICS_TIMES_MIN_GAP arayla artmalı, yoksa hata.
    """
    import copy

    if not isinstance(sets, list) or not sets or len(sets) > LYRICS_MAX_LINES:
        return None, "set listesi gerekli"
    lines = copy.deepcopy(doc.get("lines") or [])
    seen = set()
    for item in sets:
        if not isinstance(item, dict):
            return None, "set ogesi {i, t} olmali"
        index, value = item.get("i"), item.get("t")
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(lines):
            return None, "gecersiz satir"
        number, problem = _export_number(value, 0.0, max(float(duration), 0.0), "t")
        if problem:
            return None, problem
        if index in seen:
            return None, "ayni satir iki kez"
        seen.add(index)
    for item in sorted(sets, key=lambda it: it["i"]):
        index, new_start = item["i"], round(float(item["t"]), 2)
        line = lines[index]
        delta = new_start - float(line["t"])
        line["t"] = new_start
        line["e"] = round(max(float(line["e"]) + delta, new_start + 0.1), 2)
        line["w"] = [[round(a + delta, 2), round(b + delta, 2), w] for a, b, w in (line.get("w") or [])]
        line["m"] = 1
        line.pop("c", None)
        if index > 0:
            before = lines[index - 1]
            if float(before["e"]) > new_start - 0.02:
                limit = round(max(float(before["t"]) + 0.05, new_start - 0.02), 2)
                before["e"] = limit
                before["w"] = [[min(a, limit), min(b, limit), w] for a, b, w in (before.get("w") or [])]
    for k in range(1, len(lines)):
        if float(lines[k]["t"]) < float(lines[k - 1]["t"]) + LYRICS_TIMES_MIN_GAP:
            return None, f"siralama bozuluyor (satir {k + 1})"
    for line in lines:
        line["e"] = round(min(float(line["e"]), max(float(duration), float(line["t"]) + 0.1)), 2)
    new = dict(doc)
    new["lines"] = lines
    return new, None


def _lyr_check_manual(raw, line_count: int, duration: float) -> tuple:
    """`manual` doğrulaması: [{i, t}]. i boş olmayan satırların sırası (0'dan), t [0, süre], t i ile ARTAN.
    Dönen: (normalize liste, hata ya da None)."""
    if raw is None:
        return [], None
    if not isinstance(raw, list) or len(raw) > LYRICS_MAX_LINES:
        return [], "manual liste olmali"
    items = []
    for item in raw:
        if not isinstance(item, dict):
            return [], "manual ogesi {i, t} olmali"
        index, value = item.get("i"), item.get("t")
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < line_count:
            return [], "manual: gecersiz satir"
        number, problem = _export_number(value, 0.0, max(duration, 0.0), "manual.t")
        if problem:
            return [], problem
        items.append({"i": index, "t": round(number, 2)})
    items.sort(key=lambda it: it["i"])
    for before, after in zip(items, items[1:]):
        if before["i"] == after["i"]:
            return [], "manual: ayni satir iki kez"
        if after["t"] <= before["t"]:
            return [], "manual: zamanlar satir sirasiyla artmali"
    return items, None


def _lyr_auto_words_from_doc(doc) -> list:
    return [(float(a), float(b), str(w)) for line in (doc or {}).get("lines", [])
            for a, b, w in (line.get("w") or [])]


def _lyr_load_auto_words(song_dir: pathlib.Path, status: dict, language: str):
    """Kayıtlı otomatik kelimeler (aynı ayrıştırma ve dil için); yoksa None."""
    try:
        data = json.loads((song_dir / "lyrics_auto.json").read_text(encoding="utf-8"))
        if (data.get("stems_version") == status.get("stems_version")
                and data.get("language") == language and data.get("words")):
            return [(float(a), float(b), str(w)) for a, b, w in data["words"]]
    except (OSError, ValueError, TypeError):
        pass
    lyr = status.get("lyrics") or {}
    if (lyr.get("state") == "done" and lyr.get("source") == "auto" and lyr.get("language") == language
            and lyr.get("parent_stems_version") == status.get("stems_version")):
        try:
            words = _lyr_auto_words_from_doc(json.loads((song_dir / "lyrics.json").read_text(encoding="utf-8")))
            return words or None
        except (OSError, ValueError, TypeError):
            return None
    return None


def _lyr_save_auto_words(song_dir: pathlib.Path, status: dict, language: str, words: list) -> None:
    path = song_dir / "lyrics_auto.json"
    tmp = path.with_name("lyrics_auto.json.tmp")
    payload = {"stems_version": status.get("stems_version"), "language": language,
               "words": [[round(a, 2), round(b, 2), w] for a, b, w in words]}
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def _lyr_transcribe_words(model, audio, active, language: str) -> list:
    """Otomatik çıkarma (auto moduyla AYNI ayar) + enerji maskesi; kelime listesi [(s, e, w)]."""
    result = model.transcribe(audio, language=language, vad=False, word_timestamps=True,
                              condition_on_previous_text=False, regroup=True)
    lines = _lyr_mask_filter(_lyr_segments(result), active)
    return [(w["s"], w["e"], w["w"]) for line in lines for w in (line.get("words") or [])]


def _lyr_restore(song_id: str, previous, message: str, kind: str):
    """İş başarısız / sonuçsuz: ÖNCEKİ tamam kayıt varsa geri koy (dosyası hâlâ yerinde)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if previous and previous.get("state") == "done":
        record = dict(previous, last_attempt={"state": kind, "message": message[:300],
                                              "finished_at": stamp})
    else:
        record = {"state": kind, "message": message[:300], "finished_at": stamp}
    _write_status(song_id, lyrics=record)


@app.function(
    image=lyrics_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=1800,
    max_containers=1,       # min_containers YOK: boştayken maliyet sıfır
)
def extract_lyrics(song_id: str, mode: str = "auto", language: str = "auto",
                   text: str = "", manual: list = None) -> dict:
    """SW vokal stem'inden sözleri çıkarır (auto) ya da verilen metni hizalar (pasted).

    "Vokal yok" kapısı BURADA DEĞİL, API'de (CPU): GPU konteyneri açılmadan elenir.
    Hata olursa ÖNCEKİ tamam kayıt geri konur (yoksa state=error).
    """
    volume.reload()
    previous = None
    with contextlib.suppress(Exception):
        previous = (json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8"))
                    .get("lyrics") or {}).get("previous")
    try:
        return _extract_lyrics_impl(song_id, mode, language, text, previous, manual or [])
    except Exception as error:
        with contextlib.suppress(Exception):
            volume.reload()
            _lyr_restore(song_id, previous, f"{type(error).__name__}: {error}", "error")
        raise


def _lyr_pasted_lines(model, audio, active, duration, lang, texts, song_dir, status, manual_map,
                      save=True, method="anchored") -> tuple:
    """Yapıştırılan metni sese hizalar. Dönen: (satırlar, bilgi). Önce eşleştir + çapa pencereleri;
    eşleşme kullanılamıyorsa (ya da method="global") eski tek hizalama."""
    note = None
    if method == "anchored":
        try:
            words = _lyr_load_auto_words(song_dir, status, lang)
            reused = words is not None
            if words is None:
                words = _lyr_transcribe_words(model, audio, active, lang)
                if save and words:
                    with contextlib.suppress(Exception):
                        _lyr_save_auto_words(song_dir, status, lang, words)
            lines, info = _lyr_run_anchored(model, audio, active, duration, lang, texts, words, manual_map)
            info["auto_reused"] = reused
            return lines, info
        except Exception as error:
            note = f"{type(error).__name__}: {error}"[:160]
            print(f"[soz] capali yol kullanilamadi, global hizalamaya dusuluyor: {note}")
    lines = _lyr_run_global(model, audio, lang, texts)
    if len(lines) == len(texts):
        for line, text in zip(lines, texts):
            line["text"] = text
    return lines, {"method": "global", "fallback": note, "low_match": bool(note and "eslesme orani" in note)}


def _extract_lyrics_impl(song_id: str, mode: str, language: str, text: str, previous,
                         manual=None) -> dict:
    import stable_whisper

    started = time.time()
    if mode not in LYRICS_MODES:
        raise ValueError(f"bilinmeyen mod: {mode!r}")
    if language != "auto" and language not in LYRICS_LANGS:
        raise ValueError(f"bilinmeyen dil: {language!r}")
    status = json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8"))
    vocal_path = _song_dir(song_id) / "master" / "vocals.flac"
    if not vocal_path.is_file():
        raise FileNotFoundError(f"master/vocals.flac yok: {song_id}")
    pasted_lines = []
    if mode == "pasted":
        pasted_lines, problem = _lyr_check_text(text)
        if problem:
            raise ValueError(problem)

    audio = _decode_mono(vocal_path, LYRICS_RATE)
    duration = len(audio) / LYRICS_RATE
    active, threshold, _p95 = _lyr_activity(_lyr_levels(audio))
    silences = _lyr_silences(active)

    load_started = time.time()
    model = stable_whisper.load_faster_whisper(LYRICS_MODEL, device="cuda", compute_type="float16")
    load_seconds = round(time.time() - load_started, 1)

    detect = None
    lang = language
    if language == "auto":
        lang, detect = _lyr_detect_language(model, audio)
        if lang is None:
            raise RuntimeError("dil algilanamadi (tr/en/ja olasiligi sifir)")

    work_started = time.time()
    match_info = None
    song_dir = _song_dir(song_id)
    if mode == "auto":
        result = model.transcribe(audio, language=lang, vad=False, word_timestamps=True,
                                  condition_on_previous_text=False, regroup=True)
        raw = _lyr_segments(result)
        lines = _lyr_clean_lines(_lyr_mask_filter(raw, active))
        dropped = len(raw) - len(lines)
        with contextlib.suppress(Exception):        # yapıştır-hizala bunu yeniden kullanır
            _lyr_save_auto_words(song_dir, status, lang, [
                (w["s"], w["e"], w["w"]) for line in lines for w in (line.get("words") or [])])
    else:
        manual_map = {int(item["i"]): float(item["t"]) for item in (manual or [])}
        lines, match_info = _lyr_pasted_lines(model, audio, active, duration, lang, pasted_lines,
                                              song_dir, status, manual_map)     # satır süzülmez
        dropped = 0
    work_seconds = round(time.time() - work_started, 1)

    if not lines:
        _lyr_restore(song_id, previous, "Bu sesten soz cikarilamadi", "no_lyrics")
        return _assert_plain({"song_id": song_id, "state": "no_lyrics", "mode": mode,
                              "language": lang})

    quality = _lyr_quality(lines, silences)
    mismatch = mode == "pasted" and _lyr_mismatch(quality)
    if mode == "pasted" and match_info:
        if match_info.get("method") == "anchored":
            mismatch = mismatch or match_info["match_ratio"] < LYRICS_MISMATCH_MATCH_RATIO
        else:
            mismatch = mismatch or bool(match_info.get("low_match"))
    warning = "text_mismatch" if mismatch else None
    version = int(time.time())
    doc = _lyr_doc(mode, lang, lines, duration, version)
    path = _song_dir(song_id) / "lyrics.json"
    tmp = path.with_name("lyrics.json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)                      # önce dosya (atomik), SONRA status
    wall = round(time.time() - started, 1)
    record = {
        "state": "done", "source": mode, "language": lang, "language_requested": language,
        "language_detect": detect, "version": version,
        "lines": len(doc["lines"]), "words": sum(len(x["w"]) for x in doc["lines"]),
        "dropped_lines": dropped, "warning": warning, "quality": quality, "match": match_info,
        "parent_stems_version": status.get("stems_version"),
        "parent_pipeline": status.get("pipeline"),
        "model": {"name": f"faster-whisper {LYRICS_MODEL} + stable-ts", "vad": False,
                  "input": "stem"},
        "thresholds": {"silent_dbfs": LYRICS_SILENT_DBFS, "activity_dbfs": round(threshold, 1),
                       "mismatch_prob": LYRICS_MISMATCH_PROB},
        "seconds": {"model_load": load_seconds, "work": work_seconds, "wall": wall},
        "cost_usd_estimate": round(wall * LYRICS_USD_PER_SECOND, 4),
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _write_status(song_id, lyrics=record)
    print(f"[soz] {mode} {lang}: {record['lines']} satir, {record['words']} kelime, "
          f"{wall} sn, uyari={warning}")
    return _assert_plain({"song_id": song_id, "state": "done", "mode": mode, "language": lang,
                          "lines": record["lines"], "warning": warning, "wall_s": wall})


@app.function(image=lyrics_image, gpu="T4", volumes={DATA_DIR: volume}, timeout=1800, max_containers=1)
def lyrics_probe(song_id: str, texts: list, method: str = "anchored", manual: dict = None,
                 language: str = "auto") -> dict:
    """Üretimdeki yapıştır-hizala yolunu YAZMADAN çalıştırır (regresyon ölçümü). Volume'a hiçbir şey yazmaz.

    Dönen: satır başına [başlangıç, bitiş, güven], bilgi (eşleşme oranı, çapa/düşük güven satırları,
    metinde olmayan bölümler) ve süre. method: "anchored" (yeni) | "global" (eski).
    """
    import stable_whisper

    volume.reload()
    song_dir = _song_dir(song_id)
    status = json.loads((song_dir / "status.json").read_text(encoding="utf-8"))
    audio = _decode_mono(song_dir / "master" / "vocals.flac", LYRICS_RATE)
    duration = len(audio) / LYRICS_RATE
    active, _threshold, _p95 = _lyr_activity(_lyr_levels(audio))
    model = stable_whisper.load_faster_whisper(LYRICS_MODEL, device="cuda", compute_type="float16")
    lang = language
    if language == "auto":
        lang, _ = _lyr_detect_language(model, audio)
    started = time.time()
    lines, info = _lyr_pasted_lines(model, audio, active, duration, lang, list(texts), song_dir, status,
                                    {int(k): float(v) for k, v in (manual or {}).items()},
                                    save=False, method=method)
    return _assert_plain({
        "language": lang, "duration": round(duration, 1), "seconds": round(time.time() - started, 1),
        "lines": [[round(float(l["start"]), 2), round(float(l["end"]), 2), 0 if l.get("c") == 0 else 1]
                  for l in lines],
        "info": info,
    })


@app.local_entrypoint()
def lyrics_regress(song: str = "Zeus", ref: str = "zeus.txt", method: str = "anchored", drop: str = "",
                   language: str = "auto", out: str = ""):
    """Regresyon ölçümü (yazmaz): backend/lyrics_ref/<ref> (ya da lyrics_out/<ref> JSON'u) metnini
    hizalar. drop="a-b": o satır aralığını (1'den, uçlar dahil) metinden çıkarır (nakarat tekrarı
    eksik senaryosu). Çıktı lyrics_out/probe_<out>.json (gitignore'lı)."""
    here = pathlib.Path(__file__).resolve().parent
    path = here / "lyrics_ref" / ref
    if ref.endswith(".json"):
        path = here / "lyrics_out" / ref
        texts = [line["text"] for line in json.loads(path.read_text(encoding="utf-8"))["lyrics"]["lines"]]
    else:
        texts = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    kept = list(range(len(texts)))
    if drop:
        a, b = (int(x) for x in drop.split("-"))
        kept = [i for i in kept if not (a - 1 <= i <= b - 1)]
    song_id, _title = _resolve_title_cli(song)
    result = lyrics_probe.remote(song_id, [texts[i] for i in kept], method, None, language)
    result["kept"] = kept
    target = here / "lyrics_out" / f"probe_{out or song.split()[0]}_{method}{'_drop' if drop else ''}.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    info = result["info"]
    print(f"{song} [{method}{' drop ' + drop if drop else ''}] {len(kept)} satir, {result['seconds']} sn | "
          f"yontem {info.get('method')} eslesme {info.get('match_ratio')} capa {info.get('anchor_lines')} "
          f"dusuk guven {len(info.get('low_confidence_lines') or [])} bosluk {info.get('gaps')} -> {target.name}")


@app.function(
    image=separate_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    # Hi-Fi'da Roformer demucs'un ÜSTÜNE geliyor. Ölçülen: 110 sn'lik şarkı
    # 95 sn duvar saati; 10 dakikalık şarkı ~5-6 dk bekleniyor. 1800 sn pay
    # bırakıyor, ilk gerçek koşumda ölçülecek.
    timeout=1800,
    max_containers=1,  # min_containers YOK: boştayken maliyet sıfır
)
def separate(song_id: str, quality: str = DEFAULT_QUALITY,
             skip_analyze: bool = False) -> dict:
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    started = time.time()
    volume.reload()
    song_dir = _song_dir(song_id)
    input_path = _find_input(song_id)

    quality = quality if quality in QUALITIES else DEFAULT_QUALITY

    try:
        # Ana stem'ler değişiyor: alt parçaların toplamı artık tutmaz, bayat
        # bırakılmaz (Aşama 10). Yeni şarkıda no-op.
        _sub_drop(song_id)
        _write_status(song_id, state="separating", progress=5, error=None,
                      quality=quality)

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
        decode_started = time.time()
        audio = _decode_pcm(input_path, samplerate, channels)
        decode_seconds = round(time.time() - decode_started, 2)
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

        # --- Hi-Fi: önce vokal, sonra enstrümantal demucs'a ---------------
        # Deney sonucu (PLAN.md): vokalde BS-Roformer SW, kalan beş stemde
        # htdemucs_6s iyi. Çıkarma tanım gereği tam: enstrümantal =
        # karışım - vokal, yani Roformer aşaması toplama hata EKLEMİYOR.
        hifi_stems = None
        hifi_seconds = 0.0
        hifi_load_seconds = 0.0
        if quality == "hifi":
            hifi_stems, hifi_seconds, hifi_load_seconds = _hifi_stems(
                audio, samplerate, channels
            )
            instrumental = audio
            for name in HIFI_SW_STEMS:
                instrumental = instrumental - hifi_stems[name]
            wav = torch.from_numpy(instrumental)
            _write_status(song_id, state="separating", progress=35)
            print(f"[hifi] enstrumantal (karisim - {' - '.join(HIFI_SW_STEMS)}) "
                  f"hazir, demucs'a veriliyor")

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

        # Normalizasyonu geri al.
        #
        # ref_mean YALNIZCA BİR KEZ ekleniyor. Önceki hali (ve upstream
        # demucs'un separate.py'si) `stems * std + mean` yapıyor, bu da
        # yayınlama (broadcast) yüzünden ref_mean'i ALTI kaynağın hepsine
        # ekliyor; stem toplamı girdiden 5*ref_mean kadar sapıyor. Gerçek
        # müzikte ref_mean ~1e-5 olduğu için kimse fark etmemiş ama doğrusu
        # bu: mean tek bir kaynağa gidiyor.
        stems = stems * ref_std
        stems[0] = stems[0] + ref_mean

        hifi_residues = {}
        if quality == "hifi":
            # Demucs enstrümantal (karışım - vokal - piyano - davul) üzerinde
            # çalıştı; vokal/piyano/davul çıkışları SW'nin KAÇIRDIĞI artık.
            # Toplamak çift sayma, atmak toplamı bozmak olurdu: other'a
            # ekleniyor, gerçek stem'ler SW'ninki (_hifi_v2_compose).
            hifi_residues = _hifi_v2_compose(
                stems, sources,
                {name: torch.from_numpy(hifi_stems[name]) for name in HIFI_SW_STEMS},
            )
            for name, value in hifi_residues.items():
                print(f"[hifi] demucs {name} artigi rms={value:.6f} -> other'a; "
                      f"{name} stem'i Roformer ciktisiyla degistirildi")

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
        flac_seconds = 0.0
        aac_seconds = 0.0
        commit_seconds = 0.0
        for index, name in enumerate(sources):
            stem = stems[index] / clip_scale

            flac_path = master_dir / f"{name}.flac"
            step = time.time()
            sf.write(
                str(flac_path), stem.T.numpy(), samplerate,
                subtype=FLAC_SUBTYPE, format="FLAC",
            )
            flac_seconds += time.time() - step

            m4a_path = stems_dir / f"{name}.m4a"
            step = time.time()
            _encode_stem_m4a(flac_path, m4a_path, channels)
            aac_seconds += time.time() - step
            written.append(name)
            print(f"[yaz] {name}: tepe {raw_peaks[name]:.4f} -> flac + m4a")
            # İlerleme bütçesi: ayrıştırma 0-70, analiz 70-100.
            step = time.time()
            _write_status(
                song_id, progress=20 + int(50 * len(written) / len(sources))
            )
            commit_seconds += time.time() - step

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
            "quality": quality,
            "hifi_seconds": round(hifi_seconds, 2),
            "hifi_load_seconds": round(hifi_load_seconds, 2),
            "pipeline": PIPELINE_HIFI if quality == "hifi" else PIPELINE_STANDARD,
            "hifi_residue_rms": {k: round(v, 6) for k, v in hifi_residues.items()},
            "total_seconds": round(time.time() - started, 2),
            # Encode optimizasyonu kararı için ölçüm: GPU konteynerinde
            # geçen sürenin nereye gittiği. CPU'ya taşınabilir olan yalnızca
            # aac_seconds; flac ve commit tensörlerin yanında kalmak zorunda.
            "timing": {
                "decode": round(decode_seconds, 2),
                "apply_model": gpu_seconds,
                "flac_write": round(flac_seconds, 2),
                "aac_encode": round(aac_seconds, 2),
                "status_commits": round(commit_seconds, 2),
            },
        }
        # --- beat/downbeat (eğitilmiş model, ÖZGÜN MIX üzerinde) ----------
        # Aynı GPU konteynerinde: ayrı bir T4 konteyneri açmaktan ucuz.
        #
        # Hata yakalanıyor ve yükseltilmiyor: ayrıştırma bu noktada bitti ve
        # pahalı olan oydu. Beat takibi patlarsa stem'leri çöpe atmak yerine
        # beats.json'suz devam ediyoruz; analyze librosa yedeğine düşer.
        # Kesin doğrulama isteyen yol ayrı: track_beats / beats_only.
        try:
            beats_data = _track_beats_inline(song_id, device="cuda")
            result["beat_count"] = len(beats_data["beats"])
            result["downbeat_count"] = len(beats_data["downbeats"])
            result["beat_bpm"] = beats_data["bpm"]
            result["beat_seconds"] = beats_data["seconds"]
            result["beat_error"] = None
        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            print(f"[beat_this] BASARISIZ, librosa yedegine dusulecek: {message}")
            result["beat_error"] = message

        # stems_version ÖNBELLEK İÇİN ŞART: telefon stem'leri
        # stems/<id>/<ad>.m4a anahtarıyla saklıyor. Yeniden işlemede
        # dosyalar değişiyor ama anahtar aynı kalsaydı cihaz eski sesi
        # çalmaya devam ederdi - üstelik sessizce.
        _write_status(
            song_id,
            state="done" if skip_analyze else "analyzing",
            progress=100 if skip_analyze else 70,
            error=None, stems=written,
            # samplerate = modelin ve FLAC asılların hızı (44.1 kHz).
            # stem_* alanları telefona giden m4a'ları anlatıyor.
            samplerate=samplerate, channels=channels,
            stem_samplerate=STEM_SAMPLE_RATE, stem_bitrate=AAC_BITRATE,
            gpu_seconds=gpu_seconds,
            timing=result["timing"], quality=quality,
            pipeline=result["pipeline"],
            stems_version=int(time.time()),
        )
        # Analizi ayrı bir CPU konteynerine devret: T4 burada biter, analiz
        # süresi GPU olarak faturalanmaz.
        if skip_analyze:
            # Yeniden işleme: akor ve vuruş ORİJİNALDEN kalıyor, yeniden
            # hesaplanmıyor. Karşılaştırmak istediğimiz ayrıştırma; ayrıca
            # ızgaranın değişmesi akor şeridini kaydırırdı.
            result["analyze_call_id"] = None
            print("[analyze] atlandi (yeniden isleme)")
        else:
            call = analyze.spawn(song_id)
            result["analyze_call_id"] = str(call.object_id)
            print(f"[analyze] spawn edildi: {result['analyze_call_id']}")
        return _assert_plain(result)

    except Exception as exc:
        _write_status(song_id, state="error", error=f"{type(exc).__name__}: {exc}")
        raise


# --------------------------------------------------------------------------
# Akor analizi - saf fonksiyonlar
#
# Bunlar Modal'a bağlı değil; tests/test_chords_local.py bunları sentetik
# sesle yerelde çağırıyor. numpy/librosa importları fonksiyon içinde: bu modül
# light_image konteynerlerinde de import ediliyor ve orada numpy yok.
# --------------------------------------------------------------------------


def _chord_states():
    """25 durum döndürür: 12 majör + 12 minör + N.

    (states, templates) — states[k] = (kök pitch class, minör mü) ya da N için
    None. templates (25, 12); ilk 24 satır L2-normalize triad şablonu.

    N satırı BİLEREK sıfır: N'in spektral şablonu yok. Düz (uniform) bir
    şablon denendi ve işe yaramadı — chroma_cqt çıktısı hiçbir zaman seyrek
    olmadığı için (gürültü tabanı ~0.28) düz şablonun kosinüsü en iyi triad'ı
    neredeyse her beat'te geçiyordu (0.736 vs 0.723) ve her şey N çıkıyordu.
    N artık _chord_path içinde sabit bir skor (N_SCORE) + düşük enerji eşiği
    ile ele alınıyor: "akor yok" bir spektral şekil değil, sinyal yokluğu ya
    da hiçbir triad'ın yeterince iyi oturmaması demek.
    """
    import numpy as np

    states = []
    rows = []
    for is_minor, intervals in ((False, (0, 4, 7)), (True, (0, 3, 7))):
        for root in range(12):
            vector = np.zeros(12, dtype=float)
            for interval in intervals:
                vector[(root + interval) % 12] = 1.0
            rows.append(vector / np.linalg.norm(vector))
            states.append((root, is_minor))

    rows.append(np.zeros(12, dtype=float))  # N: şablonu yok
    states.append(None)

    return states, np.vstack(rows)


def _chord_tones(root: int, is_minor: bool):
    """Triad'ın pitch class'ları: kök, üçlü, beşli."""
    return (root % 12, (root + (3 if is_minor else 4)) % 12, (root + 7) % 12)


def _diatonic_states(tonic: int, is_minor: bool):
    """Tonun diyatonik triadları.

    Minörde doğal minörün yanına armonik minörün V MAJÖR akoru da eklendi
    (Fm'de C majör) - popüler müzikte dominant çoğunlukla majör çalınıyor.
    """
    if is_minor:
        degrees = (
            (0, True),    # i    Fm
            (3, False),   # III  Ab
            (5, True),    # iv   Bbm
            (7, True),    # v    Cm
            (8, False),   # VI   Db
            (10, False),  # VII  Eb
            (7, False),   # V    C majör (armonik minör)
        )
    else:
        degrees = (
            (0, False),   # I
            (2, True),    # ii
            (4, True),    # iii
            (5, False),   # IV
            (7, False),   # V
            (9, True),    # vi
        )
    return {((tonic + semitones) % 12, minor) for semitones, minor in degrees}


# Beşliler çemberi konumu (majör tonikler). Negatif = bemollü ton.
_CIRCLE_OF_FIFTHS = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6,
                     1: -5, 8: -4, 3: -3, 10: -2, 5: -1}


def _key_uses_flats(tonic: int, is_minor: bool) -> bool:
    """Ton bemollü mü? Minörde ilgili majöre bakılır (Fm -> Ab -> bemol)."""
    relative_major = (tonic + 3) % 12 if is_minor else tonic
    return _CIRCLE_OF_FIFTHS[relative_major] < 0


def _key_name(tonic: int, is_minor: bool) -> str:
    names = FLAT_NAMES if _key_uses_flats(tonic, is_minor) else NOTE_NAMES
    return f"{names[tonic]}{'m' if is_minor else ''}"


def _detect_key(states_per_beat, durations):
    """Süre ağırlıklı diyatonik kapsamadan tonu tahmin eder.

    Skor = (diyatonik akorlarda geçen süre) + (tonik akorunda geçen süre).
    Tonik terimi şart: Fm ile ilgili majörü Ab'nin diyatonik kümeleri
    neredeyse aynı, onları yalnızca tonik akorunun süresi ayırıyor.
    """
    best = None
    for tonic in range(12):
        for is_minor in (False, True):
            diatonic = _diatonic_states(tonic, is_minor)
            covered = 0.0
            tonic_duration = 0.0
            for state, duration in zip(states_per_beat, durations):
                if state is None:
                    continue
                if state in diatonic:
                    covered += duration
                if state == (tonic, is_minor):
                    tonic_duration += duration
            score = covered + tonic_duration
            if best is None or score > best[0]:
                best = (score, tonic, is_minor)
    return best[1], best[2]


def _chord_label(state, names, bass_pitch=None) -> str:
    """Akor etiketi; bas notası kök değil ama akor tonuysa slash akor."""
    if state is None:
        return NO_CHORD
    root, is_minor = state
    base = f"{names[root]}{'m' if is_minor else ''}"
    if bass_pitch is None or bass_pitch == root:
        return base
    if bass_pitch in _chord_tones(root, is_minor):
        return f"{base}/{names[bass_pitch]}"
    # Bas akor tonu değil (geçiş notası, gürültü): slash yazmıyoruz.
    return base


def _beat_bounds(beat_frames, n_frames: int):
    """Beat frame'lerini sync() için artan sınır dizisine çevirir.

    Sonuç len(bounds)-1 segment verir: [beat i, beat i+1), sonuncusu ses sonuna.
    """
    import numpy as np

    bounds = sorted({int(f) for f in beat_frames if 0 <= int(f) < n_frames})
    if not bounds or bounds[-1] != n_frames:
        bounds.append(n_frames)
    return np.array(bounds, dtype=int)


def _sync_median(feature, bounds):
    import librosa
    import numpy as np

    return librosa.util.sync(feature, bounds, aggregate=np.median, pad=False)


def _bpm_from_beats(beat_times) -> float:
    """Vuruş zamanlarının vuruş indeksine DOĞRUSAL REGRESYONundan tempo.

    Medyan aralık yuvarlanmış veriyle çalışmıyor. beat_this çıktısını kendi
    50 fps (20 ms) ızgarasına oturtuyor, yani aralıklar yalnızca 0.46 / 0.48
    gibi ayrık değerler alıyor ve medyan bpm'i 60/(k*0.02) kümesine
    hapsediyor: 120.0, 125.0, 130.43... Gerçek 127 BPM'de medyan 0.46'ya
    düşüp 130.43 veriyordu. Regresyonun eğimi periyodun kendisi olduğu için
    ızgara gürültüsü tüm parça boyunca ortalanıyor.
    """
    import numpy as np

    times = np.asarray(beat_times, dtype=float)
    if times.size < 2:
        return 0.0
    gaps = np.diff(times)
    positive = gaps[gaps > 0]
    if positive.size == 0:
        return 0.0
    rough_period = float(np.median(positive))
    if rough_period <= 0:
        return 0.0

    # Vuruş indeksi: her aralığı kaba periyoda bölerek. Atlanmış bir vuruş
    # varsa adım 2 olur, indeks kaymaz.
    indices = [0.0]
    for gap in gaps:
        step = max(1, int(round(float(gap) / rough_period)))
        indices.append(indices[-1] + step)

    slope = float(np.polyfit(np.asarray(indices), times, 1)[0])
    if slope <= 0:
        return 0.0
    return 60.0 / slope


def _half_bar_starts(downbeat_indices, beat_count: int,
                     beats_per_bar: int = BEATS_PER_BAR):
    """Akor değişimine izin verilen beat indeksleri: 1. ve 3. vuruşlar.

    Bu şarkıda akorlar en sık yarım ölçüde değişiyor; viterbi'yi beat yerine
    yarım ölçü segmentlerinde çalıştırmak ölçü içinde 3 akor çıkmasını
    yapısal olarak engelliyor.
    """
    starts = {0}
    half = beats_per_bar // 2
    for index in downbeat_indices:
        if 0 <= index < beat_count:
            starts.add(int(index))
            if index + half < beat_count:
                starts.add(int(index) + half)
    return sorted(starts)


def _snap_to_beats(times, beat_times, end_time: float):
    """Her downbeat'i en yakın beat zamanına oturtur.

    Böylece downbeats her zaman beats'in alt kümesi kalıyor - hem çizelge hem
    ön yüz buna güveniyor.
    """
    import numpy as np

    grid = np.asarray(beat_times, dtype=float)
    if grid.size == 0:
        return []
    snapped = []
    for value in times:
        value = float(value)
        if value < 0.0 or value >= end_time:
            continue
        snapped.append(round(float(grid[int(np.argmin(np.abs(grid - value)))]), 3))
    # Aynı beat'e oturan birden fazla downbeat olabilir; tekille ve sırala.
    return sorted(set(snapped))


def _chord_path(
    chroma_beats,
    bass_chroma_beats,
    beat_energy,
    *,
    root_weight: float = ROOT_WEIGHT,
    self_transition: float = SELF_TRANSITION,
    sharpen: float = SHARPEN,
    n_energy_ratio: float = N_ENERGY_RATIO,
    n_score: float = N_SCORE,
    diatonic=None,
    key_weight: float = 0.0,
):
    """Beat başına akor durumları (viterbi ile yumuşatılmış).

    Dönüş: her beat için (kök, minör mü) demeti ya da N için None.
    """
    import librosa
    import numpy as np

    states, templates = _chord_states()
    n_index = states.index(None)

    # Chroma'nın gürültü tabanını kaldır: her beat'te medyanı çıkar, negatifi
    # kes. chroma_cqt her bin'e enerji yaydığı için bu yapılmazsa triad
    # şablonları birbirinden ayrışamıyor.
    cleaned = np.asarray(chroma_beats, dtype=float)
    cleaned = np.clip(cleaned - np.median(cleaned, axis=0, keepdims=True), 0.0, None)

    # Kosinüs benzerliği: chroma'yı birim uzunluğa getir, şablonlar zaten birim.
    norms = np.maximum(np.linalg.norm(cleaned, axis=0, keepdims=True), 1e-9)
    scores = templates @ (cleaned / norms)  # (25, T); N satırı 0

    # Kök notası bonusu: bas chroma'da akorun kökünün ağırlığı.
    bass_l1 = bass_chroma_beats / np.maximum(
        bass_chroma_beats.sum(axis=0, keepdims=True), 1e-9
    )
    if root_weight:
        bonus = np.zeros_like(scores)
        for index, state in enumerate(states):
            if state is not None:
                bonus[index] = bass_l1[state[0]]
        scores = scores + root_weight * bonus

    # Tona diyatonik akorlara küçük sabit bonus. Yakın skorları çevirir,
    # net bir üçlüyü çevirmez.
    if diatonic and key_weight:
        for index, state in enumerate(states):
            if state is not None and state in diatonic:
                scores[index] += key_weight

    # N'in skoru sabit: hiçbir triad bu eşiği geçemiyorsa "akor yok".
    scores[n_index] = n_score

    # Düşük enerjili beat'ler doğrudan N'e.
    if beat_energy is not None and np.size(beat_energy):
        reference = float(np.percentile(beat_energy, 90))
        quiet = np.asarray(beat_energy) < n_energy_ratio * max(reference, 1e-12)
        if quiet.any():
            scores[:, quiet] = 0.0
            scores[n_index, quiet] = 1.0

    # Benzerlik -> olasılık: negatifleri kes, keskinleştir, kolonları normalize et.
    prob = np.clip(scores, 0.0, None) ** sharpen + 1e-12
    prob = prob / prob.sum(axis=0, keepdims=True)

    transition = librosa.sequence.transition_loop(len(states), self_transition)
    path = librosa.sequence.viterbi(prob, transition)
    return [states[int(index)] for index in path]


def _choose_downbeat_phase(beat_labels, bass_energy, beats_per_bar: int = BEATS_PER_BAR):
    """4 fazdan hangisinin ölçü başı olduğunu seçer.

    Birincil ölçüt: akor değişimlerinin ölçü başına düşme sayısı (en çok olan
    kazanır). Eşitlikte bas enerjisi karar verir.
    """
    import numpy as np

    changes = [
        i for i in range(1, len(beat_labels)) if beat_labels[i] != beat_labels[i - 1]
    ]
    energy = None if bass_energy is None else np.asarray(bass_energy, dtype=float)

    best_phase = 0
    best_key = None
    for phase in range(beats_per_bar):
        on_bar = [i for i in range(len(beat_labels)) if (i - phase) % beats_per_bar == 0]
        change_hits = sum(1 for i in changes if (i - phase) % beats_per_bar == 0)
        if energy is not None and energy.size and on_bar:
            valid = [i for i in on_bar if i < energy.size]
            mean_energy = float(np.mean(energy[valid])) if valid else 0.0
        else:
            mean_energy = 0.0
        key = (change_hits, mean_energy)
        if best_key is None or key > best_key:
            best_key = key
            best_phase = phase
    return best_phase


def _merge_chords(beat_labels, beat_times, end_time: float):
    """Ardışık aynı akorları tek aralığa birleştirir."""
    chords = []
    for index, label in enumerate(beat_labels):
        start = float(beat_times[index])
        if index + 1 < len(beat_times):
            end = float(beat_times[index + 1])
        else:
            end = float(end_time)
        if end <= start:
            continue
        if chords and chords[-1]["label"] == label:
            chords[-1]["end"] = round(end, 3)
        else:
            chords.append(
                {"start": round(start, 3), "end": round(end, 3), "label": label}
            )
    return chords


def analyze_core(
    quality,
    bass,
    sr: int,
    *,
    beats=None,
    downbeats=None,
    root_weight: float = ROOT_WEIGHT,
    self_transition: float = SELF_TRANSITION,
    sharpen: float = SHARPEN,
    n_energy_ratio: float = N_ENERGY_RATIO,
    n_score: float = N_SCORE,
    key_weight: float = KEY_WEIGHT,
    slash_penalty: float = SLASH_PENALTY,
) -> dict:
    """chords.json içeriğini üretir.

    quality: piano+guitar+other toplamı (BASS HARİÇ) - akor kalitesini bu
             belirler, böylece evrik akorlarda bas kökü yanlış göstermiyor.
    bass:    bass stem'i - slash akorun bas notası ve downbeat yedeği için.
    beats/downbeats: beat_this'ten gelen zamanlar (saniye). None ise librosa
             beat_track + kural tabanlı downbeat yedeğine düşülür.
    """
    import librosa
    import numpy as np

    if sr != ANALYSIS_SR:
        quality = librosa.resample(quality, orig_sr=sr, target_sr=ANALYSIS_SR)
        bass = librosa.resample(bass, orig_sr=sr, target_sr=ANALYSIS_SR)
        sr = ANALYSIS_SR

    length = min(quality.shape[-1], bass.shape[-1])
    quality = np.ascontiguousarray(quality[:length], dtype=np.float32)
    bass = np.ascontiguousarray(bass[:length], dtype=np.float32)
    mix = quality + bass  # enerji kapısı ve librosa yedeği için tam karışım
    end_time = float(length) / sr

    # --- beat'ler -----------------------------------------------------------
    raw_beat_times = None
    if beats:
        raw_beat_times = np.asarray(
            [float(t) for t in beats if 0.0 <= float(t) < end_time], dtype=float
        )
        beats_source = "beat_this"
        beat_frames = librosa.time_to_frames(
            raw_beat_times, sr=sr, hop_length=HOP_LENGTH
        )
    else:
        tempo, beat_frames = librosa.beat.beat_track(
            y=mix, sr=sr, hop_length=HOP_LENGTH
        )
        beats_source = "librosa"

    if len(beat_frames) < 2:
        raise ValueError("Beat bulunamadi; kayit cok kisa veya ritmi belirsiz.")

    # --- öznitelikler -------------------------------------------------------
    chroma = librosa.feature.chroma_cqt(y=quality, sr=sr, hop_length=HOP_LENGTH)
    bass_chroma = librosa.feature.chroma_cqt(y=bass, sr=sr, hop_length=HOP_LENGTH)
    rms = librosa.feature.rms(y=mix, hop_length=HOP_LENGTH)[0]
    bass_rms = librosa.feature.rms(y=bass, hop_length=HOP_LENGTH)[0]

    n_frames = min(chroma.shape[1], bass_chroma.shape[1], rms.size, bass_rms.size)
    bounds = _beat_bounds(beat_frames, n_frames)
    if bounds.size < 2:
        raise ValueError("Beat sinirlari olusturulamadi.")

    beat_times = librosa.frames_to_time(bounds[:-1], sr=sr, hop_length=HOP_LENGTH)

    # bpm HAM beat zamanlarından. beat_times frame ızgarasına (23,2 ms)
    # yuvarlandığı için medyan aralık en yakın frame sayısına snap ediyordu:
    # 127 BPM'de beat 20,35 frame -> medyan 20 frame (0,4644 sn) -> 129,2 bpm.
    bpm = _bpm_from_beats(
        raw_beat_times if raw_beat_times is not None and raw_beat_times.size >= 2
        else beat_times
    )

    common = dict(
        root_weight=root_weight, self_transition=self_transition,
        sharpen=sharpen, n_energy_ratio=n_energy_ratio, n_score=n_score,
    )

    def sync_all(segment_bounds):
        return (
            _sync_median(chroma[:, :n_frames], segment_bounds),
            _sync_median(bass_chroma[:, :n_frames], segment_bounds),
            _sync_median(rms[np.newaxis, :n_frames], segment_bounds)[0],
            _sync_median(bass_rms[np.newaxis, :n_frames], segment_bounds)[0],
        )

    def detect(chroma_seg, bass_chroma_seg, energy_seg, seg_times):
        """İki geçiş: ton bonusu olmadan ton tahmini, sonra bonusla akorlar."""
        first_pass = _chord_path(chroma_seg, bass_chroma_seg, energy_seg, **common)
        seg_durations = [
            float(seg_times[i + 1] - seg_times[i]) if i + 1 < len(seg_times)
            else max(end_time - float(seg_times[i]), 0.0)
            for i in range(len(seg_times))
        ]
        tonic_, minor_ = _detect_key(first_pass, seg_durations)
        states_ = _chord_path(
            chroma_seg, bass_chroma_seg, energy_seg,
            diatonic=_diatonic_states(tonic_, minor_), key_weight=key_weight,
            **common
        )
        return states_, tonic_, minor_

    beat_chroma, beat_bass_chroma, beat_energy, bass_energy = sync_all(bounds)

    # --- downbeat'ler -------------------------------------------------------
    # Yarım ölçü segmentasyonu downbeat'leri gerektiriyor, kural tabanlı
    # downbeat ise etiketleri gerektiriyor. beat_this downbeat verdiyse
    # döngü yok; vermediyse beat düzeyinde bir ön geçişle etiket üretiyoruz.
    if downbeats:
        downbeat_times = _snap_to_beats(downbeats, beat_times, end_time)
        downbeat_source = "beat_this"
    else:
        pre_states, pre_tonic, pre_minor = detect(
            beat_chroma, beat_bass_chroma, beat_energy, beat_times
        )
        pre_names = FLAT_NAMES if _key_uses_flats(pre_tonic, pre_minor) else NOTE_NAMES
        pre_labels = [_chord_label(state, pre_names) for state in pre_states]
        phase = _choose_downbeat_phase(pre_labels, bass_energy)
        downbeat_times = [
            round(float(beat_times[i]), 3)
            for i in range(len(beat_times))
            if (i - phase) % BEATS_PER_BAR == 0
        ]
        downbeat_source = "kural"

    # --- segmentasyon: yarım ölçü (1. ve 3. vuruş) --------------------------
    # Akorlar bu tür parçalarda en sık yarım ölçüde değişiyor. Viterbi'yi
    # beat yerine yarım ölçü segmentlerinde çalıştırmak ölçü içinde 3 akor
    # çıkmasını yapısal olarak engelliyor.
    beat_index_of = {round(float(t), 3): i for i, t in enumerate(beat_times)}
    downbeat_indices = [
        beat_index_of[round(float(t), 3)]
        for t in downbeat_times
        if round(float(t), 3) in beat_index_of
    ]

    segment_mode = "beat"
    segment_bounds = bounds
    segment_times = beat_times
    if len(downbeat_indices) >= 2:
        starts = _half_bar_starts(downbeat_indices, len(beat_times))
        if len(starts) >= 2:
            segment_bounds = _beat_bounds([bounds[i] for i in starts], n_frames)
            segment_times = librosa.frames_to_time(
                segment_bounds[:-1], sr=sr, hop_length=HOP_LENGTH
            )
            segment_mode = "yarim-olcu"

    if segment_mode == "beat":
        chroma_seg, bass_chroma_seg, energy_seg, bass_energy_seg = (
            beat_chroma, beat_bass_chroma, beat_energy, bass_energy
        )
    else:
        chroma_seg, bass_chroma_seg, energy_seg, bass_energy_seg = sync_all(
            segment_bounds
        )

    states, tonic, key_is_minor = detect(
        chroma_seg, bass_chroma_seg, energy_seg, segment_times
    )

    # --- etiketleme: tonun yazımı + slash akorlar ---------------------------
    names = FLAT_NAMES if _key_uses_flats(tonic, key_is_minor) else NOTE_NAMES
    bass_floor = 0.0
    if bass_energy_seg.size:
        bass_floor = 0.15 * float(np.percentile(bass_energy_seg, 90))
    bass_pitches = np.argmax(bass_chroma_seg, axis=0)

    # Slash cezası: evrik akorlar kök konumundan çok daha nadir, o yüzden
    # slash için kanıt eşiği yüksek. Kanıt BAS chroma'sında aranıyor: bas
    # segment boyunca köke değil o notaya OTURMUŞ olmalı, yani bas
    # chroma'sında adayın ağırlığı kökün ağırlığını slash_penalty kadar
    # aşmalı.
    #
    # Üst stem'lerin chroma'sına bakmayı denedim, işe yaramadı: gerçek bir
    # evrimde üst stem'ler kökü hâlâ içeriyor (Ab/C'de piyano C-Eb-Ab çalar),
    # dolayısıyla ağırlık farkı ~0 ve gerçek evrimler de bastırılıyordu -
    # test_inversion_end_to_end bunu yakaladı. Geçici bas notaları ise yarım
    # ölçü medyanında zaten eriyor, bu yüzden bas kanıtı ayırt edici.
    bass_l1 = bass_chroma_seg / np.maximum(
        bass_chroma_seg.sum(axis=0, keepdims=True), 1e-9
    )

    labels = []
    for index, state in enumerate(states):
        pitch = None
        audible = index < bass_energy_seg.size and bass_energy_seg[index] >= bass_floor
        if audible and state is not None:
            candidate = int(bass_pitches[index])
            root = state[0]
            if candidate == root:
                pitch = candidate
            elif candidate in _chord_tones(*state):
                margin = float(bass_l1[candidate, index] - bass_l1[root, index])
                if margin > slash_penalty:
                    pitch = candidate
        labels.append(_chord_label(state, names, pitch))

    return {
        "bpm": round(bpm, 2),
        "beats": [round(float(t), 3) for t in beat_times],
        "downbeats": downbeat_times,
        "chords": _merge_chords(labels, segment_times, end_time),
        "key": _key_name(tonic, key_is_minor),
        "beats_source": beats_source,
        "downbeats_source": downbeat_source,
        "segment_mode": segment_mode,
    }


# --------------------------------------------------------------------------
# CPU: analiz
# --------------------------------------------------------------------------


@app.function(image=analyze_image, volumes={DATA_DIR: volume}, timeout=600)
def analyze(song_id: str, beats_source: str = "auto") -> dict:
    """beats_source: "auto" (beats.json varsa onu kullan) veya "librosa"."""
    import numpy as np
    import soundfile as sf

    started = time.time()
    volume.reload()
    song_dir = _song_dir(song_id)
    master_dir = song_dir / "master"

    try:
        _write_status(song_id, state="analyzing", progress=75, error=None)

        # Akor KALİTESİ: piano+guitar+other (bass, drums, vocals HARİÇ).
        # Bass ayrı okunuyor: slash akorun bas notası ve downbeat yedeği için.
        parts = {}
        samplerate = None
        for name in QUALITY_STEMS + (BASS_STEM,):
            path = master_dir / f"{name}.flac"
            if not path.exists():
                raise FileNotFoundError(f"{name}.flac yok; once ayristirma gerekiyor")
            data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
            if samplerate is None:
                samplerate = int(file_sr)
            elif int(file_sr) != samplerate:
                raise ValueError(f"{name}.flac ornekleme hizi farkli: {file_sr}")
            parts[name] = data.mean(axis=1)

        length = min(part.shape[0] for part in parts.values())
        quality = np.sum([parts[name][:length] for name in QUALITY_STEMS], axis=0)
        bass = parts[BASS_STEM][:length]

        # beats.json (beat_this) varsa kullan.
        beats = None
        downbeats = None
        beats_path = song_dir / "beats.json"
        if beats_source == "librosa":
            print("[analiz] beats.json yok sayildi (--beats librosa)")
        elif beats_path.exists():
            beats_data = json.loads(beats_path.read_text(encoding="utf-8"))
            beats = beats_data.get("beats") or None
            downbeats = beats_data.get("downbeats") or None
            print(
                f"[analiz] beats.json: {len(beats or [])} beat, "
                f"{len(downbeats or [])} downbeat, kaynak={beats_data.get('source')}"
            )
        else:
            print("[analiz] beats.json YOK -> librosa yedegine dusuluyor")

        print(f"[analiz] kalite={list(QUALITY_STEMS)} sr={samplerate} ornek={length}")
        _write_status(song_id, progress=85)

        data = analyze_core(
            quality, bass, int(samplerate), beats=beats, downbeats=downbeats
        )

        chords_path = song_dir / "chords.json"
        chords_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        volume.commit()

        summary = {
            "id": song_id,
            "bpm": data["bpm"],
            "key": data["key"],
            "beats_source": data["beats_source"],
            "downbeats_source": data["downbeats_source"],
            "segment_mode": data["segment_mode"],
            "slash_count": sum(1 for c in data["chords"] if "/" in c["label"]),
            "beat_count": len(data["beats"]),
            "downbeat_count": len(data["downbeats"]),
            "chord_count": len(data["chords"]),
            "labels": sorted({chord["label"] for chord in data["chords"]}),
            "analyze_seconds": round(time.time() - started, 2),
        }
        print(f"[analiz] {summary}")
        _write_status(
            song_id, state="done", progress=100, error=None,
            bpm=data["bpm"], key=data["key"], chord_count=len(data["chords"]),
            analyze_seconds=summary["analyze_seconds"],
        )
        return _assert_plain(summary)

    except Exception as exc:
        _write_status(song_id, state="error", error=f"{type(exc).__name__}: {exc}")
        raise


# --------------------------------------------------------------------------
# API (FastAPI, CPU, torch YOK)
# --------------------------------------------------------------------------

API_SECRET_NAME = "stem-mikser"
DOWNLOAD_TTL = 600  # imzalı indirme linki 10 dakika geçerli
RELOAD_TTL = 2.0  # iki metadata reload'u arasındaki en kısa süre
DOWNLOAD_FORMATS = ("m4a", "flac", "wav")
LOCAL_ORIGINS = (
    "http://localhost:8000", "http://127.0.0.1:8000",
    "http://localhost:5500", "http://127.0.0.1:5500",
    "http://localhost:3000", "http://127.0.0.1:3000",
)


def _check_api_imports():
    """Build: fastapi/starlette gerçekten uyumlu mu, app kurulabiliyor mu."""
    import fastapi
    import starlette
    from fastapi import FastAPI

    print(f"fastapi {fastapi.__version__} / starlette {starlette.__version__}")

    try:
        import multipart  # python-multipart'in modul adi
    except ImportError:
        import python_multipart as multipart  # yeni surumlerdeki ad
    print(f"python-multipart: {getattr(multipart, '__version__', 'surum yok')}")

    probe_app = FastAPI()

    @probe_app.get("/x")
    def _x():
        return {"ok": True}

    if not [r for r in probe_app.routes if getattr(r, "path", "") == "/x"]:
        raise RuntimeError(
            "FastAPI route kaydi calismiyor; fastapi/starlette surumleri uyumsuz"
        )

    from fastapi.middleware.cors import CORSMiddleware  # noqa: F401
    from starlette.responses import JSONResponse, Response  # noqa: F401

    print("API import zinciri tamam")


# --------------------------------------------------------------------------
# Şarkı söyleme antrenörü (Mikrofon paketi 9), 1. oturum: HEDEF MELODİ (CPU)
#
# Ana vokalin perdesi şarkı başına BİR kez çıkarılır ve `melody.bin` olarak saklanır; telefon bunu indirip önbelleğe alır.
# Mikrofon sesi sunucuya HİÇBİR koşulda gitmez: bu bölüm yalnız şarkının kendi vokal stem'ini işler.
#
# Yöntem v1: pYIN (librosa, ISC), CPU. Kaynak: alt parçalar ayrılmış ve güvenilirse (`status.sub.reliability == "ok"`) ANA vokal
# (lead.flac), değilse SW vokal stem'i (vocals.flac). YÖNTEM VERİYE YAZILIR (başlıkta `method`, `params`, `source`): ileride RMVPE /
# torchcrepe gibi başka bir yöntem aynı biçimle gelebilir, telefon değişmez. separate_image / Hi-Fi yoluna DOKUNULMAZ (analyze_image).
#
# melody.bin biçimi (little-endian):
#   "MEL1" | u32 başlık uzunluğu | başlık JSON (UTF-8) | n adet int16
#   int16 = MIDI notası x 100 (A4 = 6900); 0 = sessiz / perde yok. Kare süresi = başlık.hop_s (512 / 22050 sn, ~23,2 ms).
#   başlık: {v, method, source, sr, hop, hop_s, frame, n, unit, fmin, fmax, duration, params, post, stats, lib}
# --------------------------------------------------------------------------
MELODY_FORMAT = 1
MELODY_MAGIC = b"MEL1"
MELODY_METHOD = "pyin"
MELODY_SR = 22050
MELODY_FRAME = 2048
MELODY_HOP = 512
MELODY_FMIN_HZ = 65.406          # C2
MELODY_FMAX_HZ = 1046.502        # C6
MELODY_SILENT_DBFS = SUB_SILENT_DBFS   # "vokal yok" kapısıyla AYNI sayı (-50 dBFS)
MELODY_FRAME_GATE_DBFS = -50.0   # kare RMS'i bunun altındaysa perde yok sayılır (ayrıştırma artığı / nefes)
MELODY_MIN_RUN = 4               # bundan kısa sesli parçalar (~93 ms) atılır
MELODY_OCTAVE_WINDOW = 15        # oktav / aykırı düzeltmesi için bakılan komşu kare sayısı (her yönde)
MELODY_RUNNING_STALE_SECONDS = 2400
MELODY_SOURCES = ("auto", "vocals", "lead")
MELODY_PYIN_PARAMS = {"switch_prob": 0.01, "max_transition_rate": 35.92, "resolution": 0.1, "beta_parameters": [2, 18],
                      "boltzmann_parameter": 2, "no_trough_prob": 0.01}
MELODY_CPU = 2.0                  # ayrılan çekirdek (maliyet tahmini için)
MELODY_CPU_CORE_SECOND_USD = 0.0000131    # Modal CPU fiyatı (çekirdek-saniye) - TAHMİN; güncel fiyat Modal'dan kontrol edilmeli


def _melody_is_running(status) -> bool:
    mel = (status or {}).get("melody") or {}
    if mel.get("state") != "running":
        return False
    return (time.time() - float(mel.get("started") or 0)) < MELODY_RUNNING_STALE_SECONDS


def _melody_stale(status) -> bool:
    """Hedef melodi başka bir ayrıştırmadan mı? (Ana şarkı sonradan yeniden işlendi.)"""
    mel = (status or {}).get("melody") or {}
    if mel.get("state") != "done":
        return False
    return mel.get("parent_stems_version") != (status or {}).get("stems_version")


def _melody_pick_source(status, requested: str = "auto"):
    """Hangi stem'den çıkarılacak? Dönen: (kaynak, neden); kaynak None ise istek yapılamaz (neden = açıklama).

    auto: alt parçalar HAZIR ve GÜVENİLİR (reliability == ok) ise ana vokal (lead), değilse SW vokal stem'i.
    """
    sub = (status or {}).get("sub") or {}
    lead_ready = sub.get("state") == "done"
    lead_ok = lead_ready and sub.get("reliability") == "ok"
    if requested == "vocals":
        return "vocals", "istendi"
    if requested == "lead":
        if not lead_ready:
            return None, "Ana vokal (alt parcalar) henuz ayrilmamis"
        return "lead", "istendi"
    if lead_ok:
        return "lead", "alt parcalar guvenilir (ana vokal kullaniliyor)"
    return "vocals", "alt parca yok ya da guvenilir degil (SW vokal stem'i)"


def _melody_source_path(song_id: str, source: str) -> pathlib.Path:
    master = _song_dir(song_id) / "master"
    return master / "sub" / "lead.flac" if source == "lead" else master / "vocals.flac"


def _melody_runs(mask):
    """Boolean maskedeki ardışık True parçaları: [(başlangıç, bitiş_hariç), ...]."""
    runs = []
    start = None
    for index, flag in enumerate(mask):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def _melody_postprocess(f0, voiced, rms_dbfs, gate_dbfs: float = MELODY_FRAME_GATE_DBFS) -> tuple:
    """pYIN çıktısını temizler. Dönen: (int16 kareler [MIDI x 100, 0 = sessiz], istatistik sözlüğü).

    Adımlar: (1) pYIN sesli bayrağı + sonlu perde + kare seviyesi kapısı; (2) kısa sesli parçalar atılır; (3) komşu karelerin
    ortancasından ~bir oktav (>= 8 yarım ses) sapan kare, oktav katı kaydırılınca komşulara oturuyorsa KAYDIRILIR, oturmuyorsa
    atılır (aykırı); (4) 3 karelik ortanca süzgeç (yalnız sesli komşular arasında); (5) kısa parçalar yeniden atılır.
    Sürekli (pencereden uzun) oktav hataları bu yolla düzelmez: istatistikteki `jumps12` artık sıçramaları sayar.
    """
    import numpy as np

    f0 = np.asarray(f0, dtype=np.float64)
    n = len(f0)
    ok = np.asarray(voiced, dtype=bool) & np.isfinite(f0) & (f0 > 0) & (np.asarray(rms_dbfs, dtype=np.float64) >= gate_dbfs)
    midi = np.full(n, np.nan)
    midi[ok] = 69.0 + 12.0 * np.log2(f0[ok] / 440.0)
    raw_voiced = int(ok.sum())

    def drop_short(mask):
        dropped = 0
        for start, end in _melody_runs(mask):
            if end - start < MELODY_MIN_RUN:
                mask[start:end] = False
                dropped += end - start
        return dropped

    short_dropped = drop_short(ok)
    original = midi.copy()
    fixes = 0
    outliers = 0
    for index in np.flatnonzero(ok):
        low, high = max(index - MELODY_OCTAVE_WINDOW, 0), min(index + MELODY_OCTAVE_WINDOW + 1, n)
        window = ok[low:high].copy()
        window[index - low] = False                       # kendisi referansa girmez
        neighbours = original[low:high][window]
        if len(neighbours) < 3:
            continue
        reference = float(np.median(neighbours))
        delta = original[index] - reference
        if abs(delta) < 8.0:
            continue
        shifted = original[index] - 12.0 * round(delta / 12.0)
        if abs(shifted - reference) <= 4.0:
            midi[index] = shifted
            fixes += 1
        else:
            ok[index] = False
            outliers += 1
    smoothed = midi.copy()
    for index in np.flatnonzero(ok):
        if 0 < index < n - 1 and ok[index - 1] and ok[index + 1]:
            smoothed[index] = float(np.median(midi[index - 1:index + 2]))
    midi = smoothed
    short_dropped += drop_short(ok)

    cents = np.zeros(n, dtype=np.int16)
    cents[ok] = np.clip(np.round(midi[ok] * 100.0), 1, 12700).astype(np.int16)
    voiced_count = int(ok.sum())
    jumps = 0
    both = ok[1:] & ok[:-1]
    if both.any():
        jumps = int((np.abs(midi[1:][both] - midi[:-1][both]) >= 11.0).sum())
    stats = {
        "frames": n, "voiced": voiced_count, "voiced_ratio": round(voiced_count / n, 4) if n else 0.0,
        "raw_voiced": raw_voiced, "short_dropped": int(short_dropped), "octave_fixes": int(fixes), "outliers_dropped": int(outliers),
        "jumps12": jumps,
    }
    if voiced_count:
        values = midi[ok]
        stats["midi_p05"] = round(float(np.percentile(values, 5)), 2)
        stats["midi_p50"] = round(float(np.percentile(values, 50)), 2)
        stats["midi_p95"] = round(float(np.percentile(values, 95)), 2)
    return cents, stats


def _melody_encode(cents, header: dict) -> bytes:
    import struct

    import numpy as np

    head = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return MELODY_MAGIC + struct.pack("<I", len(head)) + head + np.asarray(cents, dtype="<i2").tobytes()


def _melody_decode(blob: bytes) -> tuple:
    """melody.bin -> (başlık sözlüğü, int16 dizisi). Bozuksa ValueError."""
    import struct

    import numpy as np

    if len(blob) < 8 or blob[:4] != MELODY_MAGIC:
        raise ValueError("melody.bin: sihirli bayt yanlis")
    (head_len,) = struct.unpack("<I", blob[4:8])
    if head_len <= 0 or 8 + head_len > len(blob):
        raise ValueError("melody.bin: baslik uzunlugu bozuk")
    header = json.loads(blob[8:8 + head_len].decode("utf-8"))
    body = blob[8 + head_len:]
    if header.get("v") != MELODY_FORMAT or len(body) != 2 * int(header.get("n", -1)):
        raise ValueError("melody.bin: surum ya da veri uzunlugu uyusmuyor")
    return header, np.frombuffer(body, dtype="<i2")


def _melody_restore(song_id: str, previous, message: str) -> None:
    """Hata olursa ÖNCEKİ tamam kaydı geri koyar (yoksa state=error)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if previous and previous.get("state") == "done":
        _write_status(song_id, melody=dict(previous, last_attempt={"state": "error", "message": message[:300], "finished_at": stamp}))
    else:
        _write_status(song_id, melody={"state": "error", "message": message[:300], "finished_at": stamp})


def _extract_melody_impl(song_id: str, requested: str, previous) -> dict:
    import librosa
    import numpy as np
    import soundfile as sf

    started = time.time()
    song_dir = _song_dir(song_id)
    status = json.loads((song_dir / "status.json").read_text(encoding="utf-8"))
    source, why = _melody_pick_source(status, requested)
    if source is None:
        raise ValueError(why)
    path = _melody_source_path(song_id, source)
    if not path.is_file():
        if requested == "auto" and source == "lead":
            source, why = "vocals", "lead dosyasi yok (SW vokal stem'i)"
            path = _melody_source_path(song_id, source)
        if not path.is_file():
            raise FileNotFoundError(f"{path.name} yok; once ayristirma gerekiyor")
    if (status.get("melody") or {}).get("state") != "running":      # toplu üretim (API'den geçmedi): çalışıyor işareti
        keep = previous if previous and previous.get("state") == "done" else None
        _write_status(song_id, melody={"state": "running", "started": int(started), "source": source, "previous": keep})

    step = time.time()
    audio, rate = sf.read(str(path), dtype="float32", always_2d=True)
    y = audio.mean(axis=1)
    duration = round(len(y) / float(rate), 3)
    if int(rate) != MELODY_SR:
        y = librosa.resample(y, orig_sr=int(rate), target_sr=MELODY_SR)
    y = np.ascontiguousarray(y, dtype=np.float32)
    decode_seconds = round(time.time() - step, 2)

    rms = librosa.feature.rms(y=y, frame_length=MELODY_FRAME, hop_length=MELODY_HOP)[0]
    rms_dbfs = 20.0 * np.log10(np.maximum(rms, 1e-9))
    overall = float(20.0 * np.log10(max(float(np.sqrt(np.mean(np.square(y, dtype=np.float64)))), 1e-9)))
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if overall < MELODY_SILENT_DBFS:
        record = {"state": "no_vocals", "rms_dbfs": round(overall, 2), "source": source,
                  "parent_stems_version": status.get("stems_version"), "finished_at": stamp}
        if not (previous and previous.get("state") == "done"):
            _write_status(song_id, melody=record)
        else:
            _write_status(song_id, melody=previous)
        return {"id": song_id, "state": "no_vocals", "rms_dbfs": round(overall, 2)}

    step = time.time()
    f0, voiced, _prob = librosa.pyin(
        y, fmin=MELODY_FMIN_HZ, fmax=MELODY_FMAX_HZ, sr=MELODY_SR, frame_length=MELODY_FRAME, hop_length=MELODY_HOP,
        switch_prob=MELODY_PYIN_PARAMS["switch_prob"], max_transition_rate=MELODY_PYIN_PARAMS["max_transition_rate"],
        resolution=MELODY_PYIN_PARAMS["resolution"], beta_parameters=tuple(MELODY_PYIN_PARAMS["beta_parameters"]),
        boltzmann_parameter=MELODY_PYIN_PARAMS["boltzmann_parameter"], no_trough_prob=MELODY_PYIN_PARAMS["no_trough_prob"], fill_na=np.nan,
    )
    pyin_seconds = round(time.time() - step, 2)
    count = min(len(f0), len(rms_dbfs))
    step = time.time()
    cents, stats = _melody_postprocess(f0[:count], voiced[:count], rms_dbfs[:count])
    post_seconds = round(time.time() - step, 2)

    header = {
        "v": MELODY_FORMAT, "method": MELODY_METHOD, "source": source, "sr": MELODY_SR, "hop": MELODY_HOP,
        "hop_s": round(MELODY_HOP / MELODY_SR, 8), "frame": MELODY_FRAME, "n": int(len(cents)), "unit": "midi_x100", "unvoiced": 0,
        "fmin": MELODY_FMIN_HZ, "fmax": MELODY_FMAX_HZ, "duration": duration,
        "params": dict(MELODY_PYIN_PARAMS, frame_gate_dbfs=MELODY_FRAME_GATE_DBFS),
        "post": {"min_run": MELODY_MIN_RUN, "octave_window": MELODY_OCTAVE_WINDOW, "median3": True},
        "stats": stats, "lib": {"librosa": librosa.__version__},
    }
    blob = _melody_encode(cents, header)
    version = max(int(time.time()), int((previous or {}).get("version") or 0) + 1)
    target = song_dir / "melody.bin"
    tmp = target.with_name("melody.bin.tmp")
    tmp.write_bytes(blob)
    os.replace(tmp, target)                                   # önce dosya (atomik), SONRA status

    total = round(time.time() - started, 2)
    record = {
        "state": "done", "version": version, "method": MELODY_METHOD, "source": source, "source_reason": why,
        "parent_stems_version": status.get("stems_version"), "parent_pipeline": status.get("pipeline"),
        "frames": stats["frames"], "voiced_ratio": stats["voiced_ratio"], "bytes": len(blob), "rms_dbfs": round(overall, 2),
        "seconds": {"decode": decode_seconds, "pyin": pyin_seconds, "post": post_seconds, "total": total},
        "finished_at": stamp,
    }
    _write_status(song_id, melody=record)
    print(f"[melody] {song_id[:8]} {source}: {stats['voiced']}/{stats['frames']} sesli, oktav duzeltme {stats['octave_fixes']}, "
          f"pyin {pyin_seconds} sn, toplam {total} sn, {len(blob)} bayt")
    return {"id": song_id, "state": "done", "source": source, "version": version, "bytes": len(blob), "stats": stats,
            "seconds": record["seconds"], "duration": duration,
            "cost_usd_estimate": round(total * MELODY_CPU * MELODY_CPU_CORE_SECOND_USD, 5)}


@app.function(
    image=analyze_image,        # librosa + numpy + soundfile; separate_image / Hi-Fi / sub_image'a DOKUNULMAZ
    volumes={DATA_DIR: volume},
    timeout=900,
    cpu=MELODY_CPU,
    memory=2048,
    max_containers=3,           # min_containers YOK: boştayken maliyet sıfır; toplu üretimde en çok 3 şarkı birlikte
)
def extract_melody(song_id: str, source: str = "auto") -> dict:
    """Ana vokalin perdesini (pYIN) çıkarıp melody.bin + status.melody yazar. Hata olursa ÖNCEKİ tamam kayıt geri konur."""
    volume.reload()
    previous = None
    with contextlib.suppress(Exception):
        previous = (json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8")).get("melody") or {}).get("previous")
        if previous is None:
            current = json.loads((_song_dir(song_id) / "status.json").read_text(encoding="utf-8")).get("melody") or {}
            previous = current if current.get("state") == "done" else None
    try:
        return _extract_melody_impl(song_id, source, previous)
    except Exception as error:
        with contextlib.suppress(Exception):
            volume.reload()
            _melody_restore(song_id, previous, f"{type(error).__name__}: {error}")
        raise


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=300)
def melody_list() -> list:
    """Toplu üretim için: bitmiş şarkılar ve melodi durumları."""
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
        if data.get("state") != "done" or data.get("source_song"):
            continue
        mel = data.get("melody") or {}
        found.append({"id": str(data.get("id", entry.name)), "title": str(data.get("title") or entry.name[:12]),
                      "duration": data.get("duration"), "melody_state": mel.get("state"),
                      "sub_state": (data.get("sub") or {}).get("state"), "sub_reliability": (data.get("sub") or {}).get("reliability")})
    return found


@app.local_entrypoint()
def melody_backfill(ids: str = "", source: str = "auto", replace: bool = False):
    """Kitaplıktaki bitmiş şarkıların hedef melodisini üretir (en çok 3 paralel).

        modal run backend/app.py::melody_backfill
        modal run backend/app.py::melody_backfill --ids <kimlik>,<kimlik> --source vocals --replace

    Varsayılan: melodisi olmayan / hatalı şarkılar; `--replace` hepsini yeniden üretir.
    """
    wanted = {item.strip() for item in ids.split(",") if item.strip()}
    songs = melody_list.remote()
    todo = [song for song in songs
            if (not wanted or song["id"] in wanted) and (replace or wanted or song["melody_state"] not in ("done", "no_vocals", "running"))]
    print(f"{len(songs)} sarki, {len(todo)} uretilecek")
    started = time.time()
    results = list(extract_melody.starmap([(song["id"], source) for song in todo], return_exceptions=True))
    wall = round(time.time() - started, 1)
    total_cost = 0.0
    print(f"{'baslik':36} {'kaynak':7} {'sure':>6} {'decode':>7} {'pyin':>6} {'toplam':>7} {'sesli%':>7} {'oktav':>5} {'sicrama':>7} {'$~':>8}")
    for song, result in zip(todo, results):
        if isinstance(result, Exception):
            print(f"{song['title'][:36]:36} HATA: {type(result).__name__}: {str(result)[:80]}")
            continue
        if result.get("state") != "done":
            print(f"{song['title'][:36]:36} {result.get('state')}")
            continue
        s, sec = result["stats"], result["seconds"]
        total_cost += result["cost_usd_estimate"]
        print(f"{song['title'][:36]:36} {result['source']:7} {result['duration']:6.1f} {sec['decode']:7.1f} {sec['pyin']:6.1f} {sec['total']:7.1f} "
              f"{100 * s['voiced_ratio']:6.1f}% {s['octave_fixes']:5} {s['jumps12']:7} {result['cost_usd_estimate']:8.5f}")
    print(f"toplam duvar saati {wall} sn, tahmini maliyet ~${total_cost:.4f} ({MELODY_CPU} cekirdek x {MELODY_CPU_CORE_SECOND_USD} $/cekirdek-sn)")


api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        # fastapi starlette'e ÜST SINIR koymuyor (starlette>=0.46.0). starlette
        # 1.0.0 Mart 2026'da, fastapi 0.141.1 Temmuz 2026'da çıktı; yani 1.x'e
        # karşı test edilmiş, 0.4x'e çakmak yanlış olurdu. Uyumu build'de
        # _check_api_imports doğruluyor.
        "fastapi==0.141.1",
        "starlette==1.7.0",
        "python-multipart==0.0.32",
    )
    .run_function(_check_api_imports)
)


class _VolumeGate:
    """volume.reload() ile dosya okumalarını birbirinden ayırır.

    Modal dokümanı: "You can only reload a Volume when there are no open files
    on the Volume" - açık dosya varken reload 'volume busy' ile patlıyor, ve
    reload sürerken volume o konteynere BOŞ görünüyor. max_inputs=8 ile bir
    istek dosya okurken başkası reload çağırabileceği için bu bir yazıcı/okuyucu
    kilidi gerektiriyor: reload yazıcı, dosya okumaları okuyucu.
    """

    def __init__(self, ttl: float = RELOAD_TTL):
        self._lock = asyncio.Lock()
        self._readers = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self._last_reload = 0.0
        self._ttl = ttl
        self.reload_count = 0

    @contextlib.asynccontextmanager
    async def reading(self):
        # Kilit yalnızca sayaç artarken tutuluyor; reload sürerken yeni
        # okuyucu giremez, ama okuyucular birbirini beklemez.
        async with self._lock:
            self._readers += 1
            self._idle.clear()
        try:
            yield
        finally:
            self._readers -= 1
            if self._readers <= 0:
                self._readers = 0
                self._idle.set()

    async def refresh(self, force: bool = False) -> bool:
        now = time.time()
        if not force and now - self._last_reload < self._ttl:
            return False
        async with self._lock:
            if not force and time.time() - self._last_reload < self._ttl:
                return False
            # Açık okuma bitene kadar bekle: aksi halde reload 'volume busy'
            # verir ya da okuyan istek boş volume görür.
            await self._idle.wait()
            await volume.reload.aio()
            self._last_reload = time.time()
            self.reload_count += 1
            return True


def _parse_range(header: str, size: int):
    """'bytes=a-b' -> (start, end) kapsayıcı. None: tamamını gönder.

    Karşılanamaz aralıkta ValueError atar (çağıran 416 döndürür).
    """
    if not header:
        return None
    header = header.strip()
    if not header.lower().startswith("bytes="):
        return None
    spec = header.split("=", 1)[1].split(",")[0].strip()
    start_text, _, end_text = spec.partition("-")
    # Sayı ayrıştırma ile geçerlilik kontrolü AYRI: ayrıştırılamayan başlık
    # yok sayılır (tamamını gönder), karşılanamaz aralık 416 olur. İkisini
    # aynı try içinde yapmak "bytes=-0" gibi durumlarda kendi ValueError'ımı
    # kendi except'ime yutturuyordu.
    try:
        if not start_text:
            suffix_length = int(end_text)
            start = end = None
        else:
            suffix_length = None
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
    except ValueError:
        return None  # ayrıştırılamadı: aralığı yok say, tamamını gönder

    if suffix_length is not None:
        if suffix_length <= 0:
            raise ValueError("karsilanamaz son ek")
        start = max(size - suffix_length, 0)
        end = size - 1
    if start >= size or start > end:
        raise ValueError("karsilanamaz aralik")
    return start, min(end, size - 1)


def _read_slice(path: pathlib.Path, start: int = 0, length: int = -1) -> bytes:
    """Dosyanın bir dilimini okur ve tanıtıcıyı HEMEN kapatır.

    Açık tanıtıcı bırakmamak bilinçli: volume üzerinde açık dosya varken
    reload patlıyor. Dosyalar en fazla ~45 MB (30 MB girdi sınırı), bellekte
    tutmak sorun değil.
    """
    with path.open("rb") as handle:
        if start:
            handle.seek(start)
        return handle.read() if length < 0 else handle.read(length)


_ILLEGAL_FILENAME = set('<>:"/|?*') | {"\\"}


def _download_filename(title: str, stem: str, fmt: str) -> str:
    """"<şarkı adı> - <kanal>.<uzantı>" biçiminde temiz bir dosya adı."""
    cleaned = "".join(" " if ch in _ILLEGAL_FILENAME or ord(ch) < 32 else ch
                      for ch in (title or ""))
    cleaned = " ".join(cleaned.split()).strip(". ")[:80]
    if not cleaned:
        cleaned = "sarki"
    return f"{cleaned} - {stem}.{fmt}"


def _content_disposition(filename: str) -> str:
    """attachment başlığı; Türkçe karakterler için RFC 5987 filename*.

    <a download> başka origin'de yok sayılıyor, bu yüzden indirmeyi bu
    başlık zorluyor. ASCII filename eski istemciler için yedek.
    """
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip()
    ascii_name = ascii_name.replace('"', "").replace("\\", "")
    if not ascii_name or ascii_name.startswith("."):
        ascii_name = f"stem.{filename.rsplit('.', 1)[-1]}"
    quoted = urllib.parse.quote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quoted}"


def _sign_download(key: str, song_id: str, name: str, fmt: str, exp: int) -> str:
    message = f"{song_id}|{name}|{fmt}|{exp}".encode("utf-8")
    return hmac.new(key.encode("utf-8"), message, hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------
# Söz çevirisi (Aşama 14)
#
# Yabancı (en, ja) sözlerin satır satır doğal TÜRKÇE çevirisi ve Japoncada okunuş (romaji).
# Çeviri Gemini API'sinden (ücretsiz katman; PLAN.md Aşama 14), CPU işinde; anahtar YALNIZ
# Modal secret'ında (`stem-mikser-gemini`: GEMINI_API_KEY, isteğe bağlı GEMINI_MODEL /
# GEMINI_FALLBACK_MODEL) ve yalnız `translate_lyrics` işine bağlanır: web API'si ve telefon
# görmez. Anahtar başlıkta (`x-goog-api-key`) gider, URL'e ya da log'a girmez.
#
# Çeviri `songs/<id>/translation.json`da (yalnız Volume, depoya girmez) SATIR METNİ HASH'ine
# bağlı tutulur, sözlerin `version`'ına DEĞİL (o, "Zamanı düzelt"te de artıyor): zamanlar ve
# sıra değişse de çeviri korunur; metni değişen/eklenen satır "çevrilmedi" olur ve yeniden
# çeviri yalnız onları (tüm şarkı bağlamıyla) yapar.
# --------------------------------------------------------------------------

TRANSLATE_SECRET_NAME = "stem-mikser-gemini"
TRANSLATE_LANGS = ("en", "ja")                 # çevrilebilir kaynak diller (tr çevrilmez)
TRANSLATE_API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TRANSLATE_DEFAULT_MODEL = "gemini-3.8-flash"
TRANSLATE_DEFAULT_FALLBACK = "gemini-3.5-flash-lite"
TRANSLATE_WAITS = (3.0, 8.0)                   # 429/503'te kısa bekleme, sonra aynı modelde yeniden
TRANSLATE_RETRIES = 2                          # geçersiz çıktıda (satır sayısı vb.) yeniden deneme
TRANSLATE_CHUNK = 20                           # son çare: bu kadarlık parçalar (bağlam yine tam şarkı)
TRANSLATE_TIMEOUT = 120
TRANSLATE_RUNNING_STALE_SECONDS = 900
TRANSLATE_BUSY_MESSAGE = "Çeviri servisi şu an meşgul, biraz sonra tekrar dene."
TRANSLATE_KANJI_RE = re.compile(r"[㐀-䶿一-鿿]")
TRANSLATE_NUMBERING_RE = re.compile(r"^\s*(\d{1,3}\s*[:.)\]-]|\[\d{1,3}\])\s")
TRANSLATE_LANG_NAMES = {"en": "English", "ja": "Japanese"}


class TranslateError(Exception):
    """Çeviri hatası; `code` arayüzde ayırt edilir, `message` kullanıcıya gösterilir."""
    code = "error"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class TranslateBusy(TranslateError):
    code = "busy"


class TranslateRefused(TranslateError):
    code = "refused"


class TranslateAuth(TranslateError):
    code = "auth"


class TranslateInvalid(TranslateError):
    code = "invalid"


def _tr_is_running(status) -> bool:
    record = (status or {}).get("translation") or {}
    if record.get("state") != "running":
        return False
    return (time.time() - float(record.get("started") or 0)) < TRANSLATE_RUNNING_STALE_SECONDS


def _tr_norm(text) -> str:
    return " ".join(str(text or "").lower().split())


def _tr_hash(text) -> str:
    return hashlib.sha1(_tr_norm(text).encode("utf-8")).hexdigest()[:12]


def _tr_missing(lines: list, items: dict) -> list:
    """Çevirisi olmayan satırların İLK geçtiği dizinler (aynı metin tek kez; refren tekrarı bedava)."""
    seen, out = set(), []
    for i, text in enumerate(lines):
        h = _tr_hash(text)
        if h in seen or (items.get(h) or {}).get("tr"):
            continue
        seen.add(h)
        out.append(i)
    return out


TRANSLATE_PRON_EXAMPLE = ("We were walking down the road", "Vi vır vokin dawn dı rod")   # SENTETİK örnek (gerçek söz değil)


TRANSLATE_TR_LETTERS = set("abcçdefgğhıijklmnoöprsştuüvyz")
TRANSLATE_LETTER_MAP = {"w": "v", "x": "ks", "q": "k"}


def _tr_clean_pron(text: str) -> str:
    """Telaffuzu YALNIZ Türk alfabesi harflerine indirger (ê -> e, w -> v, x -> ks, q -> k; rakam/noktalama atılır).
    Boşluk, kesme işareti ve tire korunur."""
    import unicodedata

    out = []
    for ch in unicodedata.normalize("NFC", str(text or "")):
        low = ch.lower()
        if low in TRANSLATE_TR_LETTERS:
            out.append(ch)
        elif ch.isspace() or ch in "'-":
            out.append(" " if ch.isspace() else ch)
        elif ch.isalpha():
            base = unicodedata.normalize("NFKD", low)[:1]
            base = TRANSLATE_LETTER_MAP.get(base, base)
            if base and all(c in TRANSLATE_TR_LETTERS for c in base):
                out.append(base.upper() if ch.isupper() else base)
    return " ".join("".join(out).split())


# Telaffuzu kaynakla BİREBİR aynı kalan "şüpheli" kelimeler: harfleri Türk alfabesinde olduğu için alfabe süzgeci
# yakalamaz ("nothing" -> "nothing", oysa "nating"). Okunduğu gibi yazılan kısa/yaygın kelimeler (and, for...) hariç.
TRANSLATE_SAFE_SAME = frozenset({"for", "in", "it", "is", "on", "at", "an", "us", "if", "of", "up", "or", "no", "go", "so", "to",
                                 "not", "met", "let", "get", "set", "yes", "man", "can", "red", "run", "sun", "fun"})
TRANSLATE_SUSPECT_RE = re.compile(r"th|w|ee|oo|ea|ou|ow|igh|gh|ph|ck|wh|kn|wr|tion|sion|ai|ay|oa|oy|ie|ey", re.I)
TRANSLATE_SILENT_E_RE = re.compile(r"[^aeiouy']e$", re.I)
TRANSLATE_FIX_BATCH = 60


def _tr_suspect(src_word: str, pron_word: str) -> bool:
    """Telaffuz kelimesi kaynak kelimeyle (büyük/küçük harf farkı hariç) aynı VE İngilizce yazımı Türkçe okunuşuna
    uymayacak örüntü taşıyor mu (th, w, ee, oo, ea, ou, ow, igh, gh, ph, ck, wh, kn, wr, tion, ai, ay, oa..., sessiz e)?"""
    s = str(src_word or "").lower().strip("'\u2019")
    if not s or s != str(pron_word or "").lower() or len(s) <= 2 or s in TRANSLATE_SAFE_SAME:
        return False
    return bool(TRANSLATE_SUSPECT_RE.search(s) or TRANSLATE_SILENT_E_RE.search(s))


def _tr_find_suspects(lines: list, results: list) -> list:
    """results'taki `pr`lerde şüpheli kelimeleri bulur. Dönen: [(sonuç dizini, kelime dizini, kaynak kelime)].
    Kelime sayısı tutmasa da çalışır: telaffuz kelimesi satırdaki bir kaynak kelimeyle aynıysa değerlendirilir."""
    found = []
    for r_index, result in enumerate(results):
        if not result.get("pr"):
            continue
        src_words = {w.lower(): w for w in TRANSLATE_SRC_WORD_RE.findall(lines[result["i"]])}
        words = TRANSLATE_PRON_STRIP_RE.sub(" ", result["pr"]).split()
        for k, word in enumerate(words):
            source = src_words.get(word.lower())
            if source and _tr_suspect(source, word):
                found.append((r_index, k, source.lower()))
    return found


def _tr_fix_prompt(items: list, feedback: str = "") -> tuple:
    system = (
        "You give the pronunciation of single English words for Turkish speakers, as they are SUNG in the given line. "
        "Write each pronunciation with ONLY letters of the Turkish alphabet (a b c ç d e f g ğ h ı i j k l m n o ö p r s ş t "
        "u ü v y z; no w, x, q, no accents): v for w, th -> t/d/s, ee -> i, oo -> u, silent e dropped, etc. "
        "The answer must be ONE word (no spaces) and must NOT simply repeat the English spelling.\n"
    )
    listing = "\n".join(f'{n}: word "{it["word"]}" in the line "{it["context"]}"' for n, it in enumerate(items))
    user = (f"Items:\n{listing}\n\nReturn a JSON array with exactly {len(items)} objects in this order: "
            '{"id": <item number>, "pr": "<pronunciation of that word>"}.')
    if feedback:
        user += f"\n\nYour previous answer was rejected: {feedback}\nFix it and answer again."
    return system, user


def _tr_fix_schema(count: int) -> dict:
    return {"type": "ARRAY", "minItems": count, "maxItems": count, "items": {
        "type": "OBJECT", "properties": {"id": {"type": "INTEGER"}, "pr": {"type": "STRING"}}, "required": ["id", "pr"]}}


def _tr_fix_parse(text: str, items: list) -> list:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        raise TranslateInvalid("JSON degil")
    if not isinstance(data, list) or len(data) != len(items):
        raise TranslateInvalid(f"{len(items)} oge beklendi")
    out = []
    for n, (item, entry) in enumerate(zip(items, data)):
        if not isinstance(entry, dict) or entry.get("id") != n:
            raise TranslateInvalid(f"{n}. ogede id bozuk")
        pr = _tr_clean_pron(entry.get("pr") if isinstance(entry.get("pr"), str) else "")
        if not pr or " " in pr or len(pr) > 3 * len(item["word"]) + 6:
            raise TranslateInvalid(f"{n}. ogenin telaffuzu gecersiz (tek kelime olmali)")
        out.append(pr)
    return out


def _tr_fix_pron(lines: list, results: list, call) -> int:
    """Telaffuzu kaynakla aynı kalan şüpheli kelimeleri Gemini'ye YENİDEN sorar ve düzeltir (tutarlılık kontrolünden ÖNCE).
    Her ayrı kelime bir kez sorulur (örnek satırıyla), cevap o kelimenin her geçişine uygulanır. Yeniden sorma
    başarısız olursa (meşgul, geçersiz...) sonuç değişmeden kalır: ana çeviri kaybolmaz. Dönen: düzeltilen kelime sayısı."""
    suspects = _tr_find_suspects(lines, results)
    if not suspects:
        return 0
    distinct = {}
    for r_index, k, word in suspects:
        distinct.setdefault(word, lines[results[r_index]["i"]])
    words = list(distinct)
    fixes = {}
    for start in range(0, len(words), TRANSLATE_FIX_BATCH):
        batch = [{"word": w, "context": distinct[w]} for w in words[start:start + TRANSLATE_FIX_BATCH]]
        feedback = ""
        for _ in range(TRANSLATE_RETRIES + 1):
            system, user = _tr_fix_prompt(batch, feedback)
            try:
                answers = _tr_fix_parse(call(system, user, _tr_fix_schema(len(batch))), batch)
            except TranslateInvalid as problem:
                feedback = problem.message
                continue
            except TranslateError as problem:                     # meşgul/reddedildi: düzeltmeyi atla
                print(f"[ceviri] telaffuz duzeltme atlandi: {problem.message}")
                return 0
            fixes.update({item["word"]: answer for item, answer in zip(batch, answers)})
            break
    changed = 0
    for r_index, k, word in suspects:
        answer = fixes.get(word)
        if not answer or answer.lower() == word:
            continue
        result = results[r_index]
        parts = TRANSLATE_PRON_STRIP_RE.sub(" ", result["pr"]).split()
        parts[k] = answer[:1].upper() + answer[1:] if parts[k][:1].isupper() else answer
        result["pr"] = " ".join(parts)
        changed += 1
    return changed


def _tr_missing_reading(lines: list, items: dict) -> list:
    """Çevirisi var ama telaffuzu olmayan satırların (İngilizce) İLK geçtiği dizinler: "Okunuşu ekle" bunları işler."""
    seen, out = set(), []
    for i, text in enumerate(lines):
        h = _tr_hash(text)
        item = items.get(h) or {}
        if h in seen or not item.get("tr") or item.get("pr"):
            continue
        seen.add(h)
        out.append(i)
    return out


TRANSLATE_SRC_WORD_RE = re.compile(r"[A-Za-z]+(?:['\u2019][A-Za-z]+)*")
TRANSLATE_PRON_STRIP_RE = re.compile(r"[,.;:!?\"()\[\]]")


def _tr_unify_pron(lines: list, items: dict) -> int:
    """Aynı İngilizce kelimenin telaffuzu şarkı boyunca TEK yazımda olsun. Kelime sayısı kaynakla tutan satırlarda
    kaynak kelime -> telaffuz kelimesi eşlenir; en sık yazım (eşitlikte ilk görülen) kanonik olur ve o kelimenin
    farklı yazıldığı satırlar düzeltilir (satır başı büyük harfi korunur). Dönen: düzeltilen kelime sayısı."""
    seen_items, aligned, counts, order = set(), [], {}, {}
    for text in lines:
        item = items.get(_tr_hash(text))
        if not item or not item.get("pr") or id(item) in seen_items:
            continue
        src = [w.lower() for w in TRANSLATE_SRC_WORD_RE.findall(text)]
        words = TRANSLATE_PRON_STRIP_RE.sub(" ", item["pr"]).split()
        if not src or len(src) != len(words):
            continue
        seen_items.add(id(item))
        aligned.append((item, src, words))
        for s_word, p_word in zip(src, words):
            spelling = p_word.lower()
            bucket = counts.setdefault(s_word, {})
            bucket[spelling] = bucket.get(spelling, 0) + 1
            order.setdefault((s_word, spelling), len(order))
    canonical = {w: max(b, key=lambda sp: (not _tr_suspect(w, sp), b[sp], -order[(w, sp)])) for w, b in counts.items()}
    changed = 0
    for item, src, words in aligned:
        fixed = []
        for index, (s_word, p_word) in enumerate(zip(src, words)):
            canon = canonical[s_word]
            if p_word.lower() == canon:
                fixed.append(p_word)
                continue
            fixed.append(canon[:1].upper() + canon[1:] if p_word[:1].isupper() and index == 0 else canon)
            changed += 1
        item["pr"] = " ".join(fixed)
    return changed


def _tr_prompt(lang: str, lines: list, indices: list, want_reading: bool, feedback: str = "",
               reading_only: bool = False) -> tuple:
    """(sistem metni, kullanıcı metni). Tüm şarkı numaralı satırlarla BAĞLAM; yalnız `indices` istenir.
    want_reading: ja'da hiragana okuma (`rd`), en'de Türkçe harflerle telaffuz (`pr`). reading_only: çeviri YOK,
    yalnız okuma/telaffuz (çevirisi olan şarkıya sonradan okunuş eklemek için)."""
    source = TRANSLATE_LANG_NAMES.get(lang, lang)
    if reading_only:
        system = ("You write pronunciation guides for song lyrics for Turkish speakers. Do NOT translate. "
                  "You process ONE song, line by line.\nRules:\n"
                  "- One output item per requested line; never merge, split, reorder, skip or add lines.\n")
    else:
        system = (
            "You are a professional song-lyrics translator into Turkish. You translate ONE song, line by line.\n"
            "Rules:\n"
            "- Read the WHOLE song first so each line is translated in context (who speaks, tone, repeated refrains).\n"
            "- Write natural, fluent, poetic-but-plain Turkish that conveys the MEANING. Never translate word for word: "
            "adapt idioms and figures of speech to equivalent Turkish expressions.\n"
            "- One output item per requested line; never merge, split, reorder, skip or add lines. Keep each line short.\n"
            "- Identical source lines must get identical translations.\n"
            "- Keep proper names. Interjections or vocables (ah, la la, oh) may stay as they are.\n"
            "- Do not add explanations, numbering, quotes or notes inside the translation text.\n"
        )
    fields = [] if reading_only else ['"tr": "<Turkish translation>"']
    if want_reading and lang == "ja":
        system += (
            "- Also give, in `rd`, the reading of the line written ONLY in hiragana (katakana loanwords in hiragana too, "
            "no kanji, no romaji): the way it is actually SUNG, including poetic readings of kanji. Keep spaces between words.\n"
        )
        fields.append('"rd": "<hiragana reading>"')
    elif want_reading and lang == "en":
        system += (
            "- Also give, in `pr`, how the English line is SUNG/pronounced, written with Turkish letters only so that a "
            f"Turkish speaker can read it aloud (example: '{TRANSLATE_PRON_EXAMPLE[0]}' -> '{TRANSLATE_PRON_EXAMPLE[1]}'). "
            "Use ONLY letters of the Turkish alphabet (a b c ç d e f g ğ h ı i j k l m n o ö p r s ş t u ü v y z; "
            "no w, x, q and no accents like ê or â: v for w, ks for x) and approximate English sounds "
            "(th -> t/d/s, ng -> ng). Write exactly ONE pronunciation word per English word, so both "
            "lines have the same number of words; keep spaces between words; no punctuation, no digits. Capitalize only "
            "the first letter of the line. IMPORTANT: spell EVERY English word the SAME way every time it appears in the "
            "song (same word -> same Turkish spelling), including inside refrains.\n"
        )
        fields.append('"pr": "<Turkish-letter pronunciation>"')
    wanted = ", ".join(str(i) for i in indices)
    numbered = "\n".join(f"{i}: {text}" for i, text in enumerate(lines))
    user = (
        f"Song language: {source}.\nFull lyrics (line number: text):\n{numbered}\n\n"
        f"Return a JSON array with exactly {len(indices)} objects, one for each of these line numbers, in this order: {wanted}.\n"
        'Each object: {"i": <line number>' + "".join(", " + f for f in fields) + "}."
    )
    if feedback:
        user += f"\n\nYour previous answer was rejected: {feedback}\nFix it and answer again."
    return system, user


def _tr_schema(count: int, want_reading: bool, lang: str = "ja", reading_only: bool = False) -> dict:
    props = {"i": {"type": "INTEGER"}}
    required = ["i"]
    if not reading_only:
        props["tr"] = {"type": "STRING"}
        required.append("tr")
    if want_reading:
        key = "pr" if lang == "en" else "rd"
        props[key] = {"type": "STRING"}
        required.append(key)
    return {"type": "ARRAY", "minItems": count, "maxItems": count,
            "items": {"type": "OBJECT", "properties": props, "required": required}}


def _tr_parse(text: str, lines: list, indices: list, want_reading: bool, lang: str = "ja",
              reading_only: bool = False) -> list:
    """Model çıktısını doğrular. Dönen: [{i, tr, rd?|pr?}] (indices sırasında; reading_only'de tr yok).
    Geçersizse TranslateInvalid."""
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        raise TranslateInvalid("JSON degil")
    if isinstance(data, dict):
        for key in ("translations", "lines", "items", "result"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise TranslateInvalid("JSON dizisi degil")
    if len(data) != len(indices):
        raise TranslateInvalid(f"{len(indices)} oge beklendi, {len(data)} geldi")
    out = []
    for expected, item in zip(indices, data):
        if not isinstance(item, dict) or item.get("i") != expected:
            raise TranslateInvalid(f"{expected}. satirdan sonra siralama bozuk (i alani)")
        source = lines[expected]
        entry = {"i": expected}
        if not reading_only:
            tr = item.get("tr")
            if not isinstance(tr, str) or not tr.strip():
                raise TranslateInvalid(f"{expected}. satir bos")
            tr = " ".join(tr.split())
            if TRANSLATE_NUMBERING_RE.match(tr) and not TRANSLATE_NUMBERING_RE.match(source):
                raise TranslateInvalid(f"{expected}. satir numarayla basliyor")
            if len(tr) > 4 * len(source) + 40:
                raise TranslateInvalid(f"{expected}. satir kaynaktan cok uzun")
            entry["tr"] = tr
        if want_reading and lang == "en":
            pr = item.get("pr")
            pr = _tr_clean_pron(pr) if isinstance(pr, str) else ""
            if reading_only and not pr:
                raise TranslateInvalid(f"{expected}. satirin telaffuzu bos")
            if pr and len(pr) <= 3 * len(source) + 20 and not TRANSLATE_NUMBERING_RE.match(pr):
                entry["pr"] = pr                           # geçersiz telaffuz yalnız o satırın okunuşunu atar
            elif reading_only:
                raise TranslateInvalid(f"{expected}. satirin telaffuzu gecersiz")
        elif want_reading:
            rd = item.get("rd")
            rd = " ".join(rd.split()) if isinstance(rd, str) else ""
            if rd and not TRANSLATE_KANJI_RE.search(rd):       # kanjili okuma geçersiz: yalnız o okuma atılır
                entry["rd"] = rd
        out.append(entry)
    return out


def _tr_gemini_text(raw: bytes) -> str:
    """generateContent cevabından metni alır; engel/kesilme TranslateRefused/TranslateInvalid."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise TranslateInvalid("Gemini cevabi JSON degil")
    block = (data.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise TranslateRefused("Model bu şarkıyı çevirmeyi reddetti.")
    candidates = data.get("candidates") or []
    if not candidates:
        raise TranslateRefused("Model bu şarkıyı çevirmeyi reddetti.")
    cand = candidates[0]
    reason = str(cand.get("finishReason") or "")
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict) and not part.get("thought"))
    if reason in ("SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII") and not text.strip():
        raise TranslateRefused("Model bu şarkıyı çevirmeyi reddetti.")
    if reason == "MAX_TOKENS":
        raise TranslateInvalid("cikti kesildi (MAX_TOKENS)")
    if not text.strip():
        raise TranslateInvalid("bos cevap")
    return text


def _tr_http_post(url: str, headers: dict, body: bytes, timeout: float = TRANSLATE_TIMEOUT) -> tuple:
    """(durum, bayt). Ağ hatası/zaman aşımı durum 0 (yeniden denenebilir) sayılır."""
    import urllib.error
    import urllib.request

    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.read()
        except Exception:
            return error.code, b""
    except Exception:
        return 0, b""


def _tr_call(api_key: str, models: list, system: str, user: str, schema: dict,
             http=None, sleep=time.sleep, used: list = None) -> str:
    """Gemini'ye bir istek: 429/503 (ve ağ/5xx) -> kısa bekleyip yeniden, olmazsa SONRAKİ (daha hafif)
    modele; model yoksa (404) hemen sonrakine; hepsi olmazsa TranslateBusy. Dönen: cevap metni.
    `used`: kullanılan model adı buraya eklenir."""
    http = http or _tr_http_post
    headers = {"Content-Type": "application/json", "x-goog-api-key": api_key}
    body = json.dumps({
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 16384,
                             "responseMimeType": "application/json", "responseSchema": schema},
        "safetySettings": [{"category": f"HARM_CATEGORY_{name}", "threshold": "BLOCK_NONE"}
                           for name in ("HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT")],
    }).encode("utf-8")
    for model in models:
        for attempt in range(len(TRANSLATE_WAITS) + 1):
            began = time.time()
            status, raw = http(TRANSLATE_API.format(model=model), headers, body)
            print(f"[ceviri] istek {model} #{attempt}: HTTP {status}, {round(time.time() - began, 1)} sn")
            if status == 200:
                if used is not None:
                    used.append(model)
                return _tr_gemini_text(raw)
            if status in (400, 401, 403):
                detail = raw[:200].decode("utf-8", "replace") if raw else ""
                if status == 400 and "API key" not in detail and "API_KEY" not in detail:
                    raise TranslateInvalid(f"Gemini istegi reddetti (400): {detail}")
                raise TranslateAuth("Çeviri anahtarı kabul edilmedi (Modal secret'ını kontrol et).")
            print(f"[ceviri] {model}: HTTP {status} {raw[:160].decode('utf-8', 'replace') if raw else ''}")
            if status == 404:
                break                                     # model yok/kaldırıldı: sonraki model
            # 429, 5xx, ağ hatası (0): kısa bekle, aynı modelde yeniden
            if attempt < len(TRANSLATE_WAITS):
                sleep(TRANSLATE_WAITS[attempt])
                continue
            break
    raise TranslateBusy(TRANSLATE_BUSY_MESSAGE)


def _tr_run(lang: str, lines: list, indices: list, want_reading: bool, call, reading_only: bool = False) -> list:
    """`indices` satırlarını çevirir. call(system, user, schema) -> metin. Önce hepsi tek istekte (geçersizse
    geri bildirimle TRANSLATE_RETRIES kez), olmazsa TRANSLATE_CHUNK'lık parçalar (her biri aynı kurallarla).
    Dönen: [{i, tr, rd?}]; olmazsa TranslateInvalid (ya da call'ın Busy/Refused/Auth'u)."""
    def attempt(part: list) -> list:
        feedback = ""
        for _ in range(TRANSLATE_RETRIES + 1):
            system, user = _tr_prompt(lang, lines, part, want_reading, feedback, reading_only)
            try:
                return _tr_parse(call(system, user, _tr_schema(len(part), want_reading, lang, reading_only)),
                                 lines, part, want_reading, lang, reading_only)
            except TranslateInvalid as problem:
                feedback = problem.message
        raise TranslateInvalid(feedback)

    try:
        return attempt(indices)
    except TranslateInvalid:
        if len(indices) <= TRANSLATE_CHUNK:
            raise TranslateInvalid("Model satır sayısını tutturamadı, tekrar dene.")
    out = []
    for start in range(0, len(indices), TRANSLATE_CHUNK):
        try:
            out.extend(attempt(indices[start:start + TRANSLATE_CHUNK]))
        except TranslateInvalid:
            raise TranslateInvalid("Model satır sayısını tutturamadı, tekrar dene.")
    return out


_KANA_BASE = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "を": "o", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ゔ": "vu", "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
}
_KANA_COMBO = {"ゃ": "ya", "ゅ": "yu", "ょ": "yo"}
_KANA_FOREIGN = {  # ぃ/ぇ/ぁ/ぉ ile kurulan yabancı sesler (ふぁ, てぃ, でぃ, うぃ ...)
    "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo", "てぃ": "ti", "でぃ": "di", "うぃ": "wi", "うぇ": "we",
    "うぉ": "wo", "ゔぁ": "va", "ゔぃ": "vi", "ゔぇ": "ve", "ゔぉ": "vo", "しぇ": "she", "じぇ": "je", "ちぇ": "che",
    "つぁ": "tsa", "つぃ": "tsi", "つぇ": "tse", "つぉ": "tso", "いぇ": "ye", "とぅ": "tu", "どぅ": "du",
}


def _tr_kana_romaji(text: str):
    """Hiragana/katakana -> Hepburn romaji, SÖZLÜKSÜZ (Gemini'nin okuma kanasını bölütlemeden çevirir; boşluklar
    korunur). っ sonraki ünsüzü ikiler, ー önceki ünlüyü uzatır (ikiler), tek başına duran は -> wa, へ -> e,
    を -> o. Kana olmayan karakterler olduğu gibi geçer. Boş/çevrilemezse None."""
    chars = []
    for ch in str(text or ""):
        code = ord(ch)
        chars.append(chr(code - 0x60) if 0x30A1 <= code <= 0x30F6 else ch)    # katakana -> hiragana
    out, i, n = [], 0, len(chars)
    sokuon = False
    while i < n:
        ch = chars[i]
        pair = ch + chars[i + 1] if i + 1 < n else ""
        piece = None
        step = 1
        if pair in _KANA_FOREIGN:
            piece, step = _KANA_FOREIGN[pair], 2
        elif ch in _KANA_BASE and i + 1 < n and chars[i + 1] in _KANA_COMBO and ch not in "あいうえおぁぃぅぇぉんをゔ":
            base = _KANA_BASE[ch]
            combo = _KANA_COMBO[chars[i + 1]]
            if base.endswith("i"):
                stem = base[:-1]
                piece = (stem + combo[1:]) if stem in ("sh", "ch", "j") else stem + combo
            else:
                piece = base + combo
            step = 2
        elif ch == "っ":
            sokuon = True
            i += 1
            continue
        elif ch == "ー":
            for back in range(len(out) - 1, -1, -1):
                if out[back] and out[back][-1] in "aiueo":
                    out.append(out[back][-1])
                    break
            i += 1
            continue
        elif ch in ("は", "へ") and (i == 0 or chars[i - 1].isspace()) and (i + 1 == n or chars[i + 1].isspace()):
            piece = "wa" if ch == "は" else "e"
        elif ch in _KANA_BASE:
            piece = _KANA_BASE[ch]
        if piece is None:
            out.append(ch)
            sokuon = False
            i += 1
            continue
        if sokuon:
            piece = ("t" + piece) if piece.startswith("ch") else piece[0] + piece        # tchi / kka / sshi
            sokuon = False
        out.append(piece)
        i += step
    result = " ".join("".join(out).split())
    return (result[:1].upper() + result[1:]) if result else None


def _tr_hira(text: str) -> str:
    return "".join(chr(ord(ch) - 0x60) if 0x30A1 <= ord(ch) <= 0x30F6 else ch for ch in str(text or ""))


def _tr_tokens(tagger, text: str) -> list:
    """fugashi/unidic ile sözcük listesi: [{reading (hiragana), attach (öncekine yapışır mı)}]. Yapışanlar: yardımcı
    fiil, ek, bağlaç eki (て/で/ば), ve て'den sonra gelen yardımcı fiiller (いる/しまう): cutlet'in boşluk mantığına yakın."""
    out = []
    for word in tagger(text):
        feature = word.feature
        kana = getattr(feature, "kana", None)
        if not kana or kana == "*":
            kana = word.surface
        pos1 = getattr(feature, "pos1", "") or ""
        pos2 = getattr(feature, "pos2", "") or ""
        attach = pos1 in ("助動詞", "接尾辞") or (pos1 == "助詞" and pos2 == "接続助詞") \
            or (pos1 == "動詞" and pos2 == "非自立可能")
        out.append({"reading": _tr_hira(kana), "attach": attach})
    return out


def _tr_map_index(opcodes, p: int) -> int:
    """Sözlük okumasındaki (a) konumu p'yi Gemini okumasındaki (b) konuma taşır (difflib işlem listesiyle)."""
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal" and i1 <= p <= i2:
            return j1 + (p - i1)
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "replace" and i1 <= p <= i2 and i2 > i1:
            return j1 + round((p - i1) / (i2 - i1) * (j2 - j1))
        if tag in ("delete", "insert") and i1 <= p <= i2:
            return j1
    return -1


def _tr_space_kana(kana: str, tokens: list):
    """Gemini'nin hiragana okumasına sözcük sınırları koyar: sınırlar fugashi sözcüklerinden (sözlük okumasına
    hizalanıp Gemini okumasına taşınır), Gemini'nin kendi boşlukları da korunur. Dönen: (boşluklu kana, benzerlik 0-1)."""
    import difflib

    given = _tr_hira(kana)
    plain = "".join(given.split())
    if not plain:
        return "", 0.0
    word_starts, acc = [], 0
    reading = ""
    for token in tokens:
        piece = token["reading"].replace(" ", "")
        if not piece:
            continue
        if reading and not token["attach"]:
            word_starts.append(acc)
        reading += piece
        acc += len(piece)
    matcher = difflib.SequenceMatcher(None, reading, plain, autojunk=False)
    ratio = matcher.ratio()
    opcodes = matcher.get_opcodes()
    cuts = set()
    for start in word_starts:
        mapped = _tr_map_index(opcodes, start)
        if 0 < mapped < len(plain):
            cuts.add(mapped)
    count = 0                                          # Gemini'nin kendi boşlukları (boşluksuz dizideki konum)
    for ch in given:
        if ch.isspace():
            if 0 < count < len(plain):
                cuts.add(count)
        else:
            count += 1
    out = []
    for position, ch in enumerate(plain):
        if position in cuts:
            out.append(" ")
        out.append(ch)
    return "".join(out), ratio


TRANSLATE_READING_MIN_RATIO = 0.5                      # Gemini okuması sözlük okumasından bu kadar uzaksa güvenilmez -> cutlet


def _tr_reading_romaji(kana: str, tokens=None):
    """Gemini okumasından (söylendiği gibi) romaji. `tokens` (fugashi) varsa sözcük sınırları oradan; okuma sözlük
    okumasıyla %50'den az örtüşüyorsa None (çağıran cutlet'e düşer). Tokens yoksa Gemini'nin kendi boşlukları."""
    if tokens:
        spaced, ratio = _tr_space_kana(kana, tokens)
        if ratio < TRANSLATE_READING_MIN_RATIO:
            return None
        return _tr_kana_romaji(spaced)
    return _tr_kana_romaji(kana)


def _tr_romaji(katsu, text: str):
    try:
        value = " ".join(str(katsu.romaji(text)).split())
        return value or None
    except Exception:
        return None


def _tr_apply(items: dict, lines: list, results: list, lang: str, katsu=None) -> dict:
    """Sonuçları hash'e göre `items`e işler. ja'da okunuş: `ro` = cutlet(metin) (yedek), `rg` = Gemini hiraganası, sözcük
    sınırları fugashi'den, sözlüksüz Hepburn (esas; yoksa/tutmuyorsa görünümde `ro`ya düşülür)."""
    for result in results:
        text = lines[result["i"]]
        if "tr" not in result:                                  # yalnız okunuş (çeviri korunur)
            entry = dict(items.get(_tr_hash(text)) or {})
            if result.get("pr"):
                entry["pr"] = result["pr"]
            if entry.get("tr"):
                items[_tr_hash(text)] = entry
            continue
        entry = {"tr": result["tr"]}
        if lang == "en" and result.get("pr"):
            entry["pr"] = result["pr"]
        if lang == "ja":
            if result.get("rd"):
                entry["rd"] = result["rd"]
            if katsu is not None:
                ro = _tr_romaji(katsu, text)
                if ro:
                    entry["ro"] = ro
            if result.get("rd"):
                tokens = None
                if katsu is not None and getattr(katsu, "tagger", None) is not None:
                    try:
                        tokens = _tr_tokens(katsu.tagger, text)
                    except Exception:
                        tokens = None
                rg = _tr_reading_romaji(result["rd"], tokens)
                if rg:
                    entry["rg"] = rg
        items[_tr_hash(text)] = entry
    if lang == "en":
        fixed = _tr_unify_pron(lines, items)
        if fixed:
            print(f"[ceviri] telaffuz tutarliligi: {fixed} kelime duzeltildi")
    return items


def _tr_lines_view(lines: list, items: dict) -> tuple:
    """Sözlerin güncel satırlarına göre çeviri listesi: [{tr, ro?}|None], eksik satır sayısı."""
    view, missing = [], 0
    for text in lines:
        item = items.get(_tr_hash(text))
        if item and item.get("tr"):
            entry = {"tr": item["tr"]}
            romaji = item.get("rg") or item.get("ro") or item.get("pr")   # ja: B (Gemini) esas, A (cutlet) yedek; en: telaffuz
            if romaji:
                entry["ro"] = romaji
            view.append(entry)
        else:
            view.append(None)
            missing += 1
    return view, missing


def _tr_models() -> list:
    primary = os.environ.get("GEMINI_MODEL") or TRANSLATE_DEFAULT_MODEL
    fallback = os.environ.get("GEMINI_FALLBACK_MODEL") or TRANSLATE_DEFAULT_FALLBACK
    return [primary] if fallback == primary else [primary, fallback]


translate_image = light_image.pip_install("cutlet==0.5.2", "fugashi==1.5.2", "unidic-lite==1.0.8")


@app.function(
    image=translate_image,
    volumes={DATA_DIR: volume},
    secrets=[modal.Secret.from_name(TRANSLATE_SECRET_NAME, required_keys=["GEMINI_API_KEY"])],
    timeout=900,
    max_containers=2,
)
def translate_lyrics(song_id: str, replace: bool = False, mode: str = "full") -> dict:
    """Sözlerin çevirisini (ve okunuşunu: ja hiragana->romaji, en Türkçe harfli telaffuz) üretir/tamamlar. CPU.
    mode "reading": çeviriye DOKUNMADAN yalnız eksik telaffuzu ekler (İngilizce). Sonuç `translation.json` + `status.translation`."""
    started = time.time()
    volume.reload()
    song_dir = _song_dir(song_id)
    try:
        doc = json.loads((song_dir / "lyrics.json").read_text(encoding="utf-8"))
        lang = doc.get("language")
        lines = [str(line.get("text") or "") for line in doc.get("lines") or []]
        if lang not in TRANSLATE_LANGS or not lines:
            raise TranslateInvalid("Bu şarkının sözleri çevrilemez.")
        path = song_dir / "translation.json"
        items = {}
        if path.exists() and not replace:
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
                if old.get("lang") == lang:
                    items = dict(old.get("items") or {})
            except (OSError, ValueError):
                items = {}
        reading_only = mode == "reading"
        if reading_only and lang != "en":
            raise TranslateInvalid("Okunuş ekleme yalnız İngilizce için.")
        todo = _tr_missing_reading(lines, items) if reading_only else _tr_missing(lines, items)
        used = []
        katsu = None
        if lang == "ja":
            try:
                import cutlet

                katsu = cutlet.Cutlet()
                katsu.use_foreign_spelling = False          # katakana dış sözcükleri İngilizceye çevirme
            except Exception as error:
                print(f"[ceviri] cutlet yuklenemedi: {type(error).__name__}: {error}")
        if todo:
            key = os.environ["GEMINI_API_KEY"]
            models = _tr_models()
            ask = lambda system, user, schema: _tr_call(key, models, system, user, schema, used=used)
            results = _tr_run(lang, lines, todo, lang in ("ja", "en"), ask, reading_only)
            if lang == "en":
                fixed = _tr_fix_pron(lines, results, ask)          # kaynakla aynı kalan kelimeler, tutarlılıktan ÖNCE
                if fixed:
                    print(f"[ceviri] supheli telaffuz: {fixed} kelime yeniden soruldu ve duzeltildi")
            items = _tr_apply(items, lines, results, lang, katsu)
        version = int(time.time())
        out = {"schema": 1, "lang": lang, "target": "tr", "version": version,
               "model": used[-1] if used else (doc_model(path) if path.exists() else None), "items": items}
        tmp = path.with_name("translation.json.tmp")
        tmp.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)                                # önce dosya (atomik), SONRA status
        view, missing = _tr_lines_view(lines, items)
        seconds = round(time.time() - started, 1)
        _write_status(song_id, translation={
            "state": "done", "lang": lang, "version": version, "lines": len(lines), "missing": missing,
            "translated_now": len(todo), "model": out["model"], "seconds": seconds,
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        print(f"[ceviri] {lang}: {len(todo)} satir cevrildi, {missing} eksik, model {out['model']}, {seconds} sn")
        return _assert_plain({"song_id": song_id, "state": "done", "lines": len(lines), "translated": len(todo),
                              "missing": missing, "seconds": seconds})
    except Exception as error:
        message = error.message if isinstance(error, TranslateError) else f"{type(error).__name__}: {error}"[:300]
        code = error.code if isinstance(error, TranslateError) else "error"
        with contextlib.suppress(Exception):
            volume.reload()
            _write_status(song_id, translation={
                "state": "error", "code": code, "message": message[:300],
                "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        print(f"[ceviri] HATA ({code}): {message}")
        return _assert_plain({"song_id": song_id, "state": "error", "code": code, "message": message[:300]})


def doc_model(path):
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("model")
    except (OSError, ValueError):
        return None


@app.function(image=light_image, secrets=[modal.Secret.from_name(TRANSLATE_SECRET_NAME, required_keys=["GEMINI_API_KEY"])],
              timeout=120)
def translate_models_run() -> list:
    """Anahtarın görebildiği, generateContent destekleyen Gemini model adları (anahtar basılmaz)."""
    import urllib.request

    request = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
                                     headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))
    return sorted(str(m.get("name", "")).replace("models/", "") for m in data.get("models", [])
                  if "generateContent" in (m.get("supportedGenerationMethods") or []) and "gemini" in str(m.get("name", "")))


@app.function(image=light_image, secrets=[modal.Secret.from_name(TRANSLATE_SECRET_NAME, required_keys=["GEMINI_API_KEY"])],
              timeout=300)
def translate_fix_run() -> dict:
    """Şüpheli telaffuz yeniden-sorma yolunu GERÇEK Gemini ile dener (SENTETİK satırlar, Volume'a yazmaz)."""
    lines = ["Nothing is the same", "They were walking in the moon light", "Time will never wait"]
    results = [{"i": 0, "tr": "a", "pr": "Nothing is the seym"}, {"i": 1, "tr": "b", "pr": "They vır vokin in the moon layt"},
               {"i": 2, "tr": "c", "pr": "Time vil nevır veyt"}]
    before = [r["pr"] for r in results]
    key, models = os.environ["GEMINI_API_KEY"], _tr_models()
    changed = _tr_fix_pron(lines, results, lambda system, user, schema: _tr_call(key, models, system, user, schema))
    return _assert_plain({"changed": changed, "before": before, "after": [r["pr"] for r in results]})


@app.local_entrypoint()
def translate_fix_check():
    """modal run backend/app.py::translate_fix_check"""
    print(translate_fix_run.remote())


@app.local_entrypoint()
def translate_models():
    """Hangi Gemini modelleri kullanılabilir: modal run backend/app.py::translate_models"""
    for name in translate_models_run.remote():
        print(name)


# --------------------------------------------------------------------------
# Miks dışa aktarma (Aşama 12)
#
# Mikserde ayarlanan hâl TEK ses dosyası olarak SUNUCUDA hazırlanır: 24-bit master
# FLAC'lardan (`master/<ad>.flac`, alt parçalar `master/sub/<ad>.flac`), tek ffmpeg
# çağrısıyla, CPU (GPU yok). İstemci mikser kurallarını (`effectiveGain`) kendisi
# hesaplayıp dosya başına HAZIR kazanç yollar; sunucu mikser kuralı bilmez, yalnız
# doğrular. Hız ve ton `rubberband` ile (Debian ffmpeg 5.1.9 --enable-librubberband,
# Rubber Band 3.1.2; canlı konteynerde ölçüldü). Çıktı `songs/<id>/exports/<hash>.<ext>`
# (şarkı silinince birlikte gider), aynı ayar = aynı hash = yeniden üretilmez, 24 saatten
# eski dosyalar silinir.
# --------------------------------------------------------------------------

EXPORT_FORMATS = ("m4a", "wav")
EXPORT_TTL_SECONDS = 24 * 3600
EXPORT_RUNNING_STALE_SECONDS = 1200
EXPORT_MIN_RATE = 0.5              # uygulamadaki hız sınırlarıyla aynı (stretch.js)
EXPORT_MAX_RATE = 1.5
EXPORT_MAX_SEMITONES = 6
EXPORT_MAX_GAIN = 2.0              # dosya başına doğrusal kazanç
EXPORT_MAX_MASTER = 1.5            # ana ses sürgüsü %150'ye kadar
EXPORT_MIN_REGION = 0.1            # sn
EXPORT_FADE_SECONDS = 0.015        # A-B bölgesi uçlarında tık sesi olmasın
# Güvenlik sınırlayıcı (karışım > 0 dBFS olabilir): WAV -0,1 dBFS; m4a -1 dBFS (AAC kodlama
# aşımı: -0,1'de ölçülen çıktı tepesi 0,0 dB'ye çıkıyordu, çalarken kırpılırdı).
EXPORT_LIMIT_BY_FORMAT = {"wav": 0.9886, "m4a": 0.8913}
EXPORT_LIMITER_ATTACK_MS = 5
# alimiter çıktıyı ileri-bakış kadar GECİKTİRİYOR (ölçüldü: attack 5 ms -> tam 219 örnek,
# 44,1 kHz'de int(attack_ms * 44.1) - 1). Telafi edilmezse dosya stem'lere ve orijinale
# göre kayar (karışım farkı +4 dB çıkmıştı).
EXPORT_LIMITER_DELAY_SAMPLES = int(EXPORT_LIMITER_ATTACK_MS * 44100 / 1000) - 1
EXPORT_LABEL_MAX = 60
EXPORT_NAME_MAX = 120
EXPORT_SAMPLE_RATE = 44100         # master FLAC'larla aynı
EXPORT_HASH_RE = re.compile(r"^[0-9a-f]{32}$")
EXPORT_PARENT = {part: group_name for group_name, cfg in SUB_GROUP_CFG.items()
                 for part in cfg["parts"]}


# --- Kanal şeridi + ortak yankı (Aşama 15, 3. oturum) ---------------------------------------
# frontend/js/fx.js ile AYNI sabitler ve AYNI impuls yanıtı algoritması (Python portu; numpy yok:
# light_image'da yok). Uygulamadaki Web Audio zinciri: fader -> bas rafı (lowshelf 120 Hz, slope 1) ->
# orta (peaking 1 kHz, Q 0,9) -> tiz rafı (highshelf 6 kHz, slope 1) -> StereoPanner -> hedef; panner
# çıkışından gönderim gain'i -> TEK ortak bara -> ConvolverNode(normalize=false) -> dönüş gain'i (seviye).
FX_VERSION = 1                     # impuls yanıtı/zincir değişirse artar (hash'e girer: eski önbellek geçersiz)
FX_EQ_LIMIT = 12.0                 # dB
FX_EQ_BANDS = (("lowshelf", 120.0, None), ("equalizer", 1000.0, 0.9), ("highshelf", 6000.0, None))
FX_DEFAULT_ROOM = {"size": 0.5, "decay": 1.6, "level": 0.5}
FX_DECAY_MIN = 0.4
FX_DECAY_MAX = 3.0
FX_IR_RATE = 44100
FX_IR_MAX_SECONDS = 3.5
FX_IR_SEEDS = (0x9E3779B1, 0x85EBCA6B)
# ffmpeg 5.1.9 afir (Debian), canlı konteynerde ölçüldü: çıkış = 2 x dry x wet x (giriş * IR); `dry` karışıma
# EKLENMİYOR (yalnız çarpan) ve 2x sabit bir çarpan var. Bu yüzden dry=wet=1 ve çıkış 0,5 ile ölçeklenir;
# export_validate "afir birim kazanç" satırı bunu her seferinde sınar (ffmpeg sürümü değişirse yakalar).
FX_AFIR_COMPENSATION = 0.5


def _fx_round_half_up(value: float) -> int:
    """JavaScript Math.round (yarım yukarı); Python round() bankacı yuvarlaması yapar."""
    import math

    return int(math.floor(value + 0.5))


def _fx_mulberry32(seed: int):
    state = seed & 0xFFFFFFFF

    def rand() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rand


def _fx_impulse(size: float, decay: float):
    """frontend/js/fx.js `makeImpulse`in birebir portu: (left, right) = float32 örnek listeleri, 44100 Hz.

    Ön gecikme + 8 erken yansıma + RT60'a göre sönen gürültü + zamanla kararan alçak geçiren; kanal başına
    ayrı PRNG akışı, kanal başına BİRİM enerji. JS<->Python eşitliği tests/test_export_gate.py'de sınanır.
    """
    import math
    from array import array

    s = min(max(float(size), 0.0), 1.0)
    d = min(max(float(decay), FX_DECAY_MIN), FX_DECAY_MAX)
    count = _fx_round_half_up(min(d * 1.15 + 0.05, FX_IR_MAX_SECONDS) * FX_IR_RATE)
    predelay = 0.004 + 0.036 * s
    late_start = _fx_round_half_up((predelay + 0.012) * FX_IR_RATE)
    out = []
    for channel in range(2):
        rand = _fx_mulberry32(FX_IR_SEEDS[channel])
        data = [0.0] * count
        lp = 0.0
        for i in range(late_start, count):
            t = (i - late_start) / FX_IR_RATE
            x = (rand() * 2 - 1) * math.exp((-6.907755 * t) / d)
            lp += (0.18 + 0.8 * math.exp(-t / 0.35)) * (x - lp)
            data[i] = lp
        for k in range(8):
            when = predelay + k * (0.009 + 0.018 * s) + rand() * 0.004
            index = _fx_round_half_up(when * FX_IR_RATE)
            sign = -1 if rand() < 0.5 else 1
            if index < count:
                data[index] += sign * 0.6 * 0.78 ** k
        energy = sum(value * value for value in data)
        scale = 1 / math.sqrt(energy) if energy > 0 else 0.0
        out.append(array("f", (value * scale for value in data)))
    return out[0], out[1]


def _fx_impulse_wav(size: float, decay: float) -> bytes:
    """IR'yi 2 kanallı, 32-bit float WAV baytlarına çevirir (ffmpeg afir'in ikinci girişi)."""
    import struct
    import sys
    from array import array

    left, right = _fx_impulse(size, decay)
    inter = array("f", bytes(8 * len(left)))
    inter[0::2] = left
    inter[1::2] = right
    if sys.byteorder == "big":
        inter.byteswap()
    payload = inter.tobytes()
    header = (b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVE"
              + b"fmt " + struct.pack("<IHHIIHH", 16, 3, 2, FX_IR_RATE, FX_IR_RATE * 8, 8, 32)
              + b"data" + struct.pack("<I", len(payload)))
    return header + payload


def _fx_pan_gains(pan: float):
    """Web Audio StereoPanner (stereo girdi): (L<-L, L<-R, R<-L, R<-R) katsayıları."""
    import math

    if pan <= 0:
        x = pan + 1
        return 1.0, math.cos(x * math.pi / 2), 0.0, math.sin(x * math.pi / 2)
    x = pan
    return math.cos(x * math.pi / 2), 0.0, math.sin(x * math.pi / 2), 1.0


def _export_fx_check(body, gains: dict) -> tuple:
    """`fx` {kanal: {pan, eq:[bas,orta,tiz], send}} ve `room` {size, decay, level} doğrular.

    Dönen: (fx, room, hata). fx yalnız nötr OLMAYAN kanalları tutar (nötr = pan 0, EQ 0, gönderim 0 = eski
    davranış), kanallar `gains`te olmalı. room yalnız bir gönderim varsa anlamlı: yoksa None (hash değişmez);
    gönderim var ama room verilmediyse varsayılan oda. İstemci değerleri zaten sınırlıyor; burada SINIR AŞILIRSA
    400 (sessizce kırpmak farklı sesi gizlerdi).
    """
    raw_fx = body.get("fx")
    raw_room = body.get("room")
    if raw_fx is None and raw_room is None:
        return None, None, None
    if raw_fx is not None and not isinstance(raw_fx, dict):
        return None, None, "fx {kanal: {pan, eq, send}} olmali"
    fx = {}
    for name, entry in (raw_fx or {}).items():
        if not isinstance(name, str) or name not in gains:
            return None, None, f"fx icin bilinmeyen ya da sessiz kanal: {str(name)[:30]}"
        if not isinstance(entry, dict):
            return None, None, f"fx ({name}) nesne olmali"
        pan, problem = _export_number(entry.get("pan", 0), -1.0, 1.0, f"pan ({name})")
        if problem:
            return None, None, problem
        send, problem = _export_number(entry.get("send", 0), 0.0, 1.0, f"send ({name})")
        if problem:
            return None, None, problem
        eq_raw = entry.get("eq", [0, 0, 0])
        if not isinstance(eq_raw, list) or len(eq_raw) != 3:
            return None, None, f"eq ({name}) 3 sayi olmali"
        eq = []
        for index, value in enumerate(eq_raw):
            number, problem = _export_number(value, -FX_EQ_LIMIT, FX_EQ_LIMIT, f"eq ({name})")
            if problem:
                return None, None, problem
            eq.append(round(number, 1))
        item = {"pan": round(pan, 2), "eq": eq, "send": round(send, 2)}
        if item["pan"] != 0 or item["send"] != 0 or any(gain != 0 for gain in eq):
            fx[name] = item
    sending = any(item["send"] > 0 for item in fx.values())
    room = None
    if sending:
        source = raw_room if raw_room is not None else {}
        if not isinstance(source, dict):
            return None, None, "room {size, decay, level} olmali"
        values = {}
        for key, low, high in (("size", 0.0, 1.0), ("decay", FX_DECAY_MIN, FX_DECAY_MAX), ("level", 0.0, 1.0)):
            number, problem = _export_number(source.get(key, FX_DEFAULT_ROOM[key]), low, high, f"room.{key}")
            if problem:
                return None, None, problem
            values[key] = round(number, 2)
        room = values
    return (dict(sorted(fx.items())) or None), room, None


def _export_is_running(status) -> bool:
    record = (status or {}).get("export") or {}
    if record.get("state") != "running":
        return False
    return (time.time() - float(record.get("started") or 0)) < EXPORT_RUNNING_STALE_SECONDS


def _export_number(value, low, high, name):
    """Sayı doğrulama: bool/NaN/sonsuz reddedilir. Dönen: (değer, hata)."""
    import math

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, f"{name} sayi olmali"
    value = float(value)
    if not math.isfinite(value) or value < low or value > high:
        return None, f"{name} {low}..{high} araliginda olmali"
    return value, None


def _export_check(body, status) -> tuple:
    """İstek gövdesini doğrular ve normalize eder. Dönen: (spec, hata ya da None).

    Kurallar: yalnız bilinen kanallar (ana stem'ler ya da DURUMU done olan grubun alt
    parçaları), kazanç 0..2, ana ses 0..1.5, hız 0.5..1.5, ton tam sayı ±6, bölge şarkı
    içinde ve >= 0.1 sn, en az bir kanal duyulmalı. Ana kanalla kendi alt parçaları BİR
    ARADA olamaz (çift sayılırdı).
    """
    if not isinstance(body, dict):
        return None, "Govde JSON nesnesi olmali"
    fmt = body.get("format", "m4a")
    if fmt not in EXPORT_FORMATS:
        return None, f"format {'/'.join(EXPORT_FORMATS)} olmali"
    raw_gains = body.get("gains")
    if not isinstance(raw_gains, dict) or not raw_gains:
        return None, "gains (kanal -> kazanc) gerekli"

    stems = set(status.get("stems") or [])
    sub_ready = set()
    for cfg in SUB_GROUP_CFG.values():
        if ((status.get(cfg["key"]) or {}).get("state")) == "done":
            sub_ready.update(cfg["parts"])

    gains = {}
    for name, value in raw_gains.items():
        if not isinstance(name, str) or not (name in stems or name in sub_ready):
            return None, f"Bilinmeyen ya da kullanilamayan kanal: {str(name)[:30]}"
        number, problem = _export_number(value, 0.0, EXPORT_MAX_GAIN, f"kazanc ({name})")
        if problem:
            return None, problem
        if number > 0:
            gains[name] = round(number, 4)
    for name in gains:
        parent = EXPORT_PARENT.get(name)
        if parent and parent in gains:
            return None, f"{parent} ile alt parcasi ({name}) birlikte karistirilamaz"
    if not gains:
        return None, "Hicbir kanal duyulmuyor"

    master, problem = _export_number(body.get("master", 1.0), 0.0, EXPORT_MAX_MASTER, "master")
    if problem:
        return None, problem
    if master <= 0:
        return None, "Ana ses sifir"
    rate, problem = _export_number(body.get("rate", 1.0), EXPORT_MIN_RATE, EXPORT_MAX_RATE, "rate")
    if problem:
        return None, problem
    semis, problem = _export_number(body.get("semitones", 0), -EXPORT_MAX_SEMITONES,
                                    EXPORT_MAX_SEMITONES, "semitones")
    if problem:
        return None, problem
    if semis != int(semis):
        return None, "semitones tam sayi olmali"
    vinyl = body.get("vinyl", False)
    if not isinstance(vinyl, bool):
        return None, "vinyl true/false olmali"
    if vinyl and semis != 0:
        return None, "plak gibi kipte ton ayri verilemez (ton hizdan gelir)"

    region = None
    raw_region = body.get("region")
    if raw_region is not None:
        if not isinstance(raw_region, dict):
            return None, "region {a, b} olmali"
        duration = float(status.get("duration") or 0)
        a, problem = _export_number(raw_region.get("a"), 0.0, max(duration, 0.0), "region.a")
        if problem:
            return None, problem
        b, problem = _export_number(raw_region.get("b"), 0.0, duration + 0.05, "region.b")
        if problem:
            return None, problem
        b = min(b, duration) if duration > 0 else b
        if b - a < EXPORT_MIN_REGION:
            return None, f"bolge en az {EXPORT_MIN_REGION} sn olmali"
        region = {"a": round(a, 3), "b": round(b, 3)}

    label = body.get("label", "")
    if not isinstance(label, str):
        return None, "label metin olmali"
    label = "".join(ch if ch >= " " else " " for ch in label)
    label = " ".join(label.split())[:EXPORT_LABEL_MAX]

    spec = {
        "format": fmt, "gains": dict(sorted(gains.items())), "master": round(master, 4),
        "region": region, "rate": round(rate, 4), "semitones": int(semis), "label": label,
        "stems_version": status.get("stems_version"),
        "sub_versions": {cfg["key"]: (status.get(cfg["key"]) or {}).get("version")
                         for cfg in SUB_GROUP_CFG.values()},
    }
    if vinyl and spec["rate"] != 1.0:
        spec["vinyl"] = True          # YALNIZ açıkken anahtar var: eski ayarların hash'i (önbellek) değişmez
    fx, room, problem = _export_fx_check(body, gains)
    if problem:
        return None, problem
    if fx:
        spec["fx"] = fx               # yalnız nötr olmayan kanallar; yoksa anahtar da yok (eski hash'ler değişmez)
        spec["fx_v"] = FX_VERSION
        if room:
            spec["room"] = room
            if not region:
                # Yankı kuyruğu: şarkı bittikten sonra oda süresi (RT60, en çok 3 sn) kadar yankı sürer (uygulamada
                # çalma şarkı bitince duruyor, dışa aktarma bilerek ayrılıyor). A-B bölgesinde YOK: bölge döngü malzemesi.
                spec["reverb_tail"] = round(min(room["decay"], FX_DECAY_MAX), 2)
    return spec, None


def _export_hash(spec: dict) -> str:
    """Ayar hash'i: aynı ayar (ve aynı kaynak sürümü) = aynı dosya."""
    canonical = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def _export_clean_part(text: str, limit: int) -> str:
    cleaned = "".join(" " if ch in _ILLEGAL_FILENAME or ord(ch) < 32 else ch for ch in (text or ""))
    return " ".join(cleaned.split()).strip(". ")[:limit]


def _export_mmss(seconds: float) -> str:
    whole = int(seconds)
    return f"{whole // 60}m{whole % 60:02d}"


def _export_tail(spec: dict) -> str:
    parts = [spec["label"] or "Miks"]
    if spec["rate"] != 1.0:
        parts.append(f"{spec['rate']:g}x" + (" plak" if spec.get("vinyl") else ""))
    if spec["semitones"]:
        parts.append(f"{spec['semitones']:+d}")
    if spec["region"]:
        parts.append(f"döngü {_export_mmss(spec['region']['a'])}-{_export_mmss(spec['region']['b'])}")
    return " - ".join(parts)


def _export_filename(title: str, spec: dict) -> str:
    """"<şarkı> - <ön ayar/etiket>[ - 0.8x][ - +2][ - döngü 1m20-1m45].<uzantı>"."""
    head = _export_clean_part(title, 80) or "sarki"
    tail = _export_clean_part(_export_tail(spec), EXPORT_NAME_MAX - len(head) - 3) or "Miks"
    return f"{head} - {tail}.{spec['format']}"


def _export_limit_tail(spec: dict) -> list:
    """Her zincirin sonu: güvenlik sınırlayıcı + gecikme telafisi (+ wav için dither)."""
    limit = EXPORT_LIMIT_BY_FORMAT[spec["format"]]
    tail = [f"alimiter=limit={limit}:attack={EXPORT_LIMITER_ATTACK_MS}:release=50:level=0"]
    tail += [f"atrim=start_sample={EXPORT_LIMITER_DELAY_SAMPLES}", "asetpts=PTS-STARTPTS"]
    if spec["format"] == "wav":
        tail.append("aresample=osf=s16:dither_method=triangular")
    return tail


def _export_finish(cmd: list, chains: list, spec: dict, title: str, out_path) -> list:
    """Filtre grafiğini, metadata'yı ve kodlayıcıyı komuta ekler."""
    cmd += ["-filter_complex", ";".join(chains), "-map", "[out]", "-map_metadata", "-1"]
    cmd += ["-metadata", f"title={title or 'Stem Mikser'}", "-metadata", "album=Stem Mikser",
            "-metadata", f"comment={_export_tail(spec)}"]
    if spec["format"] == "m4a":
        cmd += ["-c:a", "aac", "-b:a", AAC_BITRATE, "-ar", str(EXPORT_SAMPLE_RATE),
                "-movflags", "+faststart"]
    else:
        cmd += ["-c:a", "pcm_s16le", "-ar", str(EXPORT_SAMPLE_RATE)]
    cmd.append(str(out_path))
    return cmd


def _export_needs_ir(spec: dict) -> bool:
    return bool(spec.get("room"))


def _export_command(spec: dict, paths: dict, out_path, title: str = "", ir_path=None) -> list:
    """Tek ffmpeg çağrısı. paths: kanal -> YEREL dosya yolu.

    Zincir: dosya başına `volume` -> `amix` (normalize=0: kazançlar toplanır, bölünmez)
    -> ana ses -> [A-B kırpma + 15 ms fade] -> [rubberband: hız/ton] -> alimiter (-0,1 dBFS).
    Kırpma esnetmeden ÖNCE: bölge şarkı saniyesi, çıktı süresi bölge / hız.
    Kanal şeridi (pan/EQ/yankı) varsa `_export_command_fx` (uygulamadaki sıra: hız -> şerit -> yankı -> ton).
    """
    if spec.get("fx"):
        return _export_command_fx(spec, paths, out_path, title, ir_path)
    names = list(spec["gains"])
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
    for name in names:
        cmd += ["-i", str(paths[name])]
    chains = [f"[{i}:a]volume={spec['gains'][name]:.4f}[a{i}]" for i, name in enumerate(names)]
    joined = "".join(f"[a{i}]" for i in range(len(names)))
    if len(names) > 1:
        chains.append(f"{joined}amix=inputs={len(names)}:normalize=0:duration=longest[mix]")
    else:
        chains.append(f"{joined}anull[mix]")

    tail = [f"volume={spec['master']:.4f}"]
    region = spec["region"]
    if region:
        length = region["b"] - region["a"]
        tail += [
            f"atrim=start={region['a']:.3f}:end={region['b']:.3f}",
            "asetpts=PTS-STARTPTS",
            f"afade=t=in:d={EXPORT_FADE_SECONDS}",
            f"afade=t=out:st={max(length - EXPORT_FADE_SECONDS, 0):.3f}:d={EXPORT_FADE_SECONDS}",
        ]
    if spec.get("vinyl"):
        # PLAK GİBİ: hız ve ton BAĞLI (uygulamadaki playbackRate ile aynı mantık): örnekleri daha hızlı/yavaş
        # yorumla, sonra 44,1 kHz'e yeniden örnekle. Rubberband YOK. Bölge kırpma yukarıda (şarkı saniyesinde).
        tail.append(f"asetrate={EXPORT_SAMPLE_RATE * spec['rate']:.4f}")
        tail.append(f"aresample={EXPORT_SAMPLE_RATE}")
    elif spec["rate"] != 1.0 or spec["semitones"]:
        pitch = 2 ** (spec["semitones"] / 12)
        # transients=smooth: ölçüm (saf ton, 5 frekans x 8 hız/ton durumu) varsayılan "crisp" ve
        # "mixed" kipte perdeyi 76 sente (%4) kadar kaydırıyor, "smooth" en kötü 0,4 sent.
        # Bedel: davul vuruşları esnetmede biraz yumuşar (kulak testi).
        stretch = (f"rubberband=tempo={spec['rate']:.4f}:pitch={pitch:.6f}:pitchq=quality:"
                   "channels=together:transients=smooth")
        if spec["semitones"]:
            stretch += ":formant=preserved"     # ton kaydırmada vokal tınısı çok değişmesin
        tail.append(stretch)
    tail += _export_limit_tail(spec)
    chains.append("[mix]" + ",".join(tail) + "[out]")
    return _export_finish(cmd, chains, spec, title, out_path)


def _export_strip_chain(spec: dict, name: str) -> tuple:
    """Bir kanalın şerit zinciri (giriş etiketi hariç) ve gönderim var mı. Sıra uygulamadakiyle aynı:
    [A-B kırpma] -> [hız: asetrate+aresample] -> fader -> bas -> orta -> tiz -> pan."""
    parts = []
    region = spec["region"]
    if region:
        parts += [f"atrim=start={region['a']:.3f}:end={region['b']:.3f}", "asetpts=PTS-STARTPTS"]
    if spec["rate"] != 1.0:
        # Uygulamada kaynaklar playbackRate ile çalıyor ve EQ/pan/yankı HIZLANMIŞ sinyali işliyor; sunucu da
        # kanal başına önce hızı uygular (EQ frekansları ve yankı gerçek saniyede kalır).
        parts += [f"asetrate={EXPORT_SAMPLE_RATE * spec['rate']:.4f}", f"aresample={EXPORT_SAMPLE_RATE}"]
    parts.append(f"volume={spec['gains'][name]:.4f}")
    fx = spec["fx"].get(name)
    if fx:
        parts.append("aformat=sample_fmts=dblp:channel_layouts=stereo")      # çift duyarlıklı biquad
        for (kind, frequency, q), gain in zip(FX_EQ_BANDS, fx["eq"]):
            if gain == 0:
                continue                                                     # 0 dB = kimlik filtresi
            if q is None:
                parts.append(f"{kind}=f={frequency:g}:t=s:w=1:g={gain:g}")   # slope 1 (Web Audio ile aynı RBJ S=1)
            else:
                parts.append(f"{kind}=f={frequency:g}:t=q:w={q:g}:g={gain:g}")
        if fx["pan"] != 0:
            ll, lr, rl, rr = _fx_pan_gains(fx["pan"])
            parts.append(f"pan=stereo|c0={ll:.10f}*c0+{lr:.10f}*c1|c1={rl:.10f}*c0+{rr:.10f}*c1")
    return parts, bool(fx and fx["send"] > 0)


def _export_command_fx(spec: dict, paths: dict, out_path, title: str = "", ir_path=None) -> list:
    """Kanal şeridi (pan/EQ/gönderim) + ortak yankı olan zincir. Uygulamadaki sıra:

      kanal başına: [A-B kırpma] -> [asetrate+aresample hız] -> volume -> lowshelf -> equalizer -> highshelf -> pan
        -> kuru toplama   +   gönderim: volume=send -> gönderim toplamı -> afir(IR) -> volume=seviye -> ıslak
      kuru + ıslak -> ana ses -> [15 ms fade] -> [rubberband YALNIZ ton düzeltmesi: pitch = 2^(ton/12)/hız, tempo 1]
      -> alimiter.

    Plak gibi kipte rubberband HİÇ yok. Yankı hızlandırılmış sinyale gerçek saniyede uygulanır (IR ölçeklenmez).
    Çıktı süresi girişle aynı; yalnız `reverb_tail` varsa (yankı kullanılıyor, A-B bölgesi yok) o kadar sn uzar.
    """
    names = list(spec["gains"])
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
    for name in names:
        cmd += ["-i", str(paths[name])]
    room = spec.get("room")
    if room:
        if ir_path is None:
            raise ValueError("yankı için IR dosyası gerekli")
        cmd += ["-i", str(ir_path)]
    chains = []
    dry_labels = []
    send_labels = []
    for i, name in enumerate(names):
        parts, sending = _export_strip_chain(spec, name)
        if sending:
            chains.append(f"[{i}:a]" + ",".join(parts) + f",asplit=2[d{i}][s{i}]")
            chains.append(f"[s{i}]volume={spec['fx'][name]['send']:.4f}[w{i}]")
            send_labels.append(f"[w{i}]")
        else:
            chains.append(f"[{i}:a]" + ",".join(parts) + f"[d{i}]")
        dry_labels.append(f"[d{i}]")

    def summed(labels, out):
        if len(labels) > 1:
            return f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=longest[{out}]"
        return f"{labels[0]}anull[{out}]"

    chains.append(summed(dry_labels, "dry"))
    if send_labels:
        chains.append(summed(send_labels, "sendsum"))
        # Ölçüm (canlı ffmpeg 5.1.9, `export_validate` I/J satırları): afir çıkışı girişten en çok bir bölüm
        # (partition) kısa kalıyor ve PTS'i kaymış; amix ile toplayınca dosyanın SON ~1000 örneği bozuldu (kuru
        # katlandı: sıfır seviyeli yankıda bile en büyük fark 0,29) ve rubberband "Cannot process again after final
        # chunk" ile çöktü. Çözüm: afir girişi 2048 örnek sessizlikle uzatılır (ıslak, kuru uzunluğunu aşar), PTS
        # onarılır, ıslak sonsuza uzatılır (apad) ve kuruyla `amerge` + `pan` (birim katsayılı toplama) ile toplanır:
        # amerge en KISA girişte biter = kuru, yani çıktı süresi ve içerik kuruyla birebir (sıfır seviyede fark 0).
        stereo = "aformat=sample_fmts=fltp:channel_layouts=stereo"
        reverb_tail = float(spec.get("reverb_tail") or 0)
        # Kuyruk varsa kuru toplam reverb_tail sn sessizlikle uzatılır (amerge en kısa girişte biter = kuru + kuyruk),
        # afir girişi de kuyruk + 0,1 sn uzatılır ki ıslak kısım kuyruğun sonuna kadar dolsun.
        send_pad = f"apad=pad_dur={reverb_tail + 0.1:.3f}" if reverb_tail else "apad=pad_len=2048"
        dry_pad = f"apad=pad_dur={reverb_tail:.3f}," if reverb_tail else ""
        chains.append(f"[sendsum]{send_pad}[sendpad]")
        chains.append(f"[sendpad][{len(names)}:a]afir=dry=1:wet=1:gtype=none:minp=1024:maxp=1024[conv]")
        chains.append(f"[conv]asetpts=PTS-STARTPTS,volume={room['level'] * FX_AFIR_COMPENSATION:.6f},apad,{stereo}[wet]")
        chains.append(f"[dry]{dry_pad}{stereo}[dryf]")
        chains.append("[dryf][wet]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[mix]")
    else:
        chains.append("[dry]anull[mix]")

    tail = [f"volume={spec['master']:.4f}"]
    if spec["region"]:
        length = (spec["region"]["b"] - spec["region"]["a"]) / spec["rate"]
        tail += [f"afade=t=in:d={EXPORT_FADE_SECONDS}",
                 f"afade=t=out:st={max(length - EXPORT_FADE_SECONDS, 0):.3f}:d={EXPORT_FADE_SECONDS}"]
    if not spec.get("vinyl") and (spec["rate"] != 1.0 or spec["semitones"]):
        pitch = 2 ** (spec["semitones"] / 12) / spec["rate"]
        if abs(pitch - 1.0) > 1e-6:
            stretch = (f"rubberband=tempo=1:pitch={pitch:.6f}:pitchq=quality:"
                       "channels=together:transients=smooth")
            if spec["semitones"]:
                stretch += ":formant=preserved"
            tail.append(stretch)
    tail += _export_limit_tail(spec)
    chains.append("[mix]" + ",".join(tail) + "[out]")
    return _export_finish(cmd, chains, spec, title, out_path)


_VOLUMEDETECT_MAX = re.compile(r"max_volume:\s*(-?[\d.]+|-?inf)\s*dB")
_VOLUMEDETECT_MEAN = re.compile(r"mean_volume:\s*(-?[\d.]+|-?inf)\s*dB")


def _export_measure(path) -> dict:
    """Çıktının süresi, tepe ve ortalama seviyesi (dBFS). ffprobe + volumedetect."""
    probe = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                  "-of", "default=nw=1:nk=1", str(path)])
    duration = float(probe.stdout.decode("utf-8", "replace").strip() or 0.0)
    detect = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "volumedetect",
         "-f", "null", "-"], capture_output=True)
    text = detect.stderr.decode("utf-8", "replace")
    peak = _VOLUMEDETECT_MAX.search(text)
    mean = _VOLUMEDETECT_MEAN.search(text)

    def to_float(match):
        if not match:
            return None
        value = match.group(1)
        return -200.0 if value.endswith("inf") else float(value)

    return {"duration": round(duration, 3), "peak_db": to_float(peak), "mean_db": to_float(mean),
            "bytes": os.path.getsize(path)}


def _export_cleanup(song_dir: pathlib.Path, now: float = None, ttl: int = EXPORT_TTL_SECONDS) -> int:
    """songs/<id>/exports altında `ttl`'den eski dosyaları siler. Dönen: silinen sayısı."""
    now = time.time() if now is None else now
    folder = song_dir / "exports"
    if not folder.is_dir():
        return 0
    removed = 0
    for entry in folder.iterdir():
        try:
            if entry.is_file() and now - entry.stat().st_mtime > ttl:
                entry.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def _export_sources(song_dir: pathlib.Path, spec: dict) -> dict:
    """Kanal -> master FLAC yolu (alt parçalar master/sub'da). Eksikse FileNotFoundError."""
    paths = {}
    for name in spec["gains"]:
        path = song_dir / "master" / ("sub" if name in EXPORT_PARENT else "") / f"{name}.flac"
        if not path.is_file():
            raise FileNotFoundError(f"master dosyasi yok: {name}")
        paths[name] = path
    return paths


def _export_render(spec: dict, local_paths: dict, out_path, title: str = "") -> dict:
    """ffmpeg'i çalıştırıp çıktıyı ölçer. local_paths yerel dosyalar olmalı.

    Yankı varsa impuls yanıtı (uygulamayla aynı prosedürden) çıktının yanına geçici WAV olarak yazılır.
    """
    ir_path = None
    if _export_needs_ir(spec):
        ir_path = pathlib.Path(out_path).with_name("room_ir.wav")
        ir_path.write_bytes(_fx_impulse_wav(spec["room"]["size"], spec["room"]["decay"]))
    _run(_export_command(spec, local_paths, out_path, title, ir_path))
    return _export_measure(out_path)


@app.function(
    image=light_image,
    volumes={DATA_DIR: volume},
    timeout=900,
    memory=2048,
    max_containers=4,
)
def export_mix(song_id: str, digest: str, spec: dict) -> dict:
    """Mikser ayarını tek ses dosyasına çevirir. CPU; GPU yok.

    Kaynak FLAC'lar önce konteyner-yerel dizine kopyalanır (ffmpeg Volume dosyasını
    dakikalarca açık tutmasın: eşzamanlı reload patlamasın). Çıktı önce yerelde, sonra
    atomik olarak `exports/<hash>.<uzantı>`a yazılır; yanına `<hash>.json` (dosya adı, ölçümler).
    """
    started = time.time()
    volume.reload()
    song_dir = _song_dir(song_id)
    try:
        status = json.loads((song_dir / "status.json").read_text(encoding="utf-8"))
        title = str(status.get("title") or song_id[:12])
        sources = _export_sources(song_dir, spec)
        with tempfile.TemporaryDirectory() as workdir:
            work = pathlib.Path(workdir)
            local = {}
            for name, path in sources.items():
                local[name] = work / f"{name}.flac"
                with path.open("rb") as src, local[name].open("wb") as dst:
                    shutil.copyfileobj(src, dst)
            out_local = work / f"out.{spec['format']}"
            measured = _export_render(spec, local, out_local, title)
            folder = song_dir / "exports"
            folder.mkdir(parents=True, exist_ok=True)
            final = folder / f"{digest}.{spec['format']}"
            part = final.with_name(final.name + ".part")
            with out_local.open("rb") as src, part.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            os.replace(part, final)
        filename = _export_filename(title, spec)
        meta = {"hash": digest, "filename": filename, "format": spec["format"], "label": spec["label"],
                **measured, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        (folder / f"{digest}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        removed = _export_cleanup(song_dir)
        seconds = round(time.time() - started, 1)
        _write_status(song_id, export={
            "state": "done", "hash": digest, "format": spec["format"], "filename": filename,
            "bytes": measured["bytes"], "duration": measured["duration"],
            "peak_db": measured["peak_db"], "mean_db": measured["mean_db"], "seconds": seconds,
            "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        print(f"[export] {digest} {spec['format']} {measured['duration']} sn, tepe {measured['peak_db']} dB, "
              f"{seconds} sn, {removed} eski dosya silindi")
        return _assert_plain({"song_id": song_id, "hash": digest, "state": "done", **measured,
                              "seconds": seconds})
    except Exception as error:
        with contextlib.suppress(Exception):
            volume.reload()
            _write_status(song_id, export={
                "state": "error", "hash": digest, "message": f"{type(error).__name__}: {error}"[:300],
                "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        raise


@app.function(
    image=light_image,
    volumes={DATA_DIR: volume},
    schedule=modal.Period(days=1),
    timeout=900,
)
def export_sweep() -> dict:
    """Günlük süpürme: hiçbir şarkıya istek gelmese de 24 saatten eski dışa aktarmalar silinir."""
    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    removed = 0
    if root.is_dir():
        for entry in root.iterdir():
            removed += _export_cleanup(entry)
    if removed:
        volume.commit()
    print(f"[export] sweep: {removed} dosya silindi")
    return {"removed": removed}


# --------------------------------------------------------------------------
# Tarayıcı <-> sunucu fark ölçümü için SENTETİK girişler (Aşama 15, 3. oturum). Gerçek şarkı/söz YOK.
# Yerelde `tests/export_diff.py` bunlardan WAV üretir ve tarayıcıdaki GERÇEK Engine çıktısını toplar; Modal'da
# `export_diff_case` AYNI girişleri yeniden üretir (yalnız tarayıcı sonucu yüklenir: Modal'ın 2 MiB satır içi
# sınırı ve yerel TLS ara yazılımı büyük yüklemeleri engelliyor). Gürültü mulberry32 tabanlı: örnek i, i'nin saf
# fonksiyonu (vektörel), yani numpy sürümüne bağlı değil.
# --------------------------------------------------------------------------

EXPORT_DIFF_RATE = 44100
EXPORT_DIFF_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def _export_diff_uniform(np, seed: int, count: int):
    """[0,1) düzgün, mulberry32 (frontend/js/fx.js ile aynı karıştırma), örnek başına bağımsız hesap."""
    mask = np.uint64(0xFFFFFFFF)
    index = np.arange(1, count + 1, dtype=np.uint64)
    t = (np.uint64(seed & 0xFFFFFFFF) + index * np.uint64(0x6D2B79F5)) & mask
    t = ((t ^ (t >> np.uint64(15))) * (t | np.uint64(1))) & mask
    t = t ^ ((t + (((t ^ (t >> np.uint64(7))) * (t | np.uint64(61))) & mask)) & mask)
    return ((t ^ (t >> np.uint64(14))) & mask).astype(np.float64) / 4294967296.0


def _export_diff_build():
    """(senaryolar, girişler): girişler ad -> float32 (örnek, 2) dizisi. Senaryo gövdesi hem tarayıcıya
    (Engine çağrıları) hem sunucuya (dışa aktarma isteği) aynen verilir."""
    import math

    import numpy as np

    rate = EXPORT_DIFF_RATE
    streams = [0]

    def noise(seconds, sigma, lowpass=0.0):
        count = int(seconds * rate)
        data = np.empty((count, 2))
        for channel in range(2):
            streams[0] += 1
            data[:, channel] = (_export_diff_uniform(np, 0x1234567 + streams[0] * 0x9E3779B1, count) * 2 - 1) * math.sqrt(3) * sigma
        if lowpass > 0:
            # iki tek kutuplu alçak geçiren art arda (kesim ~ lowpass x 7 kHz): HF az, yeniden örnekleme çekirdeği farkı
            # (tarayıcı doğrusal aradeğerleme <-> ffmpeg sinc) ölçümü bozmasın; sonunda rms = sigma
            for channel in range(2):
                column = data[:, channel].tolist()
                for _ in range(2):
                    state = 0.0
                    for i, value in enumerate(column):
                        state += lowpass * (value - state)
                        column[i] = state
                data[:, channel] = column
            data *= sigma / float(np.sqrt(np.mean(data ** 2)))
        return data

    def tones(seconds, base, level):
        t = np.arange(int(seconds * rate)) / rate
        left = sum(np.sin(2 * np.pi * base * k * t) / k for k in (1, 2, 3))
        right = sum(np.sin(2 * np.pi * base * 1.5 * k * t + 0.5) / k for k in (1, 2, 3))
        return np.stack([left, right], axis=1) * level

    seconds = 6.0
    # yankılı senaryolar (B, D) 4 sn: kuyruk eklenince tarayıcı sonucu Modal'ın 2 MiB satır içi sınırının altında kalsın
    MIX_SECONDS = 4.0
    scenarios = []
    inputs = {"A": noise(seconds, 0.1).astype(np.float32)}

    def add(name, kind, channels, body, rate_=1.0, vinyl=False, seconds_=seconds, pair=None):
        # pair: gönderimleri kapalı İKİZ senaryo; fark = yalnız ıslak (yankı) kısım
        scenarios.append({"name": name, "kind": kind, "channels": list(channels), "body": body, "rate": rate_,
                          "vinyl": vinyl, "seconds": seconds_, "pair": pair})

    for name, fx in (
        ("eq_hi_lo", {"pan": 0, "eq": [8, -6, 9], "send": 0}),
        ("eq_mid", {"pan": 0, "eq": [0, 10, 0], "send": 0}),
        ("pan_left", {"pan": -0.35, "eq": [0, 0, 0], "send": 0}),
        ("pan_right", {"pan": 0.6, "eq": [0, 0, 0], "send": 0}),
        ("combined", {"pan": 0.6, "eq": [-7, 4, -11], "send": 0}),
    ):
        add(f"A_{name}", "response", ["A"], {"gains": {"A": 1.0}, "fx": {"A": fx}})

    for i, stem in enumerate(EXPORT_DIFF_STEMS):
        inputs[stem] = (noise(MIX_SECONDS, 0.05) + tones(MIX_SECONDS, 110 * (i + 1), 0.015)).astype(np.float32)
    mix_fx = {
        "vocals": {"pan": 0.0, "eq": [0, 3, 4], "send": 0.65},
        "drums": {"pan": -0.25, "eq": [4, 0, 0], "send": 0.5},
        "bass": {"pan": 0, "eq": [5, -2, -4], "send": 0.3},
        "guitar": {"pan": -0.8, "eq": [0, 0, 0], "send": 0.5},
        "piano": {"pan": 0.7, "eq": [-3, 2, 6], "send": 0.5},
        "other": {"pan": 0.2, "eq": [0, -5, 0], "send": 0.0},
    }
    gains = {"vocals": 1.0, "drums": 0.9, "bass": 0.8, "guitar": 1.0, "piano": 0.7, "other": 1.0}
    add("B_mix_room", "mix", EXPORT_DIFF_STEMS,
        {"gains": gains, "fx": mix_fx, "room": {"size": 0.7, "decay": 2.2, "level": 0.8}}, pair="B_mix_dry",
        seconds_=MIX_SECONDS)
    add("B_mix_dry", "mix", EXPORT_DIFF_STEMS,
        {"gains": gains, "fx": {key: dict(value, send=0) for key, value in mix_fx.items()}}, seconds_=MIX_SECONDS)

    click = np.zeros((int(4.0 * rate), 2), dtype=np.float32)
    click[int(3.5 * rate), 0] = 1.0
    click[int(3.5 * rate), 1] = 0.7
    inputs["C"] = click
    add("C_click_room", "reverb", ["C"],
        {"gains": {"C": 1.0}, "fx": {"C": {"pan": 0, "eq": [0, 0, 0], "send": 1.0}},
         "room": {"size": 0.5, "decay": 1.6, "level": 1.0}}, seconds_=4.0)

    for stem in ("vocals", "drums", "piano"):
        inputs[f"V_{stem}"] = (noise(MIX_SECONDS, 0.05, lowpass=0.06) + tones(MIX_SECONDS, 220, 0.02)).astype(np.float32)
    add("D_vinyl", "vinyl", ["V_vocals", "V_drums", "V_piano"],
        {"gains": {"V_vocals": 1.0, "V_drums": 1.0, "V_piano": 0.9},
         "fx": {"V_vocals": {"pan": 0.0, "eq": [0, 3, 0], "send": 0.65},
                "V_drums": {"pan": -0.4, "eq": [3, 0, 0], "send": 0.5},
                "V_piano": {"pan": 0.5, "eq": [0, 0, 4], "send": 0.5}},
         "room": {"size": 0.7, "decay": 2.2, "level": 0.8}, "rate": 0.85, "vinyl": True},
        rate_=0.85, vinyl=True, pair="D_vinyl_dry", seconds_=MIX_SECONDS)
    vfx = scenarios[-1]["body"]["fx"]
    add("D_vinyl_dry", "vinyl", ["V_vocals", "V_drums", "V_piano"],
        {"gains": scenarios[-1]["body"]["gains"], "fx": {key: dict(value, send=0) for key, value in vfx.items()},
         "rate": 0.85, "vinyl": True}, rate_=0.85, vinyl=True, seconds_=MIX_SECONDS)
    add("D_vinyl_plain", "vinyl", ["V_vocals", "V_drums", "V_piano"],
        {"gains": scenarios[-1]["body"]["gains"], "fx": {"V_vocals": {"pan": 0, "eq": [0, 0, 0], "send": 0}},
         "rate": 0.85, "vinyl": True}, rate_=0.85, vinyl=True, seconds_=MIX_SECONDS)
    return scenarios, inputs


def _xd_spec(channels, body, seconds, fmt="wav"):
    """Sentetik kanallar için dışa aktarma spec'i (gerçek şarkı durumu yok)."""
    status = {"stems": list(channels), "duration": float(seconds), "stems_version": 1}
    spec, problem = _export_check(dict({"format": fmt}, **body), status)
    if problem:
        raise ValueError(problem)
    return spec


def _xd_bands_db(np, a, b):
    """İki sinyalin 1/3 oktav bant enerji farkları (dB), 39 Hz .. 16 kHz: (en kötü fark, merkez Hz)."""
    size = 1 << int(np.ceil(np.log2(len(a))))
    window = np.hanning(len(a))
    spec_a = np.abs(np.fft.rfft(a * window, n=size)) ** 2
    spec_b = np.abs(np.fft.rfft(b * window, n=size)) ** 2
    freqs = np.fft.rfftfreq(size, 1 / 44100)
    worst, where = 0.0, 0.0
    for k in range(-14, 5):
        center = 1000.0 * 2 ** (k / 3)
        mask = (freqs >= center / 2 ** (1 / 6)) & (freqs < center * 2 ** (1 / 6))
        ratio = 10 * np.log10((spec_a[mask].sum() + 1e-30) / (spec_b[mask].sum() + 1e-30))
        if abs(ratio) > abs(worst):
            worst, where = float(ratio), center
    return worst, where


def _xd_lag(np, a, b, span=300):
    """a'nın b'ye göre kayması (örnek): çapraz ilinti tepesi. 0 = hizalı."""
    size = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    corr = np.fft.irfft(np.fft.rfft(a, n=size) * np.conj(np.fft.rfft(b, n=size)), n=size)
    lags = np.concatenate([np.arange(0, span + 1), np.arange(-span, 0)])
    values = np.concatenate([corr[:span + 1], corr[size - span:]])
    return int(lags[int(np.argmax(values))])


def _xd_lowpass(np, x, cutoff_hz):
    """Ani kesimli (FFT maskesi) alçak geçiren: yeniden örnekleme çekirdeği farkının HF'ten geldiğini ayırmak için."""
    spectrum = np.fft.rfft(x)
    spectrum[np.fft.rfftfreq(len(x), 1 / 44100) > cutoff_hz] = 0
    return np.fft.irfft(spectrum, n=len(x))


def _xd_residual_db(np, a, b):
    n = min(a.shape[-1], b.shape[-1])
    rms = lambda x: float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)) + 1e-12)
    return 20 * np.log10(rms(a[..., :n] - b[..., :n])) - 20 * np.log10(rms(a[..., :n]))


@app.function(image=sub_cpu_image, timeout=900, memory=4096)
def export_diff_case(name: str, result: bytes, twin_left: bytes = None) -> list:
    """Tek senaryo: tarayıcıdaki GERÇEK Engine çıktısı (int16 LE, önce sol sonra sağ) <-> sunucu zinciri (ffmpeg).

    Girişler `_export_diff_build` ile yeniden üretilir. `twin_left`: gönderimleri kapalı ikiz senaryonun tarayıcı
    çıktısı (yalnız sol kanal, int16): fark = YALNIZ ıslak (yankı) kısım, hizası ve enerjisi ayrıca ölçülür.
    Dönen: [{name, ok, detail}].
    """
    import numpy as np
    import soundfile as sf

    scenarios, inputs = _export_diff_build()
    sc = next(item for item in scenarios if item["name"] == name)
    browser = np.frombuffer(result, dtype="<i2").astype(np.float64) / 32768.0
    half = len(browser) // 2
    browser = np.stack([browser[:half], browser[half:]])
    with tempfile.TemporaryDirectory() as workdir:
        work = pathlib.Path(workdir)
        paths = {}
        for channel in sc["channels"]:
            paths[channel] = work / f"{channel}.wav"
            sf.write(str(paths[channel]), inputs[channel], EXPORT_DIFF_RATE, subtype="FLOAT")
        spec = _xd_spec(sc["channels"], dict(sc["body"]), sc["seconds"])
        out = work / "out.wav"
        started = time.time()
        measured = _export_render(spec, paths, out, "diff")
        render_s = round(time.time() - started, 1)
        server, _ = sf.read(str(out), dtype="float64", always_2d=True)
        server = server.T
        server_twin = None
        if twin_left is not None and sc.get("pair"):
            twin = next(item for item in scenarios if item["name"] == sc["pair"])
            twin_paths = {}
            for channel in twin["channels"]:
                twin_paths[channel] = paths.get(channel) or work / f"{channel}.wav"
            twin_out = work / "twin.wav"
            _export_render(_xd_spec(twin["channels"], dict(twin["body"]), twin["seconds"]), twin_paths, twin_out, "diff")
            server_twin, _ = sf.read(str(twin_out), dtype="float64", always_2d=True)
            server_twin = server_twin.T
    n = min(browser.shape[1], server.shape[1])
    residual = _xd_residual_db(np, browser, server)
    lag = _xd_lag(np, browser[0, :n], server[0, :n])
    kind = sc["kind"]
    limit_db = 20 * np.log10(EXPORT_LIMIT_BY_FORMAT["wav"])
    wet_ok, wet_note = True, ""
    # Yankı kuyruğu (dosya sonundan sonra): tarayıcı o kadar fazla render ediyor; kuyruk bölgesi ayrıca karşılaştırılır
    tail_ok, tail_note = True, ""
    if spec.get("reverb_tail"):
        dry_len = int(np.ceil(sc["seconds"] / sc["rate"] * EXPORT_DIFF_RATE))
        tail_b, tail_s = browser[:, dry_len:n], server[:, dry_len:n]
        expected = dry_len + int(round(spec["reverb_tail"] * EXPORT_DIFF_RATE)) - EXPORT_LIMITER_DELAY_SAMPLES
        tail_energy = 10 * np.log10((tail_b ** 2).sum() / ((tail_s ** 2).sum() + 1e-30))
        tail_lag = _xd_lag(np, tail_b[0], tail_s[0], 100)
        tail_ok = (abs(tail_energy) < 0.5 and tail_lag == 0 and abs(server.shape[1] - expected) <= 4
                   and float(np.abs(server[:, -1]).max()) < 1e-3)
        tail_note = (f"; kuyruk {spec['reverb_tail']} sn: sunucu uzunluk {server.shape[1]} (beklenen {expected}), "
                     f"enerji {tail_energy:+.3f} dB, hiza {tail_lag}, kalinti {_xd_residual_db(np, tail_b, tail_s):.1f} dB")
    if server_twin is not None:
        twin_b = np.frombuffer(twin_left, dtype="<i2").astype(np.float64) / 32768.0
        m = min(n, len(twin_b), server_twin.shape[1])
        wet_b = browser[0, :m] - twin_b[:m]
        wet_s = server[0, :m] - server_twin[0, :m]
        wet_lag = _xd_lag(np, wet_b, wet_s, 300)
        wet_energy = 10 * np.log10((wet_b ** 2).sum() / ((wet_s ** 2).sum() + 1e-30))
        wet_res = _xd_residual_db(np, wet_b, wet_s)
        wet_low = _xd_residual_db(np, _xd_lowpass(np, wet_b, 3000.0), _xd_lowpass(np, wet_s, 3000.0))
        wet_ok = wet_lag == 0 and abs(wet_energy) < 0.5
        wet_note = (f"; islak kisim: hiza {wet_lag} ornek, enerji {wet_energy:+.3f} dB, kalinti {wet_res:.1f} dB "
                    f"(3 kHz alti {wet_low:.1f} dB)")
    if kind == "response":
        worst = max((_xd_bands_db(np, browser[c, :n], server[c, :n]) for c in (0, 1)), key=lambda item: abs(item[0]))
        ok = abs(worst[0]) <= 0.1 and lag == 0 and tail_ok
        detail = f"en kotu {worst[0]:+.3f} dB @ {worst[1]:.0f} Hz, kalinti {residual:.1f} dB, hiza {lag} ornek"
        label = "frekans yaniti farki <= 0,1 dB (1/3 oktav, L ve R)"
    elif kind == "mix":
        ok = residual < -40.0 and lag == 0 and wet_ok and tail_ok
        detail = (f"kalinti {residual:.1f} dB, hiza {lag} ornek, sunucu tepe {measured['peak_db']} dB "
                  f"(sinir {limit_db:.1f}), {render_s} sn{wet_note}{tail_note}")
        label = "tam miks null-testi kalintisi < -40 dB, hiza 0"
    elif kind == "reverb":
        start = int(3.5 * EXPORT_DIFF_RATE) + 200     # tik 3,5. saniyede (dosya sonuna 0,5 sn kala: kuyruk yeterince yuksek, int16 tabanina gomulmez)
        tail_b, tail_s = browser[:, start:n], server[:, start:n]
        energy = 10 * np.log10((tail_b ** 2).sum() / ((tail_s ** 2).sum() + 1e-30))
        lag_tail = _xd_lag(np, tail_b[0], tail_s[0], 100)
        ok = lag_tail == 0 and abs(energy) < 0.5 and tail_ok
        detail = f"hiza {lag_tail} ornek, yanki enerji farki {energy:+.3f} dB, kalinti {residual:.1f} dB{tail_note}"
        label = "yanki hizasi 0 ornek, kuyruk enerji farki < 0,5 dB"
    else:
        # Tarayıcı kaynak hızıyla (playbackRate) çalıyor, sunucu asetrate + aresample: iki yeniden örnekleme çekirdeği
        # HF'te ayrışır, bu yüzden giriş HF'ten arındırılmış (ölçülen: ~ -50 dB). Islak kısım da kendi içinde tutmalı.
        ok = residual < -45.0
        ok = (ok and abs(lag) <= 1 and wet_ok and tail_ok
              and 0 <= browser.shape[1] - server.shape[1] <= EXPORT_LIMITER_DELAY_SAMPLES + 4)
        detail = (f"kalinti {residual:.1f} dB, hiza {lag} ornek, uzunluk {browser.shape[1]} vs {server.shape[1]}"
                  f"{wet_note}{tail_note}")
        label = "plak gibi 0,85 + fx (yeniden ornekleme cekirdegi farki dahil) null-testi, sure"
    return _assert_plain([{"name": f"J) {name}: {label}", "ok": bool(ok), "detail": detail}])


def _cgroup_memory_peak_mb():
    """Konteynerin bellek tepesi (cgroup v2 memory.peak; yoksa None)."""
    for path in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return round(int(pathlib.Path(path).read_text().strip()) / 1048576, 0)
        except (OSError, ValueError):
            continue
    return None


@app.function(image=light_image, volumes={DATA_DIR: volume}, timeout=1500, memory=2048)
def export_worst_case_run(song_id: str) -> list:
    """EN KÖTÜ DURUM ölçümü: `export_mix` ile AYNI kaynak sınırı (2048 MB), 11 kanal (6 stem + 5 kopya: alt parçalar
    açıkmış gibi) x pan/EQ/gönderim x salon odası (3 sn, seviye 1) x plak gibi 0,85 x m4a; ~2,6 dk ve ~7,9 dk (şarkı 3
    kez art arda). Süre, ffmpeg bellek tepesi (RUSAGE_CHILDREN) ve konteyner tepesi (cgroup) raporlanır; bellek
    yetmezse konteyner öldürülür, yani bu satır hiç gelmez."""
    import resource

    volume.reload()
    song_dir = _song_dir(song_id)
    status = json.loads((song_dir / "status.json").read_text(encoding="utf-8"))
    stems = list(status.get("stems") or [])
    duration = float(status.get("duration") or 0)
    rows = []
    with tempfile.TemporaryDirectory() as workdir:
        work = pathlib.Path(workdir)
        local = {}
        for name in stems:
            local[name] = work / f"{name}.flac"
            with (song_dir / "master" / f"{name}.flac").open("rb") as src, local[name].open("wb") as dst:
                shutil.copyfileobj(src, dst)
        for loops in (1, 3):
            paths = {}
            for name, path in local.items():
                if loops == 1:
                    paths[name] = path
                else:
                    paths[name] = work / f"{name}_x{loops}.flac"
                    _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-stream_loop", str(loops - 1), "-i", str(path),
                          "-c:a", "flac", str(paths[name])])
            channels = dict(paths)
            for base in [name for name in stems if name != stems[0]][:5]:
                channels[f"{base}_b"] = paths[base]
            names = list(channels)
            body = {
                "gains": {name: 0.8 for name in names},
                "fx": {name: {"pan": (-0.6 if i % 2 else 0.6), "eq": [3, -2, 4], "send": 0.5} for i, name in enumerate(names)},
                "room": {"size": 1.0, "decay": 3.0, "level": 1.0},
                "rate": 0.85, "vinyl": True,
            }
            spec = _xd_spec(names, body, duration * loops, fmt="m4a")
            out = work / f"worst_{loops}.m4a"
            before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            started = time.time()
            measured = _export_render(spec, channels, out, "worst")
            seconds = round(time.time() - started, 1)
            after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
            expect = duration * loops / 0.85 + 3.0
            rows.append({
                "name": f"K) en kotu durum: {len(names)} kanal + pan/EQ/gonderim + salon (3 sn) + plak gibi 0,85, m4a, "
                        f"{duration * loops / 60:.1f} dk sarki",
                "ok": abs(measured["duration"] - expect) <= 0.5 and measured["peak_db"] is not None,
                "detail": f"cikti {measured['duration']} sn (beklenen {expect:.2f}), render {seconds} sn "
                          f"({duration * loops / 0.85 / max(seconds, 0.1):.1f}x gercek zaman), ffmpeg bellek tepesi "
                          f"{max(before, after) / 1024:.0f} MB, konteyner tepesi {_cgroup_memory_peak_mb()} MB / 2048, "
                          f"{measured['bytes']} bayt"})
            out.unlink()
            if loops > 1:
                for path in paths.values():
                    path.unlink()
    return _assert_plain(rows)


@app.function(image=sub_cpu_image, volumes={DATA_DIR: volume}, timeout=1200, memory=8192)
def export_validate_run(song_id: str) -> dict:
    """Dışa aktarma çıktısını GERÇEK sesle ölçer (ffmpeg gerçek, Volume'a YAZMAZ).

    Kaynak FLAC'lar yerel dizine kopyalanır; çıktılar da yerelde. Ton testi sentetik 440 Hz
    sinüsle. Kontroller: (A) tüm kazançlar 1 iken orijinal karışımdan fark, (B) vokal 0
    iken çıkan enerji = vokal stem enerjisi, (C) A-B süresi, (D) A-B + hız, (E) tam hız
    çarpanı, (F) ton ve hız (sinüsle), (G) tepe sınırı (WAV ve m4a), (H) m4a kodu çözülür,
    (I) kanal şeridi + yankı (afir birim kazancı, fx + hız/ton, Slowed + reverb). Tarayıcı <-> sunucu fark ölçümü (J)
    ayrı: `export_diff_case` (senaryo başına bir çağrı).
    """
    import numpy as np
    import soundfile as sf

    volume.reload()
    song_dir = _song_dir(song_id)
    status = json.loads((song_dir / "status.json").read_text(encoding="utf-8"))
    stems = list(status.get("stems") or [])
    duration = float(status.get("duration") or 0)
    results = []

    def record(name, ok, detail=""):
        results.append({"name": name, "ok": bool(ok), "detail": str(detail)})

    def rms(array):
        return float(np.sqrt(np.mean(np.asarray(array, dtype=np.float64) ** 2)) + 1e-12)

    def db(value):
        return 20 * np.log10(max(value, 1e-12))

    def make_spec(overrides=None, gains=None, fmt="wav"):
        body = {"format": fmt, "gains": gains or {name: 1.0 for name in stems}}
        body.update(overrides or {})
        spec, problem = _export_check(body, status)
        if problem:
            raise ValueError(problem)
        return spec

    with tempfile.TemporaryDirectory() as workdir:
        work = pathlib.Path(workdir)
        local = {}
        for name in stems:
            local[name] = work / f"{name}.flac"
            with (song_dir / "master" / f"{name}.flac").open("rb") as src, local[name].open("wb") as dst:
                shutil.copyfileobj(src, dst)

        def render(spec, tag, paths=None):
            out = work / f"{tag}.{spec['format']}"
            started = time.time()
            measured = _export_render(spec, paths or local, out, "test")
            measured["render_s"] = round(time.time() - started, 1)
            return out, measured

        def read_wav(path):
            data, rate = sf.read(str(path), dtype="float32", always_2d=True)
            return data.T, rate

        # A) hepsi 1: (A1) stem'lerin kendi toplamından fark ~0 ve KAYMA YOK; (A2) orijinal
        # karışımdan fark ayrıştırmanın kendi artığı kadar (Zeus ölçümü: -29,9 dB)
        spec_all = make_spec()
        out_all, m_all = render(spec_all, "all")
        mix_all, rate = read_wav(out_all)
        total = sum(sf.read(str(local[name]), dtype="float64", always_2d=True)[0].T for name in stems)
        n = min(mix_all.shape[1], total.shape[1])
        diff_sum = db(rms(mix_all[:, :n] - total[:, :n])) - db(rms(total[:, :n]))
        seg = slice(44100 * 10, 44100 * 30)
        best = (0, -1.0)
        for lag in range(-400, 401):
            x = mix_all[0, seg]
            y = total[0, 44100 * 10 + lag:44100 * 30 + lag]
            c = float(np.dot(x, y) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-12))
            if c > best[1]:
                best = (lag, c)
        record("A1) hepsi 1: stem toplamindan fark (dB) ve kayma", diff_sum <= -60.0 and best[0] == 0,
               f"{diff_sum:.1f} dB, kayma {best[0]} ornek (tepe {m_all['peak_db']} dB, {m_all['render_s']} sn)")
        original = _decode_pcm(_find_input(song_id), 44100, 2)
        n = min(mix_all.shape[1], original.shape[1])
        diff = db(rms(mix_all[:, :n] - original[:, :n])) - db(rms(original[:, :n]))
        record("A2) hepsi 1: orijinal karisimdan fark (ayristirma artigi kadar)", diff <= -25.0,
               f"{diff:.1f} dB (uzunluk {mix_all.shape[1]} vs {original.shape[1]})")

        # B) vokal 0: kaybolan enerji vokal stem'ine esit
        if "vocals" in stems:
            spec_nov = make_spec(gains={name: 1.0 for name in stems if name != "vocals"})
            out_nov, _ = render(spec_nov, "novocals")
            mix_nov, _ = read_wav(out_nov)
            removed = mix_all[:, :mix_nov.shape[1]] - mix_nov[:, :mix_all.shape[1]]
            stem_vocals, _ = sf.read(str(local["vocals"]), dtype="float32", always_2d=True)
            stem_vocals = stem_vocals.T
            m = min(removed.shape[1], stem_vocals.shape[1])
            gap = db(rms(removed[:, :m])) - db(rms(stem_vocals[:, :m]))
            leak = db(rms(removed[:, :m] - stem_vocals[:, :m])) - db(rms(stem_vocals[:, :m]))
            record("B) vokal 0: cikarilan enerji = vokal stem'i", abs(gap) <= 0.5 and leak <= -40.0,
                   f"seviye farki {gap:+.2f} dB, kalinti {leak:.1f} dB")

        # C) A-B bolgesi
        a, b = 10.0, min(20.0, duration - 1.0)
        spec = make_spec({"region": {"a": a, "b": b}})
        out, m = render(spec, "region")
        record("C) A-B suresi", abs(m["duration"] - (b - a)) <= 0.05, f"{m['duration']} sn (beklenen {b - a})")

        # D) A-B + 0.8x
        spec = make_spec({"region": {"a": a, "b": b}, "rate": 0.8})
        out, m = render(spec, "region_slow")
        record("D) A-B + 0.8x suresi", abs(m["duration"] - (b - a) / 0.8) <= 0.15,
               f"{m['duration']} sn (beklenen {(b - a) / 0.8:.2f})")

        # E) tam miks 0.8x
        spec = make_spec({"rate": 0.8})
        out, m = render(spec, "slow")
        expect = duration / 0.8
        record("E) tam miks 0.8x suresi", abs(m["duration"] - expect) <= 0.3,
               f"{m['duration']} sn (beklenen {expect:.2f}, {m['render_s']} sn)")

        # F) ton ve hiz: sentetik 440 Hz
        rate_hz = 44100
        t = np.arange(rate_hz * 10) / rate_hz
        tone = (0.3 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
        tone_path = work / "tone.flac"
        sf.write(str(tone_path), np.stack([tone, tone], axis=1), rate_hz, subtype="PCM_24", format="FLAC")
        tone_paths = {"vocals": tone_path}
        tone_status = dict(status, stems=["vocals"])

        def tone_spec(over):
            body = {"format": "wav", "gains": {"vocals": 1.0}}
            body.update(over)
            spec, problem = _export_check(body, tone_status)
            if problem:
                raise ValueError(problem)
            return spec

        def peak_hz(path):
            data, sr = read_wav(path)
            mid = data[0, int(sr * 2):int(sr * 7)].astype(np.float64) * np.hanning(int(sr * 5))
            spectrum = np.abs(np.fft.rfft(mid, n=1 << 21))
            return float(np.argmax(spectrum) * sr / (1 << 21))

        cases = (
            ("F1) ton +3 yari ses", {"semitones": 3}, 440.0 * 2 ** (3 / 12), 10.0),
            ("F2) ton -5 yari ses", {"semitones": -5}, 440.0 * 2 ** (-5 / 12), 10.0),
            ("F3) yalniz hiz 0.8x (ton ayni)", {"rate": 0.8}, 440.0, 12.5),
            ("F4) hiz 1.25x (ton ayni)", {"rate": 1.25}, 440.0, 8.0),
            ("F5) hiz 0.8x + ton +2", {"rate": 0.8, "semitones": 2}, 440.0 * 2 ** (2 / 12), 12.5),
            ("F6) plak gibi 0.8x (ton hizla duser: 352 Hz)", {"rate": 0.8, "vinyl": True}, 440.0 * 0.8, 12.5),
            ("F7) plak gibi 1.25x (ton hizla cikar: 550 Hz)", {"rate": 1.25, "vinyl": True}, 440.0 * 1.25, 8.0),
        )
        for name, over, expect_hz, expect_len in cases:
            out, m = render(tone_spec(over), "tone", tone_paths)
            hz = peak_hz(out)
            ok = abs(hz - expect_hz) <= max(3.0, expect_hz * 0.006) and abs(m["duration"] - expect_len) <= 0.2
            record(name, ok, f"{hz:.1f} Hz (beklenen {expect_hz:.1f}), {m['duration']} sn (beklenen {expect_len})")

        # G) tepe siniri: gurultulu girdi, kazanc 2.0, ana ses 1.5
        loud = {name: 2.0 for name in stems}
        for fmt in ("wav", "m4a"):
            spec = make_spec({"master": 1.5}, gains=loud, fmt=fmt)
            out, m = render(spec, f"loud_{fmt}")
            limit_db = 20 * np.log10(EXPORT_LIMIT_BY_FORMAT[fmt])
            tolerance = 0.1 if fmt == "wav" else 0.3       # m4a: -1 dBFS sinir + kucuk AAC asimi payi
            record(f"G) tepe siniri ({fmt})", m["peak_db"] is not None and m["peak_db"] <= limit_db + tolerance,
                   f"tepe {m['peak_db']} dB (sinir {limit_db:.2f}, tolerans {tolerance})")

        # H) m4a: gercek bir ayar, kodu cozulur, sure dogru
        spec = make_spec({"rate": 0.8, "semitones": 0, "label": "Test"}, fmt="m4a")
        out, m = render(spec, "m4a_real")
        decoded = _decode_pcm(out, 44100, 2)
        record("H) m4a kodu cozulur, sure dogru",
               abs(decoded.shape[1] / 44100 - m["duration"]) <= 0.1 and m["bytes"] > 10000,
               f"{m['duration']} sn, {m['bytes']} bayt, {m['render_s']} sn")

        # ---- I) kanal seridi (pan/EQ) + ortak yanki (Asama 15, 3. oturum) --------------------------------
        # I0) afir birim kazanc: tek tik + IR -> kuyruk = IR (giris x IR x seviye), ffmpeg surumune karsi koruma
        rate_hz = 44100
        click = np.zeros((rate_hz * 4, 2), dtype=np.float32)
        click[rate_hz, 0] = 0.5
        click[rate_hz, 1] = 0.25
        click_path = work / "click.flac"
        sf.write(str(click_path), click, rate_hz, subtype="PCM_24", format="FLAC")
        click_spec = _xd_spec(["C"], {"gains": {"C": 1.0}, "fx": {"C": {"send": 1.0}},
                                        "room": {"size": 0.5, "decay": 1.6, "level": 1.0}}, 4.0)
        out, m = render(click_spec, "click", {"C": click_path})
        wet, _ = read_wav(out)
        ir_left, ir_right = _fx_impulse(0.5, 1.6)
        ir_left = np.asarray(ir_left, dtype=np.float64)
        ir_right = np.asarray(ir_right, dtype=np.float64)
        span = len(ir_left) - 300
        tail_l = wet[0, rate_hz + 200:rate_hz + 200 + span].astype(np.float64)
        tail_r = wet[1, rate_hz + 200:rate_hz + 200 + span].astype(np.float64)
        gain_l = 10 * np.log10((tail_l ** 2).sum() / ((0.5 * ir_left[200:200 + span]) ** 2).sum())
        gain_r = 10 * np.log10((tail_r ** 2).sum() / ((0.25 * ir_right[200:200 + span]) ** 2).sum())
        lag_wet = _xd_lag(np, wet[0, rate_hz:rate_hz + 20000].astype(np.float64), (0.5 * ir_left[:20000]), 100)
        record("I0) yanki: afir birim kazanc (kuyruk = giris x IR x seviye) ve IR hizasi",
               abs(gain_l) <= 0.1 and abs(gain_r) <= 0.1 and lag_wet == 0,
               f"sol {gain_l:+.3f} dB, sag {gain_r:+.3f} dB, hiza {lag_wet} ornek (FX_AFIR_COMPENSATION={FX_AFIR_COMPENSATION})")

        # I1) fx + hiz/ton: tek ton ile (frekans = beklenen, sure dogru)
        tone_fx = {"vocals": {"pan": -0.3, "eq": [0, 3, 0], "send": 0.5}}
        tone_cases = (
            ("I1) fx + bagimsiz 0.8x + ton +2 (rubberband yalniz ton duzeltmesi; + 1,2 sn kuyruk)",
             {"rate": 0.8, "semitones": 2}, 440.0 * 2 ** (2 / 12), 12.5 + 1.2),
            ("I2) fx + plak gibi 0.8x (352 Hz, rubberband yok; + 1,2 sn kuyruk)", {"rate": 0.8, "vinyl": True}, 352.0, 12.5 + 1.2),
            ("I3) fx + yalniz hiz 0.8x bagimsiz (ton ayni 440 Hz; + 1,2 sn kuyruk)", {"rate": 0.8}, 440.0, 12.5 + 1.2),
            ("I4) fx + ton -3 (hiz 1; + 1,2 sn kuyruk)", {"semitones": -3}, 440.0 * 2 ** (-3 / 12), 10.0 + 1.2),
        )
        for name, over, expect_hz, expect_len in tone_cases:
            body = {"gains": {"vocals": 1.0}, "fx": tone_fx, "room": {"size": 0.4, "decay": 1.2, "level": 0.5}}
            body.update(over)
            out, m = render(_xd_spec(["vocals"], body, 10.0), "tone_fx", tone_paths)
            hz = peak_hz(out)
            ok = abs(hz - expect_hz) <= max(3.0, expect_hz * 0.006) and abs(m["duration"] - expect_len) <= 0.2
            record(name, ok, f"{hz:.1f} Hz (beklenen {expect_hz:.1f}), {m['duration']} sn (beklenen {expect_len}), {m['render_s']} sn")
        body = {"gains": {"vocals": 1.0}, "fx": tone_fx, "region": {"a": 2.0, "b": 6.0}, "rate": 0.8}
        out, m = render(_xd_spec(["vocals"], body, 10.0), "region_fx", tone_paths)
        record("I5) fx + A-B + 0.8x suresi", abs(m["duration"] - 5.0) <= 0.15, f"{m['duration']} sn (beklenen 5.0)")

        # I6) gercek sarki: Slowed + reverb ayari (wav ve m4a): sure, tepe sinir, render suresi, kod cozulur
        slowed_fx = {name: {"pan": 0, "eq": [0, 0, 0], "send": 0.65 if name == "vocals" else 0.5} for name in stems}
        slowed_body = {"fx": slowed_fx, "room": {"size": 0.7, "decay": 2.2, "level": 0.8}, "rate": 0.85, "vinyl": True}
        for fmt in ("wav", "m4a"):
            spec = make_spec(slowed_body, fmt=fmt)
            out, m = render(spec, f"slowed_{fmt}")
            limit_db = 20 * np.log10(EXPORT_LIMIT_BY_FORMAT[fmt])
            tolerance = 0.1 if fmt == "wav" else 0.3
            decoded = _decode_pcm(out, 44100, 2)
            ok = (abs(m["duration"] - (duration / 0.85 + 2.2)) <= 0.3 and m["peak_db"] <= limit_db + tolerance
                  and abs(decoded.shape[1] / 44100 - m["duration"]) <= 0.1)
            record(f"I6) Slowed + reverb ({fmt}): sure, tepe sinir, kod cozulur", ok,
                   f"{m['duration']} sn (beklenen {duration / 0.85 + 2.2:.2f} = sure/0.85 + 2,2 sn kuyruk), tepe {m['peak_db']} dB, ort {m['mean_db']} dB, "
                   f"{m['bytes']} bayt, {m['render_s']} sn")
        dry_slow = make_spec({"rate": 0.85, "vinyl": True})
        out, m_dry = render(dry_slow, "slowed_dry")
        out, m_wet = render(make_spec(slowed_body), "slowed_wet")
        record("I7) Slowed + reverb: yanki enerji ekler (ortalama seviye >= yankisiz)",
               m_wet["mean_db"] is not None and m_wet["mean_db"] >= m_dry["mean_db"] - 0.2,
               f"yankili {m_wet['mean_db']} dB, yankisiz {m_dry['mean_db']} dB")

        # I8) yanki kuyrugu: sure = giris + oda suresi, kuyruk dogal soner (tik yok), bolgede ve yankisizda kuyruk YOK
        tail_body = {"gains": {"vocals": 1.0}, "fx": {"vocals": {"send": 0.8}}, "room": {"size": 0.6, "decay": 2.0, "level": 1.0}}
        out, m = render(_xd_spec(["vocals"], tail_body, 10.0), "tail_on", tone_paths)
        wav, _ = read_wav(out)
        peak_level = float(np.abs(wav).max())
        just_after = db(rms(wav[:, int(10.0 * 44100):int(10.3 * 44100)]))
        last = db(rms(wav[:, -int(0.05 * 44100):]))
        record("I8) yanki kuyrugu: sure = 10 + 2,0 sn, dosya sonundan sonra yanki surer, sonda sessiz, tik yok",
               abs(m["duration"] - 12.0) <= 0.05 and just_after > -50.0 and last < -60.0 and float(np.abs(wav[:, -1]).max()) < 1e-3,
               f"{m['duration']} sn, bitisten hemen sonra {just_after:.1f} dBFS, son 50 ms {last:.1f} dBFS, tepe {db(peak_level):.1f} dB")
        out, m = render(_xd_spec(["vocals"], dict(tail_body, region={"a": 2.0, "b": 6.0}), 10.0), "tail_region", tone_paths)
        out2, m2 = render(_xd_spec(["vocals"], {"gains": {"vocals": 1.0}, "fx": {"vocals": {"pan": 0.4, "eq": [2, 0, 0]}}}, 10.0),
                          "tail_dry_fx", tone_paths)
        record("I9) kuyruk YOK: A-B bolgesinde (4,0 sn) ve yankisiz fx'te (10,0 sn)",
               abs(m["duration"] - 4.0) <= 0.05 and abs(m2["duration"] - 10.0) <= 0.05,
               f"bolge {m['duration']} sn, yankisiz {m2['duration']} sn")

    return _assert_plain({"title": str(status.get("title") or ""), "duration": duration,
                          "results": results})


@app.local_entrypoint()
def export_validate(song: str = "Zeus", diff_dir: str = ""):
    """Dışa aktarma ölçümleri (gerçek ses, CPU, Volume'a yazmaz): modal run backend/app.py::export_validate

    Tarayıcı<->sunucu (J) satırları için önce `tests\\export_diff.py` + tarayıcı sayfası çalıştırılmış olmalı
    (çıktı tests/export_diff_out/results); `--diff-dir` başka bir klasörü gösterir, yoksa o satırlar atlanır.
    """
    song_id, title = _resolve_title_cli(song)
    folder = pathlib.Path(diff_dir) if diff_dir else pathlib.Path(__file__).resolve().parent.parent / "tests" / "export_diff_out"
    cases = []
    decode_error = None
    if (folder / "results" / "_decode.f32").is_file():
        import numpy as np

        decode_error = float(np.frombuffer((folder / "results" / "_decode.f32").read_bytes(), dtype="<f4")[0])
        scenarios, _ = _export_diff_build()
        for sc in scenarios:
            path = folder / "results" / f"{sc['name']}.f32"
            if path.is_file():
                floats = np.frombuffer(path.read_bytes(), dtype="<f4")
                twin = None
                twin_path = folder / "results" / f"{sc['pair']}.f32" if sc.get("pair") else None
                if twin_path is not None and twin_path.is_file():
                    twin_floats = np.frombuffer(twin_path.read_bytes(), dtype="<f4")
                    twin = (np.clip(twin_floats[:len(twin_floats) // 2], -1.0, 1.0) * 32767.0).round().astype("<i2").tobytes()
                cases.append((sc["name"], (np.clip(floats, -1.0, 1.0) * 32767.0).round().astype("<i2").tobytes(), twin))
        print(f"tarayici verisi: {len(cases)} senaryo ({folder}), giris cozme hatasi {decode_error:.1e}")
    else:
        print("tarayici verisi yok: J satirlari atlanacak (tests\\export_diff.py + export_diff.html)")
    pending = list(export_diff_case.starmap(cases)) if cases else []
    worst = export_worst_case_run.spawn(song_id)
    report = export_validate_run.remote(song_id)
    if decode_error is not None:
        report["results"].append({"name": "J0) tarayici: giris cozme (decodeAudioData float WAV) birebir",
                                  "ok": decode_error == 0.0, "detail": f"en buyuk hata {decode_error:.1e}"})
    else:
        report["results"].append({"name": "J) tarayici <-> sunucu fark olcumu", "ok": True,
                                  "detail": "ATLANDI: tests/export_diff_out yok"})
    for rows in pending:
        report["results"].extend(rows)
    report["results"].extend(worst.get())
    failed = 0
    print(f"\n{title} ({report['duration']} sn)")
    for item in report["results"]:
        print(f"[{'OK  ' if item['ok'] else 'HATA'}] {item['name']}  -> {item['detail']}")
        failed += 0 if item["ok"] else 1
    print(f"\n{len(report['results']) - failed} gecti, {failed} basarisiz")
    if failed:
        raise SystemExit(1)


def _resolve_title_cli(needle: str):
    found = sub_find.remote([needle])
    if needle not in found:
        raise SystemExit(f"sarki bulunamadi: {needle}")
    return found[needle][0], found[needle][1]


def _wav_from_flac(flac_path: pathlib.Path) -> bytes:
    """FLAC master'dan WAV üretir.

    FLAC önce konteyner-yerel bir dizine kopyalanıyor: ffmpeg volume üzerindeki
    dosyayı saniyeler boyunca açık tutarsa eşzamanlı bir reload patlar.
    """
    with tempfile.TemporaryDirectory() as workdir:
        local_flac = pathlib.Path(workdir) / "master.flac"
        with flac_path.open("rb") as source, local_flac.open("wb") as target:
            shutil.copyfileobj(source, target)
        proc = _run(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-i", str(local_flac),
                "-f", "wav", "-c:a", "pcm_s16le", "-",
            ]
        )
        return proc.stdout


@app.function(
    image=api_image,
    volumes={DATA_DIR: volume},
    secrets=[
        modal.Secret.from_name(
            API_SECRET_NAME, required_keys=["API_TOKEN", "SIGNING_KEY"]
        )
    ],
    timeout=600,
    # min_containers YOK: boştayken maliyet sıfır. Soğuk başlangıçta ilk istek
    # birkaç saniye sürer.
)
@modal.concurrent(max_inputs=8)
@modal.asgi_app(label="stem-mikser")
def api():
    """Oynatıcının konuştuğu API. Tüm uç noktalar Bearer token ister."""
    import fastapi
    from fastapi import (Depends, FastAPI, File, Form, Header, HTTPException,
                         Request, UploadFile)
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, Response

    token = os.environ["API_TOKEN"]
    signing_key = os.environ["SIGNING_KEY"]

    origins = [
        item.strip()
        for item in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if item.strip()
    ]
    allowed_origins = origins + list(LOCAL_ORIGINS)
    print(f"[api] izin verilen origin'ler: {allowed_origins}")

    gate = _VolumeGate()
    web = FastAPI(title="Stem Mikser", docs_url=None, redoc_url=None)
    web.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Range"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
        max_age=3600,
    )

    def require_token(authorization: str = Header(default="")):
        if not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Bearer token gerekli")
        if not hmac.compare_digest(authorization[7:], token):
            raise HTTPException(status_code=401, detail="Gecersiz token")
        return True

    auth = Depends(require_token)

    async def load_status(song_id: str):
        path = _song_dir(song_id) / "status.json"
        if not await asyncio.to_thread(path.exists):
            return None
        raw = await asyncio.to_thread(_read_slice, path)
        return json.loads(raw.decode("utf-8"))

    async def require_status(song_id: str) -> dict:
        # Kimlik doğrulaması BURADA, yani yol parametresi alan her uçta:
        # geçersiz bir kimlik dosya sistemine hiç dokunmadan eleniyor.
        if not _is_valid_song_id(song_id):
            raise HTTPException(status_code=400, detail="Gecersiz sarki kimligi")
        status = await load_status(song_id)
        if status is None:
            await gate.refresh(force=True)
            status = await load_status(song_id)
        if status is None:
            raise HTTPException(status_code=404, detail="Sarki bulunamadi")
        return status

    # ---------------- sağlık -------------------------------------------------

    @web.get("/health")
    async def health(_=auth):
        return {
            "ok": True,
            "allowed_origins": allowed_origins,
            "reload_count": gate.reload_count,
            "fastapi": fastapi.__version__,
            "download_ttl": DOWNLOAD_TTL,
        }

    # ---------------- yükleme -----------------------------------------------

    @web.post("/songs")
    async def create_song(
        request: Request,
        file: UploadFile = File(...),
        quality: str = Form(DEFAULT_QUALITY),
        _=auth,
    ):
        declared = request.headers.get("content-length")
        if declared and int(declared) > MAX_UPLOAD_BYTES + 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"Dosya cok buyuk (sinir {MAX_UPLOAD_BYTES // 1024**2} MB)",
            )

        digest = hashlib.sha256()
        chunks = []
        total = 0
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Dosya cok buyuk: sinir "
                           f"{MAX_UPLOAD_BYTES // 1024**2} MB",
                )
            digest.update(chunk)
            chunks.append(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="Bos dosya")

        song_id = digest.hexdigest()

        # Aynı dosya daha önce işlendiyse tekrar işlemiyoruz.
        await gate.refresh()
        existing = await load_status(song_id)
        if existing and existing.get("state") != "error":
            return {"id": song_id, "existing": True, "state": existing.get("state")}

        suffix = pathlib.PurePosixPath(file.filename or "").suffix.lower()
        extension = suffix.lstrip(".") or "bin"
        target = _song_dir(song_id) / f"input.{extension}"

        def write_input():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as handle:
                for piece in chunks:
                    handle.write(piece)

        await asyncio.to_thread(write_input)
        await volume.commit.aio()

        # ffprobe API konteynerinin İÇİNDE: imajda ffmpeg var, 10 dk kapısı
        # GPU'ya girmeden burada kapanıyor.
        title = pathlib.PurePosixPath(file.filename or song_id[:12]).stem
        status = await asyncio.to_thread(_probe_input, song_id, title)
        if status.get("state") == "error":
            raise HTTPException(status_code=400, detail=status.get("error"))

        chosen = quality if quality in QUALITIES else DEFAULT_QUALITY
        separate.spawn(song_id, chosen)
        return {"id": song_id, "existing": False, "state": "queued",
                "quality": chosen,
                "title": status.get("title"), "duration": status.get("duration")}

    # ---------------- liste / durum -----------------------------------------

    @web.get("/songs")
    async def list_songs(_=auth):
        await gate.refresh()
        root = pathlib.Path(DATA_DIR) / "songs"

        def collect():
            if not root.is_dir():
                return []
            found = []
            for entry in sorted(root.iterdir()):
                status_path = entry / "status.json"
                if not status_path.is_file():
                    continue
                try:
                    data = json.loads(status_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                found.append(
                    {
                        "id": data.get("id", entry.name),
                        "title": data.get("title"),
                        "state": data.get("state"),
                        "duration": data.get("duration"),
                        "progress": data.get("progress"),
                        "created_at": data.get("created_at"),
                        "quality": data.get("quality"),
                        "stems_version": data.get("stems_version"),
                        "pipeline": data.get("pipeline"),
                        "sub_state": (data.get("sub") or {}).get("state"),
                        "sub_version": (data.get("sub") or {}).get("version"),
                        "sub_drums_state": (data.get("sub_drums") or {}).get("state"),
                        "sub_drums_version": (data.get("sub_drums") or {}).get("version"),
                        "lyrics_state": (data.get("lyrics") or {}).get("state"),
                        "lyrics_version": (data.get("lyrics") or {}).get("version"),
                        "lyrics_source": (data.get("lyrics") or {}).get("source"),
                        "lyrics_stale": _lyr_stale(data),
                        "translation_state": (data.get("translation") or {}).get("state"),
                        "translation_version": (data.get("translation") or {}).get("version"),
                        "melody_state": (data.get("melody") or {}).get("state"),
                        "melody_version": (data.get("melody") or {}).get("version"),
                        "melody_source": (data.get("melody") or {}).get("source"),
                        "melody_stale": _melody_stale(data),
                    }
                )
            return found

        songs = await asyncio.to_thread(collect)
        songs.sort(key=lambda item: item.get("created_at") or "", reverse=True)
        return {"songs": songs}

    @web.get("/songs/{song_id}")
    async def get_song(song_id: str, _=auth):
        await gate.refresh()
        status = await require_status(song_id)
        payload = {"status": status, "chords": None}
        if status.get("state") == "done":
            chords_path = _song_dir(song_id) / "chords.json"
            if await asyncio.to_thread(chords_path.exists):
                raw = await asyncio.to_thread(_read_slice, chords_path)
                payload["chords"] = json.loads(raw.decode("utf-8"))
        return payload

    # ---------------- stem servisi (Range) ----------------------------------

    async def serve_m4a(path, request):
        """Stem dosyasını Range desteğiyle sunar (ana ve alt parça ortak)."""
        if not await asyncio.to_thread(path.exists):
            await gate.refresh(force=True)  # başka konteyner yeni commit etmiş olabilir
            if not await asyncio.to_thread(path.exists):
                raise HTTPException(status_code=404, detail="Stem bulunamadi")

        size = (await asyncio.to_thread(path.stat)).st_size
        base_headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"}

        try:
            span = _parse_range(request.headers.get("range", ""), size)
        except ValueError:
            return Response(
                status_code=416,
                headers={**base_headers, "Content-Range": f"bytes */{size}"},
            )

        # Okuma boyunca reload engelleniyor; tanıtıcı _read_slice içinde kapanıyor.
        async with gate.reading():
            if span is None:
                body = await asyncio.to_thread(_read_slice, path)
                return Response(
                    content=body, media_type="audio/mp4", headers=base_headers
                )
            start, end = span
            body = await asyncio.to_thread(_read_slice, path, start, end - start + 1)

        return Response(
            content=body,
            status_code=206,
            media_type="audio/mp4",
            headers={**base_headers, "Content-Range": f"bytes {start}-{end}/{size}"},
        )

    @web.get("/songs/{song_id}/stems/{name}.m4a")
    async def get_stem(song_id: str, name: str, request: Request, _=auth):
        if "/" in name or "." in name or not name.isalnum():
            raise HTTPException(status_code=400, detail="Gecersiz stem adi")
        return await serve_m4a(_song_dir(song_id) / "stems" / f"{name}.m4a", request)

    @web.get("/songs/{song_id}/substems/{name}.m4a")
    async def get_substem(song_id: str, name: str, request: Request, _=auth):
        """Alt parça (Aşama 10). Yalnız bilinen adlar: yol dışarı çıkamaz."""
        if not _is_valid_song_id(song_id):
            raise HTTPException(status_code=400, detail="Gecersiz sarki kimligi")
        if name not in SUB_ALL_PARTS:
            raise HTTPException(status_code=400, detail="Gecersiz alt parca adi")
        return await serve_m4a(_song_dir(song_id) / "stems" / "sub" / f"{name}.m4a", request)

    @web.post("/songs/{song_id}/sub")
    async def start_sub(song_id: str, group: str = "vocals", _=auth):
        """Bir ana kanalı alt parçalara böler (istek üzerine): group=vocals|drums.

        Sıra: CPU'da "vokal/davul yok" kontrolü (GPU AÇILMAZ), sonra GPU işi. Her
        grubun durumu AYRI: vokal `status.sub`, davul `status.sub_drums`; biri
        ötekinin durumuna ve dosyalarına dokunmaz. Mevcut durum yoklaması okur.
        """
        if group not in SUB_GROUP_CFG:
            raise HTTPException(status_code=400, detail="Gecersiz grup")
        cfg = SUB_GROUP_CFG[group]
        await gate.refresh(force=True)
        status = await require_status(song_id)
        if status.get("state") != "done" or not status.get("stems"):
            raise HTTPException(status_code=409, detail="Sarki henuz hazir degil")
        sub = status.get(cfg["key"]) or {}
        if _sub_is_running(status, group):
            return {"id": song_id, "group": group, "state": "running", "existing": True}
        if sub.get("state") in ("done", "unreliable", "no_vocals", "no_drums"):
            return {"id": song_id, "group": group, "state": sub["state"], "existing": True}

        stem_path = _song_dir(song_id) / "master" / f"{cfg['stem']}.flac"
        if not await asyncio.to_thread(stem_path.exists):
            raise HTTPException(status_code=409, detail=f"{cfg['stem']} stem'i yok")
        async with gate.reading():
            level = await asyncio.to_thread(_sub_vocal_level, stem_path)
        level = round(level, 2)

        silent_state = "no_vocals" if group == "vocals" else "no_drums"
        silent_floor = SUB_SILENT_DBFS if group == "vocals" else SUB_DRUMS_SILENT_DBFS
        if level < silent_floor:
            record = {"state": silent_state, "rms_dbfs": level,
                      "parent_stems_version": status.get("stems_version"),
                      "parent_pipeline": status.get("pipeline"),
                      "thresholds": {"silent_dbfs": silent_floor},
                      "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            if group == "vocals":
                record["vocal_rms_dbfs"] = level           # eski alan adı (istemci uyumu)
            await asyncio.to_thread(_write_status, song_id, **{cfg["key"]: record})
            return {"id": song_id, "group": group, "state": silent_state, "rms_dbfs": level,
                    **({"vocal_rms_dbfs": level} if group == "vocals" else {})}

        await asyncio.to_thread(
            _write_status, song_id,
            **{cfg["key"]: {"state": "running", "started": int(time.time()), "rms_dbfs": level}},
        )
        call = separate_sub.spawn(song_id, "stem", SUB_OVERLAP, False, True, group)
        return {"id": song_id, "group": group, "state": "running",
                "call_id": str(call.object_id), "rms_dbfs": level,
                **({"vocal_rms_dbfs": level} if group == "vocals" else {})}

    # ---------------- şarkı sözleri (Aşama 11) --------------------------------

    @web.post("/songs/{song_id}/lyrics")
    async def start_lyrics(song_id: str, request: Request, _=auth):
        """Sözleri çıkarır ("auto") ya da yapıştırılan metni sese hizalar ("pasted").

        Gövde (JSON): {"mode": "auto|pasted", "language": "auto|tr|en|ja",
        "text": "...", "replace": false, "manual": [{"i": satır, "t": sn}]}. `manual`
        yalnız pasted: elle konan satır başları ÇAPA olarak korunur (i: boş olmayan
        satırların sıra numarası, 0'dan; t artan). Sıra: doğrulama, CPU'da "vokal yok"
        kontrolü (GPU AÇILMAZ), sonra GPU işi. Mevcut sonuç varsa auto tekrar
        koşmaz (`replace: true` ister; YAPIŞTIRILMIŞ sözün üstüne yazmak da
        buna bağlı). pasted her zaman koşar. Metin yalnız Volume'da durur.
        """
        try:
            body = await request.json()
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Govde JSON olmali")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Govde JSON nesnesi olmali")
        mode = body.get("mode", "auto")
        language = body.get("language", "auto")
        replace = body.get("replace") is True
        if mode not in LYRICS_MODES:
            raise HTTPException(status_code=400, detail="Gecersiz mod")
        if language != "auto" and language not in LYRICS_LANGS:
            raise HTTPException(status_code=400, detail="Gecersiz dil")
        text = ""
        lines = []
        if mode == "pasted":
            lines, problem = _lyr_check_text(body.get("text"))
            if problem:
                raise HTTPException(status_code=400, detail=problem)
            text = "\n".join(lines)
        elif body.get("manual") is not None:
            raise HTTPException(status_code=400, detail="manual yalniz pasted modunda")

        await gate.refresh(force=True)
        status = await require_status(song_id)
        if status.get("state") != "done" or not status.get("stems"):
            raise HTTPException(status_code=409, detail="Sarki henuz hazir degil")
        manual, problem = _lyr_check_manual(body.get("manual"), len(lines), float(status.get("duration") or 0))
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        if _lyrics_is_running(status):
            return {"id": song_id, "state": "running", "existing": True}
        if _tr_is_running(status):
            raise HTTPException(status_code=409, detail="Soz cevirisi surerken sozler degistirilemez")
        previous = status.get("lyrics") or {}
        if (mode == "auto" and not replace
                and previous.get("state") in ("done", "no_vocals", "no_lyrics")):
            return {"id": song_id, "state": previous["state"], "existing": True,
                    "source": previous.get("source")}

        stem_path = _song_dir(song_id) / "master" / "vocals.flac"
        if not await asyncio.to_thread(stem_path.exists):
            raise HTTPException(status_code=409, detail="vocals stem'i yok")
        async with gate.reading():
            level = await asyncio.to_thread(_sub_vocal_level, stem_path)
        level = round(level, 2)
        if level < LYRICS_SILENT_DBFS:
            if previous.get("state") != "done":
                await asyncio.to_thread(_write_status, song_id, lyrics={
                    "state": "no_vocals", "rms_dbfs": level,
                    "parent_stems_version": status.get("stems_version"),
                    "thresholds": {"silent_dbfs": LYRICS_SILENT_DBFS},
                    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return {"id": song_id, "state": "no_vocals", "rms_dbfs": level}

        keep = dict(previous) if previous.get("state") == "done" else None
        if keep:
            keep.pop("previous", None)
        await asyncio.to_thread(_write_status, song_id, lyrics={
            "state": "running", "started": int(time.time()), "mode": mode,
            "language_requested": language, "rms_dbfs": level, "previous": keep})
        call = extract_lyrics.spawn(song_id, mode, language, text, manual)
        return {"id": song_id, "state": "running", "mode": mode, "language": language,
                "call_id": str(call.object_id), "rms_dbfs": level}

    @web.post("/songs/{song_id}/lyrics/times")
    async def set_lyric_times(song_id: str, request: Request, _=auth):
        """Satır başlangıçlarını ELLE düzeltir (CPU, anında; GPU yok). Gövde:
        {"version": mevcut sürüm (isteğe bağlı), "set": [{"i": satır, "t": sn}]}. Satır `m: 1`
        (elle) işaretlenir; sonraki yeniden hizalamada çapa olarak korunur (`manual`).
        Başka cihazdan değişmişse (sürüm uyuşmuyorsa) 409."""
        try:
            body = await request.json()
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Govde JSON olmali")
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Govde JSON nesnesi olmali")
        await gate.refresh(force=True)
        status = await require_status(song_id)
        if _lyrics_is_running(status):
            raise HTTPException(status_code=409, detail="Sozler hazirlanirken duzeltilemez")
        lyr = status.get("lyrics") or {}
        path = _song_dir(song_id) / "lyrics.json"
        if lyr.get("state") != "done" or not await asyncio.to_thread(path.exists):
            raise HTTPException(status_code=409, detail="Duzeltilecek soz yok")
        version = body.get("version")
        if version is not None and version != lyr.get("version"):
            raise HTTPException(status_code=409, detail="Sozler baska bir yerden degismis; yenile")
        raw = await asyncio.to_thread(_read_slice, path)
        doc = json.loads(raw.decode("utf-8"))
        new_doc, problem = _lyr_apply_times(doc, body.get("set"), float(status.get("duration") or doc.get("duration") or 0))
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        new_version = max(int(time.time()), int(lyr.get("version") or 0) + 1)
        new_doc["version"] = new_version

        def write():
            tmp = path.with_name("lyrics.json.tmp")
            tmp.write_text(json.dumps(new_doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, path)                  # önce dosya (atomik), SONRA status
            _write_status(song_id, lyrics=dict(
                lyr, version=new_version, edited=True,
                manual_lines=sum(1 for line in new_doc["lines"] if line.get("m"))))

        await asyncio.to_thread(write)
        changed = [{"i": item["i"], "t": new_doc["lines"][item["i"]]["t"], "e": new_doc["lines"][item["i"]]["e"]}
                   for item in body["set"]]
        return {"id": song_id, "version": new_version, "changed": changed}

    @web.get("/songs/{song_id}/lyrics")
    async def get_lyrics(song_id: str, _=auth):
        """lyrics.json + durum özeti. Söz yoksa 404. `stale`: ana şarkı sonradan
        yeniden işlendi ("eski ayrıştırmadan")."""
        await gate.refresh()
        status = await require_status(song_id)
        path = _song_dir(song_id) / "lyrics.json"
        if not await asyncio.to_thread(path.exists):
            await gate.refresh(force=True)
            if not await asyncio.to_thread(path.exists):
                raise HTTPException(status_code=404, detail="Soz yok")
        raw = await asyncio.to_thread(_read_slice, path)
        lyr = status.get("lyrics") or {}
        return JSONResponse(
            {"state": lyr.get("state"), "stale": _lyr_stale(status),
             "source": lyr.get("source"), "language": lyr.get("language"),
             "version": lyr.get("version"), "warning": lyr.get("warning"),
             "lyrics": json.loads(raw.decode("utf-8"))},
            headers={"Cache-Control": "private, max-age=0, must-revalidate"})

    # ---------------- hedef melodi (Mikrofon paketi 9, 1. oturum) ----------------------

    @web.post("/songs/{song_id}/melody")
    async def start_melody(song_id: str, request: Request, _=auth):
        """Ana vokalin hedef melodisini çıkarır (CPU, pYIN). Gövde (isteğe bağlı):
        {"replace": false, "source": "auto" | "vocals" | "lead"}. Tamam sonuç varsa koşmaz (`existing`); `replace: true` yeniden üretir
        (ör. ana şarkı yeniden işlendiyse ya da alt parçalar sonradan ayrıldıysa). "Vokal yok" kapısı CPU'da, iş açılmadan elenir.
        Durum: `status.melody` (GET /songs/{id}); veri: GET /songs/{id}/melody."""
        replace = False
        source = "auto"
        with contextlib.suppress(ValueError, TypeError):
            body = await request.json()
            if isinstance(body, dict):
                replace = body.get("replace") is True
                source = body.get("source", "auto")
        if source not in MELODY_SOURCES:
            raise HTTPException(status_code=400, detail="Gecersiz kaynak")
        await gate.refresh(force=True)
        status = await require_status(song_id)
        if status.get("state") != "done" or not status.get("stems"):
            raise HTTPException(status_code=409, detail="Sarki henuz hazir degil")
        if _melody_is_running(status):
            return {"id": song_id, "state": "running", "existing": True}
        previous = status.get("melody") or {}
        if previous.get("state") in ("done", "no_vocals") and not replace:
            return {"id": song_id, "state": previous["state"], "existing": True, "source": previous.get("source"),
                    "stale": _melody_stale(status)}
        chosen, why = _melody_pick_source(status, source)
        if chosen is None:
            raise HTTPException(status_code=409, detail=why)
        lead_path = _melody_source_path(song_id, "lead")
        if chosen == "lead" and not await asyncio.to_thread(lead_path.exists):
            if source == "lead":
                raise HTTPException(status_code=409, detail="Ana vokal dosyasi yok")
            chosen, why = "vocals", "lead dosyasi yok (SW vokal stem'i)"
        stem_path = _song_dir(song_id) / "master" / "vocals.flac"
        if not await asyncio.to_thread(stem_path.exists):
            raise HTTPException(status_code=409, detail="vocals stem'i yok")
        async with gate.reading():
            level = await asyncio.to_thread(_sub_vocal_level, stem_path)
        level = round(level, 2)
        if level < MELODY_SILENT_DBFS:
            if previous.get("state") != "done":
                await asyncio.to_thread(_write_status, song_id, melody={
                    "state": "no_vocals", "rms_dbfs": level, "parent_stems_version": status.get("stems_version"),
                    "thresholds": {"silent_dbfs": MELODY_SILENT_DBFS},
                    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            return {"id": song_id, "state": "no_vocals", "rms_dbfs": level}
        keep = dict(previous) if previous.get("state") == "done" else None
        if keep:
            keep.pop("previous", None)
        await asyncio.to_thread(_write_status, song_id, melody={
            "state": "running", "started": int(time.time()), "source": chosen, "rms_dbfs": level, "previous": keep})
        call = extract_melody.spawn(song_id, chosen)
        return {"id": song_id, "state": "running", "source": chosen, "source_reason": why, "call_id": str(call.object_id),
                "rms_dbfs": level}

    @web.get("/songs/{song_id}/melody")
    async def get_melody(song_id: str, _=auth):
        """melody.bin (biçim: MELODY_FORMAT yorumu). Melodi yoksa 404. Başlıkta yöntem / kaynak / sürüm var; `stale` durumu
        `status.melody` + `stems_version` ile istemcide hesaplanır (tüm üstveri dosyanın içinde)."""
        await gate.refresh()
        await require_status(song_id)
        path = _song_dir(song_id) / "melody.bin"
        if not await asyncio.to_thread(path.exists):
            await gate.refresh(force=True)
            if not await asyncio.to_thread(path.exists):
                raise HTTPException(status_code=404, detail="Hedef melodi yok")
        async with gate.reading():
            body = await asyncio.to_thread(_read_slice, path)
        return Response(content=body, media_type="application/octet-stream",
                        headers={"Cache-Control": "private, max-age=0, must-revalidate"})

    # ---------------- söz çevirisi (Aşama 14) -----------------------------------

    async def read_json_file(path: pathlib.Path):
        """Volume'daki JSON dosyası (başka konteynerin commit'i için bir kez zorla yenile), yoksa None."""
        if not await asyncio.to_thread(path.exists):
            await gate.refresh(force=True)
            if not await asyncio.to_thread(path.exists):
                return None
        raw = await asyncio.to_thread(_read_slice, path)
        return json.loads(raw.decode("utf-8"))

    @web.post("/songs/{song_id}/translate")
    async def start_translate(song_id: str, request: Request, _=auth):
        """Sözleri Türkçeye çevirir (ve okunuş ekler: ja romaji, en Türkçe harfli telaffuz). Gövde (isteğe bağlı):
        {"replace": false, "reading": false}.

        Yalnız en/ja sözler (Türkçe 400). Çevirisi olmayan satırlar (yeni/değişen metin) çevrilir; hepsi
        varsa yeniden iş yok (`existing`). `replace: true` hepsini baştan çevirir. `reading: true` (yalnız en):
        ÇEVİRİYE DOKUNMADAN çevirisi olup telaffuzu olmayan satırlara telaffuz ekler. Durum: GET .../translation.
        """
        replace = False
        reading = False
        with contextlib.suppress(ValueError, TypeError):
            body = await request.json()
            replace = isinstance(body, dict) and body.get("replace") is True
            reading = isinstance(body, dict) and body.get("reading") is True
        await gate.refresh(force=True)
        status = await require_status(song_id)
        if _lyrics_is_running(status):
            raise HTTPException(status_code=409, detail="Sozler hazirlanirken cevrilemez")
        if (status.get("lyrics") or {}).get("state") != "done":
            raise HTTPException(status_code=409, detail="Once sozler gerekli")
        doc = await read_json_file(_song_dir(song_id) / "lyrics.json")
        lines = [str(item.get("text") or "") for item in (doc or {}).get("lines") or []]
        if not lines:
            raise HTTPException(status_code=409, detail="Once sozler gerekli")
        lang = doc.get("language")
        if lang == "tr":
            raise HTTPException(status_code=400, detail="Turkce sozler cevrilmez")
        if lang not in TRANSLATE_LANGS:
            raise HTTPException(status_code=400, detail="Bu dildeki sozler cevrilemez")
        if reading and lang != "en":
            raise HTTPException(status_code=400, detail="Okunus ekleme yalniz Ingilizce icin")
        if _tr_is_running(status):
            return {"id": song_id, "state": "running", "existing": True}
        existing = await read_json_file(_song_dir(song_id) / "translation.json")
        items = dict((existing or {}).get("items") or {}) if existing and existing.get("lang") == lang and not (replace and not reading) else {}
        if reading:
            if not any(item.get("tr") for item in items.values()):
                raise HTTPException(status_code=409, detail="Once ceviri gerekli")
            todo = _tr_missing_reading(lines, items)
            if not todo:
                return {"id": song_id, "state": "done", "existing": True, "missing": 0}
        else:
            todo = _tr_missing(lines, items)
            if not todo and not replace:
                return {"id": song_id, "state": "done", "existing": True, "missing": 0}
        await asyncio.to_thread(_write_status, song_id, translation={
            "state": "running", "started": int(time.time()), "lang": lang, "todo": len(todo),
            **({"mode": "reading"} if reading else {})})
        call = translate_lyrics.spawn(song_id, replace, "reading") if reading else translate_lyrics.spawn(song_id, replace)
        return {"id": song_id, "state": "running", "lang": lang, "todo": len(todo), "call_id": str(call.object_id)}

    @web.get("/songs/{song_id}/translation")
    async def get_translation(song_id: str, _=auth):
        """Çeviri, sözlerin GÜNCEL satırlarına hizalı: lines[i] = {tr, ro?} ya da null (çevrilmedi).
        Metni değişen satır null olur (`missing`); zamanlar/sıra değişse de çeviri korunur."""
        await gate.refresh()
        status = await require_status(song_id)
        doc = await read_json_file(_song_dir(song_id) / "lyrics.json")
        stored = await read_json_file(_song_dir(song_id) / "translation.json")
        if not doc or not stored:
            raise HTTPException(status_code=404, detail="Ceviri yok")
        lines = [str(item.get("text") or "") for item in doc.get("lines") or []]
        view, missing = _tr_lines_view(lines, stored.get("items") or {})
        record = status.get("translation") or {}
        running = _tr_is_running(status)
        return JSONResponse(
            {"state": "running" if running else record.get("state"), "code": record.get("code"),
             "message": record.get("message"), "lang": stored.get("lang"), "version": stored.get("version"),
             "model": stored.get("model"), "missing": missing,
             "has_reading": stored.get("lang") == "ja" or any(x and x.get("ro") for x in view),
             "lines": view},
            headers={"Cache-Control": "private, max-age=0, must-revalidate"})

    # ---------------- miks dışa aktarma (Aşama 12) ------------------------------

    def export_path(song_id: str, digest: str, fmt: str) -> pathlib.Path:
        return _song_dir(song_id) / "exports" / f"{digest}.{fmt}"

    async def export_meta(song_id: str, digest: str):
        """Hazır dışa aktarma varsa (dosya + yan json) sidecar sözlüğü, yoksa None."""
        folder = _song_dir(song_id) / "exports"
        sidecar = folder / f"{digest}.json"
        for _ in range(2):
            if await asyncio.to_thread(sidecar.exists):
                try:
                    raw = await asyncio.to_thread(_read_slice, sidecar)
                    meta = json.loads(raw.decode("utf-8"))
                except (OSError, ValueError):
                    return None
                fmt = meta.get("format")
                if fmt in EXPORT_FORMATS and await asyncio.to_thread(export_path(song_id, digest, fmt).exists):
                    return meta
                return None
            await gate.refresh(force=True)         # başka konteyner yeni commit etmiş olabilir
        return None

    @web.post("/songs/{song_id}/export")
    async def start_export(song_id: str, request: Request, _=auth):
        """Mikser ayarını tek ses dosyasına çevirir (sunucuda, CPU).

        Gövde (JSON): {format: m4a|wav, gains: {kanal: 0..2}, master: 0..1.5,
        region: {a, b} | null, rate: 0.5..1.5, semitones: -6..6, label}. `gains`
        istemcinin hesapladığı dosya başına nihai kazançtır (alt parça açıksa ana kanal
        yok). Aynı ayar için dosya varsa tekrar üretilmez. Durum: GET .../export/{hash}.
        """
        try:
            body = await request.json()
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Govde JSON olmali")
        await gate.refresh(force=True)
        status = await require_status(song_id)
        if status.get("state") != "done" or not status.get("stems"):
            raise HTTPException(status_code=409, detail="Sarki henuz hazir degil")
        spec, problem = _export_check(body, status)
        if problem:
            raise HTTPException(status_code=400, detail=problem)
        digest = _export_hash(spec)

        meta = await export_meta(song_id, digest)
        if meta:
            with contextlib.suppress(OSError):          # önbellek isabeti 24 saati yeniler
                await asyncio.to_thread(os.utime, export_path(song_id, digest, spec["format"]))
            return {"id": song_id, "hash": digest, "state": "done", "existing": True,
                    "filename": meta["filename"], "bytes": meta.get("bytes"),
                    "duration": meta.get("duration")}
        record = status.get("export") or {}
        if _export_is_running(status):
            if record.get("hash") == digest:
                return {"id": song_id, "hash": digest, "state": "running", "existing": True}
            raise HTTPException(status_code=409, detail="Baska bir disa aktarma suruyor")

        await asyncio.to_thread(_write_status, song_id, export={
            "state": "running", "hash": digest, "format": spec["format"], "started": int(time.time())})
        call = export_mix.spawn(song_id, digest, spec)
        return {"id": song_id, "hash": digest, "state": "running", "format": spec["format"],
                "call_id": str(call.object_id)}

    @web.get("/songs/{song_id}/export/{digest}")
    async def get_export(song_id: str, digest: str, _=auth):
        if not EXPORT_HASH_RE.match(digest):
            raise HTTPException(status_code=400, detail="Gecersiz hash")
        await gate.refresh()
        status = await require_status(song_id)
        meta = await export_meta(song_id, digest)
        if meta:
            return {"id": song_id, "hash": digest, "state": "done", "filename": meta["filename"],
                    "format": meta["format"], "bytes": meta.get("bytes"),
                    "duration": meta.get("duration"), "peak_db": meta.get("peak_db")}
        record = status.get("export") or {}
        if record.get("hash") != digest:
            raise HTTPException(status_code=404, detail="Disa aktarma yok ya da suresi doldu")
        if record.get("state") == "running" and not _export_is_running(status):
            return {"id": song_id, "hash": digest, "state": "error", "message": "Is takildi, yeniden dene"}
        return {"id": song_id, "hash": digest, "state": record.get("state"),
                "message": record.get("message")}

    @web.post("/songs/{song_id}/export/{digest}/link")
    async def export_link(song_id: str, digest: str, request: Request, _=auth):
        """Hazır dosya için imzalı indirme linki (<a> başlık gönderemez)."""
        if not EXPORT_HASH_RE.match(digest):
            raise HTTPException(status_code=400, detail="Gecersiz hash")
        await gate.refresh()
        await require_status(song_id)
        meta = await export_meta(song_id, digest)
        if not meta:
            raise HTTPException(status_code=404, detail="Disa aktarma yok ya da suresi doldu")
        expires = int(time.time()) + DOWNLOAD_TTL
        signature = _sign_download(signing_key, song_id, f"export{digest}", meta["format"], expires)
        base = str(request.base_url).rstrip("/")
        url = (f"{base}/songs/{song_id}/export-file/{digest}"
               f"?format={meta['format']}&exp={expires}&sig={signature}")
        return {"url": url, "expires_at": expires, "ttl": DOWNLOAD_TTL, "filename": meta["filename"],
                "format": meta["format"], "bytes": meta.get("bytes")}

    @web.get("/songs/{song_id}/export-file/{digest}")
    async def export_file(song_id: str, digest: str, format: str = "m4a", exp: int = 0, sig: str = ""):
        # Bu uç nokta BİLEREK token istemiyor; yetki imzada (download ile aynı).
        if format not in EXPORT_FORMATS or not EXPORT_HASH_RE.match(digest):
            raise HTTPException(status_code=400, detail="Gecersiz istek")
        expected = _sign_download(signing_key, song_id, f"export{digest}", format, exp)
        if not sig or not hmac.compare_digest(sig, expected):
            raise HTTPException(status_code=403, detail="Imza gecersiz")
        if exp < int(time.time()):
            raise HTTPException(status_code=403, detail="Link suresi gecmis")
        if not _is_valid_song_id(song_id):
            raise HTTPException(status_code=400, detail="Gecersiz sarki kimligi")
        meta = await export_meta(song_id, digest)
        if not meta or meta.get("format") != format:
            raise HTTPException(status_code=404, detail="Dosya bulunamadi")
        path = export_path(song_id, digest, format)
        async with gate.reading():
            body = await asyncio.to_thread(_read_slice, path)
        media = "audio/mp4" if format == "m4a" else "audio/wav"
        return Response(
            content=body, media_type=media,
            headers={"Content-Disposition": _content_disposition(meta["filename"]),
                     "Content-Length": str(len(body))})

    # ---------------- imzalı indirme ----------------------------------------

    @web.post("/songs/{song_id}/download-link")
    async def download_link(song_id: str, request: Request,
                            name: str, format: str = "m4a", _=auth):
        if format not in DOWNLOAD_FORMATS:
            raise HTTPException(
                status_code=400,
                detail=f"format {'/'.join(DOWNLOAD_FORMATS)} olmali",
            )
        if "/" in name or "." in name or not name.isalnum():
            raise HTTPException(status_code=400, detail="Gecersiz stem adi")
        await require_status(song_id)

        expires = int(time.time()) + DOWNLOAD_TTL
        signature = _sign_download(signing_key, song_id, name, format, expires)
        base = str(request.base_url).rstrip("/")
        url = (
            f"{base}/songs/{song_id}/download/{name}"
            f"?format={format}&exp={expires}&sig={signature}"
        )
        # <a> etiketi header gonderemedigi icin token yerine imzali URL.
        return {"url": url, "expires_at": expires, "ttl": DOWNLOAD_TTL}

    @web.get("/songs/{song_id}/download/{name}")
    async def download(song_id: str, name: str, format: str = "m4a",
                       exp: int = 0, sig: str = ""):
        # Bu uç nokta BİLEREK token istemiyor; yetki imzada.
        if format not in DOWNLOAD_FORMATS:
            raise HTTPException(status_code=400, detail="Gecersiz format")
        if "/" in name or "." in name or not name.isalnum():
            raise HTTPException(status_code=400, detail="Gecersiz stem adi")
        expected = _sign_download(signing_key, song_id, name, format, exp)
        if not sig or not hmac.compare_digest(sig, expected):
            raise HTTPException(status_code=403, detail="Imza gecersiz")
        if exp < int(time.time()):
            raise HTTPException(status_code=403, detail="Link suresi gecmis")

        song_dir = _song_dir(song_id)
        if format == "m4a":
            source = song_dir / "stems" / f"{name}.m4a"
            media = "audio/mp4"
        else:
            source = song_dir / "master" / f"{name}.flac"
            media = "audio/flac" if format == "flac" else "audio/wav"

        if not await asyncio.to_thread(source.exists):
            await gate.refresh(force=True)
            if not await asyncio.to_thread(source.exists):
                raise HTTPException(status_code=404, detail="Dosya bulunamadi")

        async with gate.reading():
            if format == "wav":
                body = await asyncio.to_thread(_wav_from_flac, source)
            else:
                body = await asyncio.to_thread(_read_slice, source)

        status = await load_status(song_id)
        title = (status or {}).get("title") or song_id[:12]
        filename = _download_filename(str(title), name, format)

        return Response(
            content=body,
            media_type=media,
            headers={
                "Content-Disposition": _content_disposition(filename),
                "Content-Length": str(len(body)),
            },
        )

    # ---------------- yeniden analiz / silme --------------------------------

    @web.post("/songs/{song_id}/reprocess")
    async def reprocess(song_id: str, quality: str = DEFAULT_QUALITY, _=auth):
        """Ayrıştırmayı yeniden koşturur; akor ve vuruşa DOKUNMAZ.

        Mevcut şarkıları Hi-Fi'a taşımak için. chords.json / beats.json
        yerinde kalıyor, yalnız stem'ler yenileniyor ve stems_version
        artıyor (telefon önbelleği bayat ses çalmasın).
        """
        status = await require_status(song_id)
        if status.get("state") in ("separating", "analyzing"):
            raise HTTPException(status_code=409, detail="Sarki zaten isleniyor")
        if _sub_is_running(status):
            raise HTTPException(status_code=409,
                                detail="Alt parcalar ayrilirken yeniden islenemez")
        if _lyrics_is_running(status):
            raise HTTPException(status_code=409,
                                detail="Sozler hazirlanirken yeniden islenemez")
        if _export_is_running(status):
            raise HTTPException(status_code=409,
                                detail="Disa aktarma surerken yeniden islenemez")
        if _tr_is_running(status):
            raise HTTPException(status_code=409,
                                detail="Soz cevirisi surerken yeniden islenemez")
        if _melody_is_running(status):
            raise HTTPException(status_code=409,
                                detail="Hedef melodi hazirlanirken yeniden islenemez")
        chosen = quality if quality in QUALITIES else DEFAULT_QUALITY
        call = separate.spawn(song_id, chosen, True)
        return {"id": song_id, "call_id": str(call.object_id),
                "state": "separating", "quality": chosen}

    @web.post("/songs/{song_id}/reanalyze")
    async def reanalyze(song_id: str, beats: str = "auto", _=auth):
        status = await require_status(song_id)
        if not status.get("stems"):
            raise HTTPException(
                status_code=409, detail="Sarki henuz ayristirilmamis"
            )
        call = analyze.spawn(song_id, beats)
        return {"id": song_id, "call_id": str(call.object_id), "state": "analyzing"}

    # Silme: tek şarkı ve çoklu. İkisi de aynı yardımcıdan geçiyor.
    #
    # `outcome` alanı: deleted | not_found | busy | invalid
    # Olmayan bir kimliği silmek HATA DEĞİL: kullanıcı iki cihazdan aynı
    # şarkıyı silmiş olabilir, ya da liste bayattır. İstenen sonuç zaten
    # gerçekleşmiş durumda.
    async def remove_one(song_id: str, commit: bool = True) -> dict:
        try:
            song_dir = _safe_song_dir(song_id)
        except ValueError as error:
            print(f"[sil] REDDEDILDI: {error}")
            return {"id": str(song_id)[:80], "outcome": "invalid",
                    "detail": "Gecersiz sarki kimligi"}

        status = await load_status(song_id)
        if status is None:
            # Liste bayat olabilir; silmeden önce bir kez tazeleyip bakıyoruz.
            await gate.refresh(force=True)
            status = await load_status(song_id)
        exists = status is not None or await asyncio.to_thread(song_dir.is_dir)
        if not exists:
            return {"id": song_id, "outcome": "not_found"}

        reason = _delete_block_reason(status)
        if reason:
            return {"id": song_id, "outcome": "busy", "detail": reason,
                    "state": str((status or {}).get("state") or "")}

        title = str((status or {}).get("title") or "")
        try:
            # Klasörün TAMAMI gidiyor: stems/, master/ (FLAC asıllar),
            # status.json, chords.json, beats.json, input.* - yani kütüphane
            # kaydı da. Hash'e bağlı başka bir kayıt yok (kitaplık listesi
            # klasörleri tarayarak üretiliyor), dolayısıyla aynı dosya
            # yeniden yüklenirse sıfırdan işlenir.
            await volume.remove_file.aio(f"songs/{song_id}", recursive=True)
        except FileNotFoundError:
            return {"id": song_id, "outcome": "not_found"}
        if commit:
            await volume.commit.aio()
            await gate.refresh(force=True)
        print(f"[sil] {song_id} ({title})")
        return {"id": song_id, "outcome": "deleted", "title": title}

    @web.delete("/songs/{song_id}")
    async def delete_song(song_id: str, _=auth):
        result = await remove_one(song_id)
        if result["outcome"] == "invalid":
            raise HTTPException(status_code=400, detail=result["detail"])
        if result["outcome"] == "busy":
            raise HTTPException(status_code=409, detail=result["detail"])
        return JSONResponse({
            "id": result["id"],
            "deleted": result["outcome"] == "deleted",
            "outcome": result["outcome"],
        })

    @web.post("/songs/delete")
    async def delete_songs(request: Request, _=auth):
        """Çoklu silme. Gövde: {"ids": [...]}.

        Kısmi başarı normal sayılıyor: her kimlik için ayrı `outcome`
        dönüyor, HTTP durumu 200. Tek tek istek atmak yerine tek istek
        olmasının sebebi Volume: commit ve reload silme başına değil, sonunda
        BİR KEZ yapılıyor.
        """
        try:
            body = await request.json()
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="Govde JSON olmali")
        ids = body.get("ids") if isinstance(body, dict) else None
        if not isinstance(ids, list) or not ids:
            raise HTTPException(status_code=400, detail="ids listesi gerekli")
        if len(ids) > MAX_DELETE_IDS:
            raise HTTPException(
                status_code=400,
                detail=f"Tek istekte en fazla {MAX_DELETE_IDS} sarki silinebilir",
            )

        results = []
        for song_id in ids:
            results.append(await remove_one(song_id, commit=False))

        if any(item["outcome"] == "deleted" for item in results):
            await volume.commit.aio()
            await gate.refresh(force=True)

        counts = {}
        for item in results:
            counts[item["outcome"]] = counts.get(item["outcome"], 0) + 1
        return {"results": results, "counts": counts,
                "deleted": counts.get("deleted", 0)}

    return web


# --------------------------------------------------------------------------
# Yerel entrypoint
# --------------------------------------------------------------------------


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


BARS_PER_LINE = 4


def _bars_from_chords(data: dict):
    """chords.json'ı (ölçü başlangıcı, o ölçüde duyulan akorlar) listesine çevirir."""
    downbeats = data.get("downbeats") or []
    chords = data.get("chords") or []
    if not downbeats:
        return []

    end_time = chords[-1]["end"] if chords else downbeats[-1]
    bars = []
    for index, start in enumerate(downbeats):
        stop = downbeats[index + 1] if index + 1 < len(downbeats) else end_time
        if stop <= start:
            continue
        labels = []
        for chord in chords:
            # Ölçüyle kesişen her akor; ardışık aynı etiketi tekrar yazmıyoruz.
            if chord["end"] > start + 1e-6 and chord["start"] < stop - 1e-6:
                if not labels or labels[-1] != chord["label"]:
                    labels.append(chord["label"])
        bars.append((float(start), labels or ["-"]))
    return bars


def _mmss(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 60}:{total % 60:02d}"


def _format_chord_chart(data: dict, bars_per_line: int = BARS_PER_LINE) -> str:
    """Okunabilir akor çizelgesi: satır başına 4 ölçü, başında dakika:saniye."""
    bars = _bars_from_chords(data)
    header = f"bpm: {data.get('bpm')}"
    if not bars:
        return f"{header}\n(downbeat bulunamadi, cizelge cizilemedi)"

    cells = ["  ".join(labels) for _start, labels in bars]
    width = max(5, max(len(cell) for cell in cells))

    lines = [header, f"olcu sayisi: {len(bars)}", ""]
    for offset in range(0, len(bars), bars_per_line):
        chunk = bars[offset : offset + bars_per_line]
        stamp = _mmss(chunk[0][0]).ljust(6)
        row = "".join(
            f"| {cells[offset + i].ljust(width)}" for i in range(len(chunk))
        )
        lines.append(f"{stamp}{row}|")
    return "\n".join(lines)


def _wait_for_done(song_id: str, timeout: int = 600, interval: int = 3) -> dict:
    """status.json'ı done veya error olana kadar yoklar."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status = get_status.remote(song_id) or {}
        state = status.get("state")
        if state != last:
            print(f"  durum: {state}  ilerleme: {status.get('progress')}")
            last = state
        if state in ("done", "error"):
            return status
        time.sleep(interval)
    raise SystemExit(f"Zaman asimi: {song_id} hala {last}")


def _download(song_id: str, out: str, masters: bool) -> pathlib.Path:
    """Stem'leri ve chords.json'ı PC'ye indirir."""
    dest_root = pathlib.Path(out) / song_id
    prefixes = ["stems", "master"] if masters else ["stems"]
    print(f"\nindiriliyor -> {dest_root}  ({', '.join(prefixes)}, chords.json)")

    for prefix in prefixes:
        for entry in volume.listdir(f"songs/{song_id}/{prefix}"):
            dest = dest_root / prefix / pathlib.PurePosixPath(entry.path).name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as handle:
                for chunk in volume.read_file(entry.path):
                    handle.write(chunk)
            print(f"  {dest}  ({dest.stat().st_size / 1024**2:.2f} MB)")

    for name in ("chords.json", "beats.json", "status.json"):
        dest = dest_root / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            with dest.open("wb") as handle:
                for chunk in volume.read_file(f"songs/{song_id}/{name}"):
                    handle.write(chunk)
        except FileNotFoundError:
            print(f"  {name} yok, atlandi")
            continue
        print(f"  {dest}")
    return dest_root


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
        if not existing.get("bpm"):
            print(
                "  not: bu sarki eski bir analizden geliyor. Egitilmis "
                "beat/downbeat icin:\n"
                "  modal run backend/app.py::beats_only --path <dosya>"
            )
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
        print("\n===== ayristirma sonucu =====")
        for key, value in result.items():
            print(f"{key}: {value}")

        # separate, analyze'i spawn edip cikti; analiz ayri bir CPU
        # konteynerinde suruyor.
        print("\nanaliz (CPU) bekleniyor...")
        status = _wait_for_done(song_id)
        print(f"durum: {status.get('state')}  bpm: {status.get('bpm')}  "
              f"akor sayisi: {status.get('chord_count')}")
        if status.get("state") == "error":
            raise SystemExit(f"Analiz hatasi: {status.get('error')}")

    dest_root = _download(song_id, out, masters)

    chords_file = dest_root / "chords.json"
    if chords_file.exists():
        print("\n===== akor cizelgesi =====")
        print(_format_chord_chart(json.loads(chords_file.read_text(encoding="utf-8"))))

    print("\nBitti.")


def _resolve_song_id(song_id: str, path: str) -> str:
    if not song_id and not path:
        raise SystemExit("--song-id veya --path vermelisin")
    if song_id:
        return song_id
    src = pathlib.Path(path).expanduser()
    if not src.is_file():
        raise SystemExit(f"Dosya bulunamadi: {src}")
    resolved = _sha256(src)
    print(f"sha256: {resolved}")
    return resolved


@app.local_entrypoint()
def beats_only(song_id: str = "", path: str = "", out: str = "out",
               reanalyze: bool = True):
    """Yalnızca beat_this'i çalıştırır (T4), ayrıştırmayı TEKRARLAMAZ.

    Zaten "done" olan şarkılar için beats.json üretmenin yolu bu; ana akış
    ayrıştırmayı atladığı için beats.json hiç oluşmuyordu.

    modal run backend/app.py::beats_only --path sarki.mp3
    """
    song_id = _resolve_song_id(song_id, path)

    existing = get_status.remote(song_id)
    if not existing:
        raise SystemExit(f"{song_id} icin kayit yok; once ayristirma gerekiyor.")

    print("beat/downbeat takibi (T4, beat_this, ozgun mix uzerinde)...")
    summary = track_beats.remote(song_id)
    print("\n===== beat sonucu =====")
    for key, value in summary.items():
        print(f"{key}: {value}")

    if not reanalyze:
        return
    if not existing.get("stems"):
        print("\nstem yok, analiz atlandi.")
        return

    print("\nanaliz (CPU, GPU yok)...")
    _run_analysis(song_id, out)


@app.local_entrypoint()
def analyze_only(song_id: str = "", path: str = "", out: str = "out",
                 beats: str = "auto"):
    """Yalnızca analizi yeniden çalıştırır - GPU'ya hiç dokunmaz.

    modal run backend/app.py::analyze_only --song-id <sha256>
    modal run backend/app.py::analyze_only --path sarki.mp3
    modal run backend/app.py::analyze_only --path sarki.mp3 --beats librosa
    """
    song_id = _resolve_song_id(song_id, path)

    existing = get_status.remote(song_id)
    if not existing:
        raise SystemExit(f"{song_id} icin kayit yok; once ayristirma gerekiyor.")
    if not existing.get("stems"):
        raise SystemExit(
            f"{song_id} henuz ayristirilmamis (durum: {existing.get('state')})."
        )

    print(f"analiz (CPU, GPU yok, beats={beats})...")
    _run_analysis(song_id, out, beats_source=beats)


def _run_analysis(song_id: str, out: str, beats_source: str = "auto"):
    summary = analyze.remote(song_id, beats_source)
    print("\n===== analiz sonucu =====")
    for key, value in summary.items():
        print(f"{key}: {value}")

    dest_root = pathlib.Path(out) / song_id
    dest_root.mkdir(parents=True, exist_ok=True)
    # chords.json + beats.json: ham beat zamanlarını yerelde inceleyebilmek
    # icin beats.json da iniyor (stem/master indirilmiyor).
    for name in ("chords.json", "beats.json"):
        dest = dest_root / name
        try:
            with dest.open("wb") as handle:
                for chunk in volume.read_file(f"songs/{song_id}/{name}"):
                    handle.write(chunk)
        except FileNotFoundError:
            print(f"  {name} yok, atlandi")
            continue
        print(f"  {dest}")

    chords_file = dest_root / "chords.json"
    print("\n===== akor cizelgesi =====")
    print(_format_chord_chart(json.loads(chords_file.read_text(encoding="utf-8"))))

