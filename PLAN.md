# Proje: Stem Mikser (Moises benzeri, kişisel kullanım)

Bu metni proje köküne PLAN.md olarak kaydet. Her yeni oturumda önce PLAN.md'yi oku.

## Çalışma kuralları (kesin)
- Aşama aşama ilerle. Her aşamaya başlamadan önce o aşamanın kısa planını göster, onayımı bekle, sonra kodla.
- Her aşamanın sonunda DUR: ne yaptığını ve benim hangi komutlarla nasıl test edeceğimi yaz. Onayım olmadan sonraki aşamaya geçme.
- Onaydan sonra aşamayı tek bir git commit'i olarak kaydet.
- Kredi kartı gerektiren hiçbir servis kullanma (R2, S3 vb. yok). Tek bulut: Modal Starter planı (aylık ücretsiz kredi). Ön yüz: GitHub Pages.
- GitHub Pages ücretsiz planda repo public olacak. Kodda hiçbir sır (token, anahtar) bulunmayacak; token yalnızca uygulamanın ayarlar ekranından girilecek.
- Modal'ın API'si sürümler arasında değişti (web_endpoint → fastapi_endpoint, keep_warm → min_containers, concurrency_limit → max_containers gibi). Hafızana güvenme; kurulu modal sürümünü ve güncel dokümanı kontrol et.
- Geliştirme sırasında `modal serve`, kalıcı kurulum için `modal deploy` kullan.
- Sisteme global bir şey kurman gerekirse önce sor.
- torchaudio KURULU OLABİLİR ama BİZİM kodumuz ses I/O'su için onu kullanmaz. Yasak olan `torchaudio.load/save/info` (yeni sürümlerde backend sorunları var); `torchaudio.transforms` gibi saf torch dönüşümleri yasak değil ve üçüncü parti paketler (beat_this'in LogMelSpect'i) bunları kullanabilir. Kurulduğunda sürümü torch ile birebir eşleşmek zorunda. Bu kural `backend/app.py` içinde her import'ta kaynak taramasıyla, build'de de sürüm assert'iyle doğrulanıyor.
- Bir paketin bağımlılığını değerlendirirken tek dosyaya bakma, IMPORT ZİNCİRİNİ takip et. `beat_this/inference.py` torchaudio import etmiyor ama import ettiği `beat_this/preprocessing.py` ediyor; buna dayanarak `--no-deps` kurulumu yapıldı ve build hata verdi.
- Uzak (Modal) fonksiyonlar yerel entrypoint'e ASLA torch/numpy nesnesi döndürmez. Sadece düz Python tipleri (str, int, float, bool, list, dict, None) ya da dosya yolları/bayt dizileri döner. `torch.__version__` gibi değerler bile (TorchVersion) yerel ortamda torch kurulu olmadığı için DeserializationError'a yol açar; dönüş öncesi str()/int()/float()/bool() ile açıkça çevir.

## Mimari
Tek kullanıcılı. PC sadece geliştirme ve deploy için; deploy sonrası sistem PC kapalıyken çalışmalı.

backend/app.py → Modal app
frontend/      → Vanilla HTML/CSS/JS PWA, build adımı yok
README.md      → kurulum, deploy, test komutları

Modal bileşenleri:
1. api: FastAPI (asgi_app), CPU, hafif imaj (torch YOK).
2. separate: GPU (T4), Demucs.
3. analyze: CPU, librosa ile akor + beat/ölçü.

Hepsi tek bir Modal Volume ("stems-vol") kullanır:
  /songs/{sha256}/input.{ext}
  /songs/{sha256}/stems/{vocals,drums,bass,guitar,piano,other}.m4a   (oynatma)
  /songs/{sha256}/master/{...}.flac                                    (kayıpsız, indirme için)
  /songs/{sha256}/chords.json
  /songs/{sha256}/status.json   (queued | separating | analyzing | done | error; progress 0-100; hata mesajı; başlık; süre; created_at)
Volume'a yazan fonksiyon volume.commit(), okuyan fonksiyon volume.reload() yapmalı.

