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
    num_stems = int(config["model"].get("num_stems", 1))
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
        "librosa==0.11.0",         # yalnız mel filtre bankası için (filters)
        "numba==0.62.1",
        "PyYAML==6.0.2",
        "tqdm==4.67.1",
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


@app.function(
    image=sub_image,
    gpu="T4",
    volumes={DATA_DIR: volume},
    timeout=1800,
    max_containers=1,       # min_containers YOK: boştayken maliyet sıfır
)
def separate_sub(song_id: str, paths: str = "stem", overlap: int = SUB_OVERLAP,
                 experiment: bool = False) -> dict:
    """Vokali ana / arka vokale böler.

    paths: "stem" (SW vokal stem'i girdi), "mix" (tam karışım girdi) ya da
    "stem,mix". Model BİR kez yüklenir. Ana = model çıktısı, arka = SW vokal -
    ana (her iki yolda).

    experiment=True: `/data/sub-exp/<id>/<yol>/` altına ana/arka float32 WAV
    yazılır (kulak testi kesitleri için). Canlı şarkıya HİÇBİR ŞEY yazılmaz;
    status.json'a dokunulmaz. (Üretimde `stems/sub/` + `status.sub` sonraki
    oturumların işi.)

    Dönen: ölçümler, süreler ve maliyet tahmini (düz Python).
    """
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


@app.function(image=sub_cpu_image, volumes={DATA_DIR: volume}, timeout=300)
def sub_cleanup_run(dry_run: bool = True, only: str = "") -> dict:
    """`<id>-sb<harf>s` kesit şarkılarını ve /data/sub-exp'i siler.

    only: doluysa YALNIZ bu kaynak şarkı kimliğinin (öneki) kesitleri ve
    sub-exp klasörü silinir; diğerleri kalır.
    """
    volume.reload()
    root = pathlib.Path(DATA_DIR) / "songs"
    pattern = re.compile(r"^[0-9a-f]{64}-sb[a-z]s$")
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

    @web.get("/songs/{song_id}/stems/{name}.m4a")
    async def get_stem(song_id: str, name: str, request: Request, _=auth):
        if "/" in name or "." in name or not name.isalnum():
            raise HTTPException(status_code=400, detail="Gecersiz stem adi")
        path = _song_dir(song_id) / "stems" / f"{name}.m4a"

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
