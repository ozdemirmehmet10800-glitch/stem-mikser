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

**Hi-Fi vokal yolunun GPU duman testi (Aşama 9):**

```powershell
.\.venv\Scripts\python.exe -m modal run backend\app.py::hifi_smoke
```

Deploy'dan ÖNCE koşulacak. Yerel testler torch'suz bir ortamda çalıştığı için
`/msst`'ten import'u, `BSRoformer`'ın kurulmasını ve vendored `attend.py`'deki
yamalı satırı (yalnız CUDA dalında) hiç çalıştırmıyor; bu entrypoint üretimin
kendi imajı, T4'ü ve Volume'uyla tam yolu koşturuyor. **Volume'a hiçbir şey
yazmıyor**, kitaplığa şarkı eklemiyor.

Şarkı, başlığında `--must-contain` geçen en son yüklenen kaynak şarkı
(varsayılan `HAZBIN`); `--song-id <id>` ile açıkça da verilebilir. Şarkı BAŞTAN
SONA geçiriliyor - parça kesmek chunk ızgarasını kaydırıp karşılaştırmayı
anlamsız kılardı.

Raporda: torch/CUDA/GPU, süreler, tepe VRAM, vokalin şekli/RMS/tepesi, NaN-Inf
kontrolü, yamalı satırın kaç kez çağrıldığı, yüklenen `models.*`/`utils.*`
modülleri (üretim yolu `mel_band_roformer` ve `utils.model_utils`'i import
ETMEMELİ) ve deneydeki `[C-fp32]` vokaliyle karşılaştırma: kestirilen
`clip_scale`, max mutlak fark, SNR. Fark FLAC'in 24-bit niceleme düzeyinde
olmalı (SNR ~120 dB; eşik 90 dB). O çıktı Volume'da yoksa (temizlenmişse)
şekil/RMS/NaN kontrolleriyle yetinip uyarı basıyor.

**Geri tuşu katman yığınının testi:**

```powershell
node tests\navstack_test.mjs
```

Saf mantık: sıra (menü → panel → seçim → ekran → çıkış), aynı katmanın iki
kez yığılmaması, yükleme örtüsü/hiza testi sürerken geri'nin yutulması.

**Önbellek temizliğinin testi (şarkı silinince cihazdaki sesler de gitsin):**

```powershell
node tests\stemcache_test.mjs
```

Cache Storage ve localStorage taklit edilip `StemCache.removeSongs` ölçülüyor.
Asıl incelik: Cache Storage anahtarları mutlak URL'e dönüşüyor, indeks
anahtarları göreli kalıyor; iki tarafı aynı kefeye koymayan bir temizlik ya
dosyayı bırakır ya iki kez sayar.

**Akor mantığının yerel testi (Modal'a bağlanmaz, ücretsiz, saniyeler):**

```powershell
.\.venv\Scripts\python.exe tests\test_chords_local.py
```

Sentetik üretilmiş bir akor dizisiyle şablonları, kök bonusunu, viterbi'yi,
downbeat fazını, birleştirmeyi ve JSON şeklini doğrular.

## Aşama 3 – API

### Secret (bir kez)

Token ve imzalama anahtarını üret (PowerShell 5.1, kriptografik RNG):

```powershell
$b = New-Object byte[] 32; (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

İki kez çalıştır: biri `API_TOKEN`, biri `SIGNING_KEY`. Sonra secret'ı oluştur
(`ALLOWED_ORIGINS` kendi GitHub Pages origin'in — kodda tutulmuyor ki public
repoda kullanıcı adın bulunmasın):

```powershell
.\.venv\Scripts\modal.exe secret create stem-mikser API_TOKEN=<token> SIGNING_KEY=<anahtar> ALLOWED_ORIGINS=https://<kullanici-adin>.github.io
```

Değiştirmek için sonuna `--force` ekle.

### Geliştirme

```powershell
.\.venv\Scripts\modal.exe serve backend\app.py
```

Geçici bir URL basar ve kod değişince yeniden yükler. Kalıcı URL için aşama
sonunda `modal deploy` (aşağıda).

### Test komutları (PowerShell 5.1)

**`curl` değil `curl.exe` yazmak zorunlu:** PowerShell 5.1'de `curl`,
`Invoke-WebRequest`'in takma adıdır ve `-D`, `-r`, `-F` gibi bayrakları
tanımaz. Ayrıca URL'de `&` varsa **çift tırnak şart**, yoksa PowerShell onu
komut ayırıcı sanar.

Token'sız istek 401 vermeli:

```powershell
curl.exe -i "<URL>/health"
```

Token'lı sağlık kontrolü (izin verilen origin'leri de gösterir):

```powershell
curl.exe -s -H "Authorization: Bearer <token>" "<URL>/health"
```

Şarkı yükleme (sha256 aynıysa mevcut id döner, yeniden işlenmez):

```powershell
curl.exe -s -H "Authorization: Bearer <token>" -F "file=@sarki.mp3" "<URL>/songs"
```

Liste ve tek şarkı:

```powershell
curl.exe -s -H "Authorization: Bearer <token>" "<URL>/songs"
```

```powershell
curl.exe -s -H "Authorization: Bearer <token>" "<URL>/songs/<id>"
```

Range isteği — `206` ve `Content-Range` görmelisin:

```powershell
curl.exe -s -D - -o NUL -H "Authorization: Bearer <token>" -H "Range: bytes=0-1023" "<URL>/songs/<id>/stems/vocals.m4a"
```

Karşılanamaz aralık `416` vermeli:

```powershell
curl.exe -s -D - -o NUL -H "Authorization: Bearer <token>" -H "Range: bytes=99999999-" "<URL>/songs/<id>/stems/vocals.m4a"
```

İmzalı indirme linki üret:

```powershell
curl.exe -s -X POST -H "Authorization: Bearer <token>" "<URL>/songs/<id>/download-link?name=vocals&format=wav"
```

Dönen `url`'yi **token olmadan** indir (çift tırnak şart, `&` var):

```powershell
curl.exe -s -o vocals.wav "<imzali-url>"
```

Bozuk imza `403` vermeli:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" "<URL>/songs/<id>/download/vocals?format=wav&exp=9999999999&sig=deadbeef"
```

Yeniden analiz ve silme:

```powershell
curl.exe -s -X POST -H "Authorization: Bearer <token>" "<URL>/songs/<id>/reanalyze"
```

```powershell
curl.exe -s -X DELETE -H "Authorization: Bearer <token>" "<URL>/songs/<id>"
```

### Duman testi betiği

Tek tek `curl.exe` çalıştırmak yerine hepsini birden koşan betik:

```powershell
powershell -ExecutionPolicy Bypass -File tests\api_smoke.ps1 -BaseUrl <URL>
```

Önce token'ı dosyaya yaz (betik onu okur ve **hiçbir yerde göstermez**;
komut satırına da girmez, curl'e `-K` ile geçici yapılandırma dosyası verilir,
böylece işlem listesinde de görünmez):