## Maliyet korumaları
- Hiçbir fonksiyonda min_containers veya sürekli sıcak konteyner OLMAYACAK; boştayken maliyet sıfır olmalı.
- separate: max_containers=1, timeout 900 sn.
- Yükleme sınırı 30 MB ve en fazla 10 dakika süre; aşılırsa anlamlı hata dön.
- Aynı dosya (sha256) daha önce işlendiyse tekrar işleme, mevcut sonucu dön.
- Aşama 1 sonunda: 4 dakikalık bir şarkının GPU süresini ölç, Modal Volume depolama maliyetini güncel dokümandan kontrol et ve bana raporla.

## Aşama 0 – Duman testi
modal.com kaydını ve `pip install modal` + `modal setup` adımlarını ben yaptım; yapmadıysam adımları söyle.
T4 üzerinde nvidia-smi çıktısını ve torch.cuda.is_available() sonucunu döndüren minimal bir Modal fonksiyonu yaz; `modal run` ile çalışsın.

## Aşama 1 – Ayrıştırma
- İmaj: debian_slim, Python 3.11, apt ile ffmpeg; torch, torchaudio ve demucs birbiriyle uyumlu sürümlere SABİTLENMİŞ olsun.
- htdemucs_6s ağırlıkları imajın BUILD aşamasında indirilsin (run_function); soğuk başlangıçta tekrar indirilmesin.
- Demucs CLI yerine demucs.pretrained.get_model + demucs.apply.apply_model kullan.
- Ses okuma/yazma için torchaudio I/O KULLANMA (yeni sürümlerde backend sorunları var). Okurken ffmpeg ile 44.1 kHz stereo float'a çevir, yazarken soundfile veya ffmpeg kullan. (Paketin kurulu olması sorun değil; kuralın tam hali yukarıdaki çalışma kurallarında.)
- Çıktı: her stem için FLAC master + AAC .m4a (stereo, 44.1 kHz, 160 kbps).
- Test için local entrypoint: `modal run backend/app.py --path sarki.mp3` işlesin ve stem'leri PC'ye indirsin.

## Aşama 2 – Akor ve ölçü analizi
- Girdi: bass + piano + guitar + other stem'lerinin toplamı (drums ve vocals HARİÇ).
- librosa.feature.chroma_cqt, beat-senkron medyan ile özetlenmiş.
- 24 şablon (12 majör + 12 minör) + "N" (akor yok / düşük enerji); kosinüs benzerliği.
- Benzerlikleri olasılığa çevir, librosa.sequence.transition_loop ile kendinde kalma olasılığı yüksek bir geçiş matrisi kur, librosa.sequence.viterbi ile yumuşat.
- Beat'ler: librosa.beat.beat_track. Ölçü: 4/4 varsay; downbeat'i, beat'lerdeki bas enerjisinin en yüksek olduğu fazı seçerek bul.
- Akor adları diyez ile (C, C#m, F, Fm...). Ton tespitine göre bemol/diyez seçimi opsiyonel bonus.
- chords.json: { "bpm", "beats": [...], "downbeats": [...], "chords": [{"start","end","label"}] }; ardışık aynı akorlar birleştirilmiş.
- Test: mevcut bir şarkıda yalnızca analizi, GPU'suz, `modal run` ile tekrar çalıştırabileyim.

## Aşama 2 – revizyon notları (tamamlandı, gerçek şarkıda doğrulama bekliyor)
Bir önceki turda limitle kesilen dört iş bitti:

- [x] Slash kararı `analyze_core`'a bağlandı (`SLASH_PENALTY = 0.12`).
- [x] Akor segmentasyonu yarım ölçüye geçti (`_half_bar_starts`), `segment_mode`
      alanı chords.json'a yazılıyor.
- [x] bpm artık `beat_this`'in HAM beat zamanlarından. Doğrulandı: aynı 127 BPM
      ızgarası frame'e yuvarlandığında 129.2, ham hesapla 127.12 veriyor.
- [x] `_download` artık `beats.json`'ı da indiriyor.
- [x] `ROOT_WEIGHT` 0.15 sonrası testler: 82/82 geçiyor.

### Slash kanıtı BAS chroma'sından, üst stem'lerden DEĞİL
İlk deneme "üst stem'lerde bas notasının ağırlığı kökün ağırlığını aşıyorsa
slash yaz" şeklindeydi ve gerçek evrimleri de bastırdı: gerçek bir evrimde üst
stem'ler kökü hâlâ içeriyor (Ab/C'de piyano C-Eb-Ab çalar), ağırlık farkı ~0
çıkıyor. `test_inversion_end_to_end` bunu yakaladı. Kural şuna döndü: bas
chroma'sında adayın ağırlığı kökün ağırlığını `SLASH_PENALTY` kadar aşmalı -
yani bas segment boyunca köke değil o notaya oturmuş olmalı. Geçici bas
notaları yarım ölçü medyanında zaten eriyor.

