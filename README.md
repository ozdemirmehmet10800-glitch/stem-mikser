# Stem Mikser

Kişisel kullanım için Moises benzeri stem ayrıştırıcı ve mikser.
Ayrıntılı proje planı ve çalışma kuralları: [PLAN.md](PLAN.md).

- **Arka uç:** Modal (`api` CPU + `separate` T4 GPU + `analyze` CPU), tek Volume (`stems-vol`)
- **Ön yüz:** GitHub Pages üzerinde vanilla HTML/CSS/JS PWA (build adımı yok)
- **Maliyet:** hiçbir fonksiyonda sıcak konteyner yok; boştayken ücret sıfır

## Kurulum (PC, yalnızca geliştirme/deploy için)

Sisteme global kurulum yapılmaz; her şey proje içindeki `.venv` altındadır.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\modal.exe setup
```

`modal setup` tarayıcı açar ve `%USERPROFILE%\.modal.toml` dosyasını oluşturur.

PowerShell'de `Activate.ps1` execution policy yüzünden çalışmazsa venv'i hiç
aktive etmeyin; aşağıdaki komutlarda olduğu gibi doğrudan
`.\.venv\Scripts\modal.exe` çağırın.

## Test komutları

**Aşama 0 – duman testi (T4 + torch CUDA):**

```powershell
.\.venv\Scripts\modal.exe run backend\smoke.py
```

**Aşama 1 – ayrıştırma (bir şarkıyı işler ve stem'leri PC'ye indirir):**

```powershell
.\.venv\Scripts\modal.exe run backend\app.py --path sarki.mp3
```

Çıktılar `out\<sha256>\` altına iner:

- `stems\*.m4a` – oynatma için AAC 160 kbps
- `master\*.flac` – kayıpsız 24-bit master

Ek bayraklar:

| Bayrak | Anlamı |
|---|---|
| `--out KLASOR` | indirme klasörü (varsayılan `out`) |
| `--force` | dosya daha önce işlenmiş olsa da yeniden işle |
| `--no-masters` | FLAC master'ları indirme (6 kanal ~200 MB eder), yalnızca m4a indir |

Aynı dosya (sha256 aynı) daha önce işlendiyse yeniden işlenmez, mevcut sonuç
indirilir.

Sınırlar: en fazla **30 MB** ve **10 dakika**. İkisi de GPU'ya girilmeden CPU
tarafında kontrol edilir; aşılırsa anlamlı bir hata döner.

**Aşama 2 – yalnızca analizi yeniden çalıştır (GPU'ya hiç dokunmaz):**

```powershell
.\.venv\Scripts\modal.exe run backend\app.py::analyze_only --path sarki.mp3
```

`--song-id <sha256>` ile de çağrılabilir. Akor/ölçü parametrelerini ucuza
denemek için bu yol kullanılır; mevcut FLAC master'lardan okur.

Her iki komut da bitişte terminale okunabilir bir akor çizelgesi basar
(satır başına 4 ölçü, satır başında dakika:saniye, üstte bpm):

```
bpm: 117.45
olcu sayisi: 38

0:00  | C    | Am   | F    | G    |
0:08  | C    | Am   | F    | G  C |
```

Bir ölçü içinde akor değişiyorsa ikisi de yazılır (`| G  C |`).

**Yalnızca beat/downbeat takibi (T4, ayrıştırmayı tekrarlamaz):**

```powershell
.\.venv\Scripts\modal.exe run backend\app.py::beats_only --path sarki.mp3
```

Zaten işlenmiş şarkılar için `beats.json` üretmenin yolu bu — ana akış
ayrıştırmayı atladığı için `beats.json` hiç oluşmaz. Bitişte analizi de
yeniden çalıştırır (`--no-reanalyze` ile kapatılabilir).

Beat/downbeat'i eğitilmiş model yerine librosa'nın kural tabanlı yoluyla
karşılaştırmak için:

```powershell
.\.venv\Scripts\modal.exe run backend\app.py::analyze_only --path sarki.mp3 --beats librosa
```

**Referansla ölçü ölçü karşılaştırma:**

```powershell
.\.venv\Scripts\python.exe tests\compare_reference.py
```

En son inen `out\*\chords.json`'u gömülü Moises referansıyla karşılaştırır.
`chords.json`, `beats.json` ve `status.json` her indirmede `out\<sha>\`
altına iner.
Ölçü hizalaması **yalnızca tam ölçü** cinsinden aranır; vuruş düzeyindeki
kayma ayrıca ölçülüp raporlanır (`downbeat'lerin beat indeksi mod 4`).

