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
| `torchaudio` | **kurulmuyor** | demucs 4.1.0'da yalnızca `train` extra'sının bağımlılığı; ses I/O ffmpeg + soundfile ile yapılıyor |

`htdemucs_6s` ağırlıkları imajın **build** aşamasında `/weights` altına
indirilir (`HF_HOME` + `TORCH_HOME`), soğuk başlangıçta tekrar inmez.
Build'den sonra imaj `HF_HUB_OFFLINE=1` ile işaretlenir; sessiz bir yeniden
indirme olursa gürültüsüzce yavaşlamak yerine hata verir.