### Yerelde gerçek şarkı çalıştırılamıyor
PC'de ffmpeg yok, `soundfile` AAC okumuyor, `audioread` backend'siz. İndirilmiş
m4a stem'ler yerelde decode edilemiyor, bu yüzden gerçek kayıt üzerindeki her
doğrulama Modal'dan geçmek zorunda. Yerel test yalnızca sentetik sesle
(tests/test_chords_local.py) ve inen chords.json'la
(tests/compare_reference.py) çalışıyor.

### Referans karşılaştırması
Yalnızca ilk 27 ölçü geçerli: `sarki.mp3` kesilmiş bir montaj (~1:51),
Moises'taki tam sürüm 5:40. Revizyon öncesi skor: tam 7/26 (%27), kısmi 11/26,
yanlış 8/26; ton Fm doğru, ölçü hizası düzelmiş (mod 4 = [0]), akorların %23'ü
slash, 59 ölçünün 8'inde 3 akor.

## Aşama 7 – Metronom
Öncelik 1. Bağımsız, diğer üçüne engel değil.

- Tık sesi Web Audio'da ÜRETİLECEK (kısa gürültü patlaması + zarf); ses
  dosyası indirilmeyecek. Downbeat farklı perde/seviyede vurgulanır.
- Zamanlama: `beats.json` / `chords.json`'daki vuruşlar. rAF ile tık
  ZAMANLANMAZ - ileriye bakan bir zamanlayıcı (25 ms'de bir uyanıp 100 ms
  ilerisini `AudioContext` saatine yazan) kullanılacak. rAF sekme
  arkaplandayken yavaşlıyor ve tık kayıyor.
- Alt bölüm: 0.5x (vuruşun biri atlanır), 1x, 2x (vuruş aralarına ara nokta
  eklenir). Ses seviyesi + `StereoPannerNode` ile sağ-sol.
- Seek/duraklat sonrası yeniden hizalanmalı; zamanlayıcı `engine.currentTime`
  ile `ctx.currentTime` arasındaki eşlemeyi kullanır.
- Bilinen sınır: `beat_this` çıktısı kendi 50 fps ızgarasında, yani tıklar
  gerçek vuruştan en fazla ±10 ms sapar. Kulakla fark edilmez ama biliniyor.
- Aşama 8 gelince metronom esnetilmiş zaman çizgisini takip etmeli.

## Aşama 8 – Hız ve ton değiştirme
Öncelik 2. ÖNCE ÖLÇÜM, sonra karar.

### Kütüphane ve lisans (araştırıldı)
| Kütüphane | Lisans | Durum |
|---|---|---|
| `signalsmith-stretch` | **MIT** | Birinci tercih. C++11, `web/` altında WASM + AudioWorklet, npm'de. Zaman esnetmesi 0.75x-1.5x aralığında en iyi. |
| `SoundTouchJS` | **MPL-2.0** | Yedek. LGPL'den MPL'ye geçmiş. AudioWorklet destekli; `pitch`, `pitchSemitones`, `playbackRate` ayrı AudioParam'lar. |
| Rubber Band | **GPLv2+ / ticari** | KULLANILMAYACAK. Depo public; GPL bulaşıcı, tüm projeyi GPL'e zorlar. Ticari lisans ücretli. |

### ÖLÇÜM SONUCU (2026-09-27, Android 10 / 8 GB / 10 çekirdek + masaüstü)
- Nesnel (offline render) ölçüm telefonda 6 kanalda **oran 0.064** verdi -
  gerçek zamandan ~15 kat hızlı. Yani CPU yeterli.