```powershell
Set-Content -Path "$env:USERPROFILE\stem-mikser-token.txt" -Value '<token>' -NoNewline
```

Süresi geçmiş ama **doğru imzalı** link kontrolü için imzalama anahtarı da
gerekiyor (imza `exp`'i kapsadığı için anahtar olmadan geçerli bir "süresi
geçmiş" imza üretilemez). Yoksa o kontrol ATLANDI olarak işaretlenir:

```powershell
Set-Content -Path "$env:USERPROFILE\stem-mikser-signing-key.txt" -Value '<anahtar>' -NoNewline
```

Kontroller: token'sız 401, token'lı `/health`, şarkı listesi, durum + akorlar,
Range (206 + `Content-Range`, hem baştan hem ortadan dilim), karşılanamaz
Range (416), imzalı link üretimi, WAV'ın token olmadan inmesi (`RIFF`/`WAVE`
sihirli sayısı doğrulanır), bozuk imza (403), süresi geçmiş imza (403), var
olmayan id ile DELETE (404).

**Mevcut şarkı silinmez** — DELETE yalnızca var olmayan bir id ile denenir.

Yükleme testi opsiyonel:

```powershell
powershell -ExecutionPolicy Bypass -File tests\api_smoke.ps1 -BaseUrl <URL> -UploadFile sarki.mp3
```

Zaten işlenmiş bir dosya verin: `existing: true` döner, GPU harcanmaz. Betik
aynı dosyayı iki kez yükleyip sha256 tekilleştirmesini de doğrular.

Betik BOM'lu UTF-8 kaydedilmiştir — PowerShell 5.1 BOM'suz UTF-8'i ANSI sanıp
Türkçe karakterleri bozuyor. Konsolda yine bozuk görünürse:
`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`

### Eşzamanlılık notu

API `modal.concurrent(max_inputs=8)` ile çalışıyor: oynatıcı 6 stem'i aynı
anda çekiyor, eşzamanlılık olmasa 6 konteyner açılırdı.

Bu yüzden `volume.reload()` bir yazıcı/okuyucu kilidiyle korunuyor. Modal
dokümanı: *"You can only reload a Volume when there are no open files"* —
açık dosya varken reload `volume busy` ile patlıyor ve reload sürerken volume
o konteynere **boş** görünüyor. Dolayısıyla:

- Dosyalar belleğe okunup tanıtıcı hemen kapatılıyor (en fazla ~45 MB)
- WAV üretiminde FLAC önce konteyner-yerel dizine kopyalanıyor, ffmpeg volume
  üzerinde dosya açık tutmuyor
- `reload` açık okumalar bitene kadar bekliyor, reload sürerken yeni okuma
  giremiyor, ve metadata reload'ları 2 saniyeden sık yapılmıyor