**Akor mantığının yerel testi (Modal'a bağlanmaz, ücretsiz, saniyeler):**

```powershell
.\.venv\Scripts\python.exe tests\test_chords_local.py
```

Sentetik üretilmiş bir akor dizisiyle şablonları, kök bonusunu, viterbi'yi,
downbeat fazını, birleştirmeyi ve JSON şeklini doğrular.

## Geliştirme / deploy

```powershell
.\.venv\Scripts\modal.exe serve backend\app.py
```

```powershell
.\.venv\Scripts\modal.exe deploy backend\app.py
```

`serve` geliştirme sırasında (kod değişince otomatik yeniden yükler),
`deploy` kalıcı kurulum için kullanılır. Deploy sonrası sistem PC kapalıyken
de çalışır.

## Modal Volume düzeni

```
/songs/{sha256}/input.{ext}
/songs/{sha256}/stems/{vocals,drums,bass,guitar,piano,other}.m4a   # oynatma
/songs/{sha256}/master/{...}.flac                                  # kayıpsız
/songs/{sha256}/chords.json                                        # Aşama 2
/songs/{sha256}/status.json
```

`status.json` durumları: `queued | separating | analyzing | done | error`
(`progress` 0-100, hata mesajı, başlık, süre, `created_at`).

## Sabitlenen sürümler ve gerekçeleri

| Paket | Sürüm | Neden |
|---|---|---|
| `modal` | 1.5.5 | `min_containers`/`max_containers` ve `fastapi_endpoint` bu sürümde geçerli |
| `torch` | 2.5.1 | torch 2.6'da `torch.load` varsayılanı `weights_only=True` oldu; demucs checkpoint yüklemesini kırabilir |
| `demucs` | 4.1.0 | `htdemucs_6s`, `torch>=2.1` |
| `numpy` | 1.26.4 | numpy 2 ile eski ekosistem kodunda kırılma riski |
| `soundfile` | 0.13.1 | FLAC yazımı; libsndfile wheel içinde geliyor |
| `librosa` | 0.11.0 | akor/beat analizi. 1.0.0 `python>=3.12` + `numpy>=2.1` istiyor ve büyük sürüm atlaması API riski taşıyor; 0.11.0 aynı numpy 1.26.4 ile çalışıyor |
| `numba` | 0.62.1 | librosa'nın bağımlılığı; `numpy<2.4` kısıtı 1.26.4 ile uyumlu |
| `beat-this` | 1.1.0 | eğitilmiş beat/downbeat modeli (CPJKU, MIT). `--no-deps` ile kurulup bağımlılıkları elle sabitlenir |
| `rotary-embedding-torch` | 0.9.1 | beat-this bağımlılığı; `torch>=2.4` istiyor |
| `soxr` | 1.1.0 | beat-this bağımlılığı; cp311 wheel'i var |
| `einops` / `tqdm` | 0.8.2 / 4.67.1 | beat-this bağımlılıkları |
| `torchaudio` | 2.5.1 | demucs için gerekmiyor ama beat_this'in import zinciri (`inference.py` → `preprocessing.py`) modül düzeyinde import ediyor ve `LogMelSpect` mel dönüşümü için kullanıyor. **Bizim kodumuz ses I/O'su için kullanmıyor** — okuma ffmpeg, yazma soundfile. Sürüm torch ile birebir eşleşiyor. |

`htdemucs_6s` ve `beat_this` ağırlıkları imajın **build** aşamasında `/weights` altına
indirilir (`HF_HOME` + `TORCH_HOME`), soğuk başlangıçta tekrar inmez.
Build'den sonra imaj `HF_HUB_OFFLINE=1` ile işaretlenir; sessiz bir yeniden
indirme olursa gürültüsüzce yavaşlamak yerine hata verir.

Build ayrıca şunları assert eder: torch sürümü 2.5.1, torchaudio sürümü torch
ile eşleşiyor, `beat_this.inference` / `beat_this.preprocessing` / `demucs`
import'ları çalışıyor, ve kendi kaynağımızda torchaudio I/O kullanımı yok.
Son kontrol her import'ta da çalışıyor (`_self_check_torchaudio`).