- AMA gerçek zamanlı çalmada **hiç ses çıkmadı**. Sebep CPU değil:
  `signalsmith-stretch` gerçek zamanlı bir AudioContext'te 4. düğümden
  itibaren TÜM işlemcilerde `processorerror` atıyor
  ("Cannot read properties of undefined (reading 'length')") ve Chrome
  onları kalıcı olarak susturuyor. `cheaper` ve `splitComputation`
  kurtarmıyor. Aynı kütüphane OFFLINE render'da 6 kanalda sorunsuz, bu
  yüzden nesnel ölçüm arızayı göremiyor.
- `@soundtouchjs/audio-worklet` (MPL-2.0) gerçek zamanlıda 8 kanalda bile
  hatasız, tepe seviyesi doğrusal. Masaüstünde 6 kanal oranı 0.163
  (signalsmith'in ~3 katı ama çalışıyor).

**KARAR: SoundTouchJS.** Mimari de daha uygun: canlı girdi üzerinde
çalışıyor (`source -> SoundTouchNode -> gain -> master`), tempo kaynağın
`playbackRate`'inden geliyor ve düğüm perdeyi telafi ediyor. Buffer yükleme
derdi yok, fader değişimleri doğal çalışıyor. Parametreler AudioParam:
`playbackRate`, `pitchSemitones`, `pitch`.

signalsmith-stretch depoda kalıyor: ölçüm sayfası ikisini karşılaştırıyor,
telefonda da aynı sonucu doğrulamak için.

### Sıra
1. **Önce ölçüm.** Telefonda 6 AudioWorklet esnetici aynı anda çalışabiliyor
   mu? Ayrı bir ölçüm sayfası: kanal sayısını 1'den 6'ya çıkarıp ses kesilmesi
   (underrun) ve CPU yükü ölçülecek. Karar bu sayılara göre verilecek.
2. Yetiyorsa: her kanal `source -> stretch -> gain -> master`. Hız ve ton
   bağımsız; ton yarım ses adımlarıyla (±6 veya ±12).
3. Yetmiyorsa plan B: sunucuda render. Maliyeti var (her ayar değişiminde
   yeniden render + indirme), anlık geri bildirim kayboluyor. Ancak ölçüm
   kötü çıkarsa değerlendirilecek.

### Bağlı işler
- Akor şeridi tona göre transpoze edilecek. Yazım (bemol/diyez) yeni tona
  göre yeniden seçilmeli - `_key_uses_flats` mantığı ön yüze taşınacak.
- Metronom ve akor şeridi esnetilmiş zaman çizgisini takip etmeli.
- bpm göstergesi hız çarpanıyla güncellenecek.

## Aşama 9 – Hi-Fi modu (daha kaliteli ayrıştırma)
Öncelik 3. Yüklerken seçilir, `status.json`'a yazılır.

### Seçenekler ve ÖLÇÜLEN maliyete dayalı tahmin
Demucs MIT (kod ve ağırlıklar). `htdemucs_ft` dokümanda "4 kat daha uzun
sürer, biraz daha iyi olabilir" diyor - kazanç mütevazı. `--shifts N`
işlemi N kat yavaşlatıyor.

Aşama 1 ölçümü: 4 dakikalık şarkıda faturalanan T4 ~117-147 sn, bunun
~19 sn'si `apply_model`. Yalnızca `apply_model` ölçekleniyor:

| Kip | apply_model | Faturalanan T4 | Şarkı başı |
|---|---|---|---|
| Şimdiki (`htdemucs_6s`) | ~19 sn | ~117-147 sn | ~$0.022-0.028 |
| `shifts=2` | ~38 sn | ~136-166 sn | ~$0.025-0.031 |
| `htdemucs_ft` | ~76 sn | ~174-204 sn | ~$0.032-0.038 |
| `htdemucs_ft` + `shifts=2` | ~152 sn | ~250-280 sn | ~$0.046-0.052 |

$30/ay ücretsiz kredi: en pahalı kipte bile ayda ~600 şarkı.

### KARAR: hibrit yol (htdemucs_ft elendi)
Gitar ve piyano kaybedilmeyecek, bu yüzden `htdemucs_ft` kullanılmıyor.
Yerine iki aşamalı hibrit:

1. Vokal, Roformer tabanlı bir vokal modeliyle ayrılır.
2. Kalan (enstrümantal) `htdemucs_6s` ile bölünür; drums/bass/guitar/piano/
   other oradan gelir. 6 kanal korunur, vokal kalitesi artar.

Ağırlık lisansı (araştırıldı):

| Bileşen | Lisans | Durum |
|---|---|---|
| BS-RoFormer (lucidrains) | MIT | Yalnızca mimari + eğitim kodu, AĞIRLIK YOK |
| MSST (ZFTurbo) | MIT | Kod MIT; ağırlıkları kendisi barındırmıyor, dışarı bağlantı veriyor |
| **KimberleyJSN/melbandroformer** | **MIT** | **Ağırlıklar HuggingFace'te, MIT. Birinci tercih.** |

Yani hibrit yolun lisans tarafı temiz: Demucs MIT, Mel-Band Roformer
ağırlıkları MIT.

### Ölçülmesi gerekenler
- Roformer'ın T4'teki süresi (Demucs'a ek olarak geliyor, onun yerine
  geçmiyor - toplam GPU süresi artacak).
- Enstrümantali `htdemucs_6s`'e vermek, orijinal mix'i vermeye göre
  gitar/piyano kalitesini bozuyor mu? Vokal artığı kalmadığı için
  iyileşmesi de mümkün, kötüleşmesi de. ÖLÇÜLMELİ, varsayılmamalı.
- Yukarıdaki maliyet tablosu bu yol için yeniden hesaplanacak.

### Dikkat
- `htdemucs_ft` 6 stem DEĞİL 4 stem veriyor (gitar/piyano yok). Hi-Fi'ı
  6 stem'le birleştirmek istiyorsak yol `htdemucs_6s` + `shifts` olmalı;
  yoksa Hi-Fi'da gitar/piyano kaybolur. Bu bir TASARIM KARARI, sormadan
  seçilmeyecek.
- `separate` timeout'u 900 sn. 10 dakikalık şarkı + en pahalı kip ~600 sn'ye
  çıkıyor, sınıra yaklaşıyor. Hi-Fi'da timeout artırılmalı.
- Çıktı boyutu değişmiyor, depolama maliyeti aynı.
- Aşama 3'te eklenen zamanlama enstrümantasyonu gerçek sayıları verecek;
  tahminler onunla değiştirilecek.

## Aşama 10 – Ek ayrıştırma (araştırma sonucu)
Öncelik 4. **Gerçekçi kapsam beklenenden dar.**

### Davul alt parçaları (DÜŞÜK ÖNCELİK, en sona)
| Model | Parçalar | Lisans | Not |
|---|---|---|---|
| DrumSep (mdx23c, jarredou) | kick / snare / toms / hihat / cymbals | MSST deposunda lisans BELİRTİLMEMİŞ - kullanmadan önce netleşmeli | SDR: kick 16.66, snare 11.53, toms 12.33 |
| DrumSep (htdemucs, inagoy) | aynı | aynı belirsizlik | |
| LarsNet | kick / snare / toms / hihat / cymbals | Ağırlıklar **CC BY-NC 4.0** | Kişisel kullanım uygun; ağırlıklar YENİDEN DAĞITILAMAZ, ticari kullanım yok |

### YAPILAMAZ: açık model yok
Araştırma sonucu açıkça olumsuz:
- **Ana vokal / arka vokal ayrımı:** UVR topluluğunun karaoke modeli
  (`mel_band_roformer_karaoke_aufr33_viperx`) bu işi YAPIYOR ve ağırlıkları
  yaygın dağıtılıyor - ama **LİSANSI YOK**. Temmuz 2026'da UVR deposunda
  açılan soru (issue #2295) tam bunu soruyor ve **yanıtsız**: soran kişi
  "ne HuggingFace aynasında ne de duyuru metninde bir lisans ya da kullanım
  şartı bulamadım" diyor. Depo public olduğu için lisansı belirsiz ağırlığa
  bağlanmak risk; ağırlığı yeniden dağıtmasak (build'de indirsek) bile
  belirsizlik sürüyor. KULLANMADAN ÖNCE lisans netleşmeli.
  MedleyVox akademik alternatif ama yazarları "önceden eğitilmiş ağırlıkları
  yükleme planımız yok" diyor ve orada da lisans belirtilmemiş.
  Bu özelliği sunan ticari servisler (Moises, LALAL.AI) kapalı model
  kullanıyor.
- **Akustik / elektro gitar, solo / ritim gitar:** ayrı model YOK.
- **Nefesli (brass/wind):** model YOK.
- **Yaylı (strings):** model YOK.

Yani Aşama 10 gerçekte "davul alt parçaları" demek. Diğerleri için dürüst
cevap: açık kaynak dünyasında karşılığı yok.

### Eğer yapılırsa
- Ayrı bir GPU fonksiyonu; mevcut `drums.flac`'ı girdi alır, 5 alt parça
  üretir. Mevcut 6 kanalı bozmaz, isteğe bağlı bir katman olur.
- Ön yüzde davul kanalı açılıp alt kanallara ayrılabilir (Moises'taki gibi).
- Ek GPU süresi ve depolama: 5 stem daha, ölçülmeli.

## Sonraki iyileştirmeler (Aşama 2'den devredilen, acil değil)
Tek şarkıya daha fazla ayar aşırı uyum riski taşıdığı için bunlar bilinçli
olarak ertelendi. Referans skoru bırakıldığı yer: tam 11/26 (%42), kısmi 7/26,
yanlış 8/26; ton Fm doğru, ölçü hizası doğru, ton dışı akor yok, ölçü içinde
3 akor yok, slash oranı %23.

### Eb/Db yerine Ab veya Ab/Eb okunması (15-21. ölçüler)
Referans bu yarım ölçülerde Eb ya da Db diyor, biz Ab / Ab/Eb diyoruz. Bas
doğru (Eb), üst stem'ler Ab'de kalıyor. Muhtemel sebep: önceki akorun Ab'si
ped/gitar sustain'i olarak sürüyor; Ab (Ab-C-Eb) ile Eb (Eb-G-Bb) Eb notasını
paylaşıyor, bas Eb'ye inince etiket Ab/Eb çıkıyor.

Hangi stem'in sebep olduğu ÖLÇÜLMEDİ: stem başına chroma gerekiyor, o da
yerelde çıkarılamıyor (aşağıdaki engel). Tespit tarifi: `master/*.flac`
indirilip her stem için ayrı `chroma_cqt`, 0:26-0:38 aralığında yarım ölçü
medyanları; Ab (8) ve Eb (3) ağırlıklarını stem başına karşılaştır.

BASİT BİR DÜZELTMESİ YOK: akla gelen çözüm basın etkisini (`ROOT_WEIGHT`)
artırmak, ama bu doğrudan yeni kazandığımız evrik akorlarla (14/16/18/20.
ölçülerde Ab/C) ters düşüyor. Gerçek çözüm muhtemelen eğitilmiş bir akor
modeli ya da onset ağırlıklı chroma.

### Uzun şarkılar için MediaElement yolu (Aşama 5'ten ertelendi)
6+ dakikalık şarkılarda AudioBuffer yerine `MediaElementAudioSourceNode`
kullanmak, PCM'i bellekte tutmamak için. Stem'ler `fetch` ile Blob olarak
alınıp `URL.createObjectURL` ile verilecek (imzalı URL değil: kimlik
doğrulama korunur, 10 dakikalık süre sorunu olmaz, 10 dk şarkıda toplam
~72 MB sıkıştırılmış veri). Her `<audio>` kendi saatinde çaldığı için
2 saniyede bir kanallar master'a göre karşılaştırılıp 40 ms'den fazla sapma
`currentTime` ile düzeltilmeli. Aşama 5'te kapsam dışı bırakıldı çünkü
elde uzun test şarkısı yok ve en karmaşık parça bu.

### Akor ızgarası görünümü
Moises'ın akor şeridinde her ölçü 4 sabit vuruş hücresine bölünüyor ve akor
değişmeyen vuruşlar boş kalıyor. Bizde hücre genişliği akorun süresiyle
orantılı. Izgara görünümü bilinçli olarak Aşama 4 kapsamı dışında bırakıldı.

### 7'li akorlar
Şablon seti 24 triad, bu yüzden `Dbmaj7`, `Bbm7`, `Cm7` triad'a yuvarlanıyor
(25-27. ölçüler). Şablon setine 7'li aileler eklenebilir ama durum sayısı
25'ten ~60'a çıkar; viterbi geçiş matrisi ve N skoru yeniden ayarlanmalı.

### Eğitilmiş akor modeli
Şablon + viterbi yerine eğitilmiş bir akor tanıma modeli. `beat_this`
beat/downbeat tarafında kural tabanlı yaklaşımı açık ara geçti (2 vuruşluk
ölçü kayması tek hamlede düzeldi); akor tarafında da aynı sıçrama beklenir.

### Engel: yerelde gerçek şarkı çalıştırılamıyor
PC'de ffmpeg yok, `soundfile` AAC okumuyor, `audioread` backend'siz. `soundfile`
FLAC okuyabildiği için `master/*.flac` bir kez indirilirse (GPU'suz:
`modal run backend/app.py --path sarki.mp3`, ~200 MB) akor ayarı tamamen
yerelde, Modal'a hiç dokunmadan yapılabilir hale gelir. Ayar işine geri
dönülürse ilk adım bu olmalı.

## Aşama 3 – API
Tüm uç noktalar Bearer token ister. Token ve imzalama anahtarı Modal Secret'ta durur; secret oluşturma komutunu bana ver.
- POST /songs (multipart): sha256 hesapla, varsa mevcut id'yi dön; yoksa kaydet, separate'i spawn et (separate bitince analyze'ı tetikler), id dön.
- GET /songs: liste (id, başlık, durum, süre).
- GET /songs/{id}: status.json + (done ise) chords.json.
- GET /songs/{id}/stems/{name}.m4a: Range isteklerini destekleyen dosya servisi.
- POST /songs/{id}/download-link: 10 dakika geçerli, HMAC imzalı URL üretir (<a> etiketi header gönderemediği için).
- GET /songs/{id}/download/{name}?format=wav|flac|m4a&exp=...&sig=...: WAV, FLAC master'dan anında üretilir.
- POST /songs/{id}/reanalyze: yalnızca analyze'ı yeniden çalıştırır.
- DELETE /songs/{id}.
- CORS: yalnızca GitHub Pages origin'im ve localhost.

## Aşama 4 – Oynatıcı (önce masaüstü)
- Ayarlar ekranı: API adresi + token, localStorage'da saklanır.
- Şarkı listesi ve yükleme; işlem sürerken 3 saniyede bir durum sorgulama ve ilerleme göstergesi.
- Web Audio: 6 stem AudioBuffer, her biri kendi GainNode'u → master GainNode → destination. Hepsi aynı ctx.currentTime + küçük bir offset ile başlatılır. Pause/seek: tüm kaynakları durdur, yeni offset ile yeniden oluştur.
- Kanal şeridi: isim, fader (%0–150, dB göstergesi), Solo, Mute. Herhangi bir solo aktifse yalnızca solo kanallar duyulur; mute her zaman önceliklidir. Gain değişimleri setTargetAtTime ile yapılır (tık sesi olmasın).
- Üstte akor şeridi: ölçü çizgileri, akor kutuları, çalma imleci. requestAnimationFrame ile kayar, aktif akor vurgulanır, akora tıklayınca o ana seek.
- Alt çubuk: play/pause, zaman, seek bar, master ses.
- Stil: koyu tema, Moises tarzı sade arayüz.
- GitHub Pages'e deploy (GitHub Actions ile).

## Aşama 5 – Mobil
- Mobilde AudioContext'i sampleRate 32000 ile oluştur ve stem'leri mono'ya indirerek decode et (bellek için). Masaüstünde tam kalite.
- Şarkı 6 dakikadan uzunsa mobilde MediaElementAudioSourceNode yoluna geç; 2 saniyede bir kanalları master'a göre kontrol et, 40 ms'den fazla sapmayı düzelt.
- İlk Play dokunuşunda ctx.resume(). iOS sessiz anahtarı için sessiz <audio> elementi yöntemini uygula.
- Fader'lar pointer event'leriyle yazılmış özel bileşen olsun: touch-action: none, en az 44 px dokunma alanı. Dar ekranda kanallar dikey liste, fader'lar yatay.
- Akor şeridinde touch-action: pan-x.
- PWA: manifest.json (standalone, ikonlar). Service worker yalnızca ön yüz dosyalarını cache'lesin, ses dosyalarını DEĞİL.
- Media Session API ile kilit ekranı play/pause; destekleniyorsa çalma sırasında Screen Wake Lock.
- Yükleme input'u accept="audio/*".

## Aşama 5 – kalan işler (2/2)
PWA bitti ve telefonda doğrulandı (Android/Chrome: kuruldu, tam ekran).
Kalan dört parça, her biri AYRI commit:

- [x] **Dokunmatik fader'lar.** `<input type="range">` yerine pointer
      event'li özel bileşen: `touch-action: none`, en az 44 px dokunma alanı,
      `setPointerCapture` (parmak kaysa bile takip). Erişilebilirlik elle:
      `role="slider"`, `aria-valuenow`/`aria-valuetext`, ok tuşları.
- [x] **Media Session.** Kilit ekranı metadata + play/pause/seek işleyicileri
      + `setPositionState`. Saf Web Audio ile çoğu platform kilit ekranında
      kontrol göstermiyor; sessiz döngüsel bir `<audio playsinline>` elementi
      gerekiyor. Aynı element iOS sessiz anahtarı sorununu da çözüyor.
- [x] **Wake Lock.** Çalarken `navigator.wakeLock.request("screen")`,
      duraklatınca bırak, `visibilitychange`'de yeniden al (arkaplana gidince
      kilit düşüyor). Desteklenmiyorsa sessizce atla.
- [x] **Bellek önlemleri.** Mobilde `AudioContext` `sampleRate: 32000`,
      stem'ler TEK TEK çözülüp hemen mono'ya indirilecek ve stereo tampon
      bırakılacak (tepe bellek 6 stereo yerine 1 stereo + 6 mono).
      Masaüstünde tam kalite. Uyarı eşiği aşağıdaki kurala göre.

## Aşama 5 – telefon testinden çıkanlar
Android Chrome / kurulu PWA: ekran sönmüyor, kilitliyken çalmaya devam
ediyor, fader'lar çalışıyor. İki açık madde, her biri AYRI commit:

- [x] **Kilit ekranı kontrolleri çıkmıyor.** Muhtemel sebep: Chrome Android
      5 saniyeden kısa medyayı bildirime almıyor. Sessiz WAV 1 saniye;
      en az 10 saniye yapılacak (8 kHz 8-bit mono ile ~80 KB kalır).
      play() kullanıcı hareketi İÇİNDE çağrılmalı, playbackState ayarlanmalı.
- [x] **Her açılışta 6 stem yeniden iniyor.** Stem m4a'ları cihazda
      önbelleğe alınacak (şarkı id'siyle), 300 MB sınır, en eski kullanılan
      silinecek (LRU). `navigator.storage.persist()` istenecek. Ayarlara
      "çevrimdışı kopyaları sil" düğmesi. İkinci açılışta stem için ağ
      isteği OLMAMALI.

### Aşama 5 notu – bellek uyarı eşiği cihaza göre
Sabit 6 dakika değil, `navigator.deviceMemory` değerine göre:
- 8 GB ve üstü: uyarı yok (10 dakikalık yükleme sınırına kadar)
- 4 GB: 8 dakika
- daha az ya da bilinmiyor (`undefined`): 6 dakika

Eşiği aşan şarkıda "uzun şarkı, telefonda bellek sorunu çıkabilir" uyarısı
gösterilir ama açmaya İZİN VERİLİR. Yalnızca mobilde geçerli.

## Aşama 6 – İndirme (uygulama notları)
- `<a download>` BAŞKA ORIGIN'de çalışmıyor: tarayıcı niteliği yok sayıp
  dosyayı indirmek yerine açıyor. Bu yüzden indirmeyi sunucu tarafı
  zorluyor: `Content-Disposition: attachment`.
- Dosya adı anlamlı olmalı: `<şarkı adı> - <kanal>.<uzantı>`. Türkçe
  karakterler için `filename*=UTF-8''<yüzde-kodlu>`, eski istemciler için
  ASCII `filename="..."` yedeği.
- Akış: `POST /songs/{id}/download-link` → imzalı URL → o adrese git.
  İmzalı URL token istemiyor, 10 dakika geçerli.
- Android Chrome'da dosya İndirilenler klasörüne inmeli.

## Aşama 6 – İndirme
- Her kanalda indirme menüsü: M4A / FLAC / WAV. Önce download-link iste, sonra imzalı URL'ye yönlendir.