### API yardımcılarının yerel testi

```powershell
.\.venv\Scripts\python.exe tests\test_api_local.py
```

Range ayrıştırma, HMAC imzalama ve yazıcı/okuyucu kilidini Modal'a bağlanmadan
doğrular (FastAPI bağlantısı `modal serve` + `curl.exe` ile test edilir).

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

## Aşama 4 – oynatıcı (ön yüz)

Build adımı yok: vanilla HTML/CSS/JS, ES modülleri.

```
frontend/
  index.html
  css/styles.css
  js/settings.js   API adresi + token (localStorage)
  js/api.js        fetch sarmalayıcı, hata türü ayrımı
  js/engine.js     Web Audio: transport ve kazanç grafiği
  js/mixer.js      kanal şeridi (fader / solo / mute)
  js/chords.js     akor şeridi
  js/app.js        yapıştırıcı
```

### Gerçek API ile çalıştırma

```powershell
.\.venv\Scripts\python.exe -m http.server 8000 --directory frontend
```

`http://localhost:8000` adresini aç, ayarlara API adresini ve token'ı gir.
Bu adres API'nin `LOCAL_ORIGINS` listesinde olduğu için CORS sorunu çıkmaz.

### Sahte sunucuyla çalıştırma (Modal'a dokunmadan)

İndirilmiş stem'lerle (`out/<sha>/`) tam bir test ortamı. Kredi harcanmaz,
gerçek token hiçbir yere girmez. İki kabuk:

```powershell
.\.venv\Scripts\python.exe tests\mock_server.py
```

```powershell
.\.venv\Scripts\python.exe -m http.server 8000 --directory frontend
```

Ayarlara `http://127.0.0.1:8001` ve token olarak `mock-token` gir.

### Tasarım kararları

- Stem'ler Bearer token istediği için `<audio src>` kullanılamıyor (header
  gönderemez). Akış: `fetch` → `ArrayBuffer` → `decodeAudioData` → `AudioBuffer`.
- Altı kaynak da **aynı** `ctx.currentTime` değerinde başlatılıyor; tek
  AudioContext içinde örnek hassasiyetinde hizalı kalıyorlar.
- AudioContext ilk kullanıcı hareketinde açılıyor (masaüstü Chrome'da da
  autoplay politikası var).
- Mute her zaman öncelikli; herhangi bir solo aktifse yalnızca solo kanallar
  duyulur. Kazanç değişimleri `setTargetAtTime` ile, tık sesi olmuyor.
- Akor şeridi DOM (canvas değil): metin, tıklama isabet testi ve
  erişilebilirlik bedava geliyor. `pxPerSec` downbeat aralıklarının
  medyanından türetiliyor, bpm'den değil.
- Şarkı bitince çalma durur ve başa sarılır.
- Hata mesajları türe göre ayrı: token hatası (401) ile CORS/ağ hatası
  karıştırılmıyor; CORS mesajı sayfanın kendi origin'ini de gösteriyor.

## Aşama 5 – PWA

Ana ekrana eklenebilir, tam ekran açılır, çevrimdışı iskelet.

- `manifest.json` — `start_url` ve `scope` **göreli** (`./`), çünkü site
  `/stem-mikser/` alt yolunda yayınlanıyor; mutlak `/` olsaydı ana ekrandan
  açılış 404 verirdi.
- `sw.js` — yalnızca ön yüz dosyalarını cache'ler. **API'ye, ses dosyalarına
  ve GET olmayan isteklere hiç karışmaz.** Sayfa gezintisinde önce ağ
  (güncelleme insin), diğer dosyalarda önce cache. Sürüm değişince eski
  cache'ler silinir ve yeni worker beklemeden devralır.
- `icons/` — `tests/make_icons.py` ile üretiliyor: **yeni bağımlılık yok**,
  yalnızca `zlib` + `struct`, 4x supersampling ile kenar yumuşatma.
- iOS manifest'i kısmen yok saydığı için `apple-touch-icon` ve
  `apple-mobile-web-app-capable` etiketleri ayrıca konuldu.
- Ayarlarda **"Önbelleği temizle"** düğmesi: bozuk bir service worker yapışkan
  olabiliyor, kaçış kapısı olmadan tarayıcı verisi silmek gerekirdi.

### İkonları yeniden üretmek

```powershell
.\.venv\Scripts\python.exe tests\make_icons.py
```

### Service worker yönlendirme testi

Asıl güvence service worker'ın API'ye karışmaması. `sw.js` sahte bir `self`
içinde çalıştırılıp `fetch` işleyicisi gerçek `Request` nesneleriyle
sınanıyor. Depo kökünü servis edip sayfayı açın:

```powershell
.\.venv\Scripts\python.exe -m http.server 8002
```

`http://localhost:8002/tests/sw_routing_test.html`

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
