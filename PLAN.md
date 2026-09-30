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

## SIRADAKİ İŞLER (bu sırayla)
Her oturumun başında buraya bak. Ayrıntılar ilgili aşama bölümlerinde.

**Aşama 9 (Hi-Fi) KAPANDI** - 2026-09-29, telefonda doğrulandı. Hi-Fi tarafına
dokunan her değişiklikten sonra deploy'dan ÖNCE:
`modal run backend/app.py::hifi_smoke`.

### Biten
0. [x] **MSST dosyaları depoya alındı.** `backend/vendor/msst/` (MIT, pinli
   commit `84b1eac...`), imaja `add_local_dir` ile giriyor. Build'de ağ erişimi
   yok; `curl` olmadığı için patlayan `fetch_hifi` build'i bu yüzden
   patlamıştı. torch 2.5.1 yaması artık depodaki dosyada görünüyor.
   `experiment.py` de aynı kaynağı kullanıyor.
1. [x] **Şarkı silme (tekli + çoklu).** Kütüphanede uzun basınca seçim modu,
   onay penceresi, cihaz önbelleğinden de silme. Sunucuda `DELETE /songs/{id}`
   ve `POST /songs/delete`; kimlik deseni nokta/eğik çizgi kabul etmiyor, yani
   `../` ile model ağırlıklarına ulaşılamıyor (test edildi). İşlenmekte olan
   şarkı silinmiyor - süren `separate` girdisini bulamayınca kitaplıkta boş
   bir şarkı canlanırdı.
2. [x] **Deney şarkıları temizlendi** (`experiment.py::cleanup`; ölü
   `weights-exp/msst` kopyasını da siliyor).
3. [x] **Kalite paketi.** Telefonda doğrulandı (2026-09-29): Yüksek kip,
   256k/48k, kalite iyi, hiza testi hepsi geçti.
   - Mobilde varsayılan **Yüksek**: `sampleRate` zorlaması ve mono indirme yok,
     cihazın doğal hızı (48 kHz) ve stereo. Tasarruf (32 kHz mono) ayarlarda
     yedek; elle seçilmiş tercih korunuyor.
   - Oynatma dosyaları **AAC 256k / 48 kHz**, yeniden örnekleme sunucuda
     (mümkünse soxr, değilse swr - log'a yazılıyor). **FLAC asıllar 44.1 kHz /
     24-bit kalıyor**, model oradan çıkıyor.
   - Mevcut şarkılar: `modal run backend/app.py::reencode` (`--yes` uygular).
     GPU yok, yeniden ayırma yok, akor/vuruş yeniden hesaplanmıyor; kaynak
     kayıpsız asıl olduğu için ses ikinci kez kayıplı kodlamadan geçmiyor.
     `stems_version` artıyor, yoksa telefon eski dosyaları sessizce çalardı.
   - Çevrimdışı önbellek sınırı 300 MB → **2 GB**.
   - Aşama 5'in "32 kHz mono" bellek önlemi ÖLÇÜMLE ÇÜRÜDÜ (bkz. Aşama 5
     notu); AAC priming de elendi (bkz. Aşama 8, vuruş ızgarası maddesi).
4. [x] **Geri tuşu.** Katman yığını (`navstack.js`, saf mantık + 31 node
   testi) history yığınıyla birebir eşleşiyor: her açık katman = bir history
   girdisi, URL'e DOKUNULMUYOR (katman yalnız `history.state` içinde).
   Sıra: menü → panel → seçim modu → ekran → çıkış. Kapatmanın TEK yolu
   `history.back()`; UI düğmeleri de oradan geçiyor, yoksa iki yığın ayrışıp
   geri tuşu "zaten kapalı" katmanı kapatmaya çalışırdı.
   Yükleme örtüsü ve hiza testi sürerken geri YUTULUYOR (girdi geri konuyor).
   Metronom paneli kapanınca metronom çalmaya devam ediyor. Mikser →
   kütüphane: duraklat, konum korunur, tamponlar kalır; mini oynatıcı yok.
   Açılışta ve yenilemede taban girdi `replaceState` ile kuruluyor.
5. [x] **Hızlı açılış.** ÖNCE ÖLÇÜLDÜ (masaüstü, 110 sn şarkı, Yüksek kip):
   açılışın %90'ından fazlası `decodeAudioData`'da geçiyordu.

   | | önce | sonra |
   |---|---|---|
   | ilk açılış (ağ) | 2880 ms | 1669 ms |
   | önbellekten | 2953 ms | 1527 ms |
   | bilgi de cihazdan | — | 1500 ms |
   | **aynı şarkıya dönüş** | 2953 ms | **0 ms** |

   - Aynı id + aynı `stems_version` + aynı kalite kipi + tamponlar bellekte
     ise hiçbir şey indirilmiyor/çözülmüyor; duraklatılan konum korunuyor.
     Sürüm BİLİNMİYORSA hızlı yol yok - bayat sesi sessizce çalmaktansa
     yeniden yüklemek iyidir.
   - Durum/akor cihazda (localStorage, şarkı başı ~12 KB, 40 şarkılık LRU);
     açılış sunucuyu beklemiyor, sunucu ARKADA yoklanıyor ve `stems_version`
     değişmişse şarkı yeni sesle yeniden yükleniyor.
   - Getirme ve çözme tek boru hattında, İKİŞERLİ. İkiden fazlası yok:
     Tasarruf kipinde her çözme kendi stereo ara tamponunu açıyor.
   - Çözülmüş sesi diske yazmak YOK (9 dk ≈ 1.25 GB PCM).

6. [x] **Çevrimdışı davranışı.** (2026-09-29)
   - **Kitaplık listesi cihazda** (`stem-mikser.library`): açılışta önce o
     gösteriliyor, sunucu arkada yoklanıyor. İnternet yokken uygulama yeniden
     açılınca kitaplığın bomboş gelmesi böyle bitti.
   - **Her GET'e zaman aşımı** (8 sn, `AbortController`) ve bu zaman aşımı
     YANIT BAŞLAYANA kadar geçerli - gövde okuma sınırsız, yani büyük bir stem
     yavaş şebekede rahatça inebiliyor. Yükleme (XHR) zaman aşımsız.
     "Sonsuza kadar hazırlanıyor" kusurunun kökü buydu: bağlantı reddedilmek
     yerine asılı kalırsa bekleme sınırsızdı.
   - `navigator.onLine` YALNIZ NEGATİF yönde kullanılıyor (false ise gerçekten
     ağ yok); true olması internet olduğunu kanıtlamadığı için asıl kapı zaman
     aşımı. Ayrıca son isteğin sonucu (`serverReachable`) da hesaba katılıyor.
   - Çevrimdışıyken: sesi cihazda olan şarkılar **normal**, olmayanlar
     **soluk**; soluğa dokununca tek cümle ("İnternet yok, bu şarkı telefonda
     kayıtlı değil") ve **mikser açılmıyor**. Yükleme düğmesi kapalı; silme ve
     Hi-Fi'a yükseltme tek cümleyle reddediliyor.
   - Uzun "antivirüs / VPN / ALLOWED_ORIGINS" tanı metni artık **yalnız
     internet varken** çıkıyor; çevrimdışıyken tek cümle.
   - **Açılış herhangi bir adımda düşerse kütüphaneye dönülüyor**, boş
     mikserde kalınmıyor; sebep kitaplıkta hemen yazıyor.
   - Yerelde doğrulandı (mock API kapatılarak ve `navigator.onLine` false'a
     çevrilerek): çevrimdışı yeniden açılışta liste cihazdan geliyor, cihazda
     sesi olan şarkı ağsız açılıyor (6 kanal), olmayan soluk ve tek cümle
     veriyor, bağlantı geri gelince görünüm kendiliğinden düzeliyor.
   - **DÜZELTME (aynı gün): zaman aşımı 8 sn ÇOK KISAYDI.** API'nin
     `min_containers`'ı yok, yani boştayken konteyner kapalı ve ilk istek
     soğuk başlangıcı bekliyor - meşru bir bekleme. 8 sn'de kesilip yeniden
     denenince her açılışa saniyeler biniyordu; gerçek Modal'da yeniden deneme
     hâlâ uyanmakta olan konteynere denk gelirse ikinci kez kesilip HATA
     veriyor. Sahte sunucuya soğuk başlangıç taklidi eklendi
     (`mock_server.py --cold 12`) ve ölçüldü: 12 sn'lik soğuk başlangıçta ham
     `fetch` 12.0 sn, uygulama yolu 9.7 sn sürüyordu (ilk istek 8 sn'de
     kesilmişti). **Zaman aşımı 30 sn** oldu ve **zaman aşımında yeniden
     deneme kaldırıldı** (30 sn'de cevap vermeyen sunucuya aynı isteği
     tekrarlamak beklemeyi ikiye katlamaktan başka bir şey yapmıyor).
     Yeniden deneme yalnız ANINDA düşen bağlantı için duruyor.

6.5 [x] **Önden indirme + telefon ölçümleri.** (2026-09-29)
   **Telefonda ölçülen:** cihazda kayıtlı şarkılar **1-2 saniyede** açılıyor
   (Karabasan, 558 sn: **6 sn**). İlk açılışta darboğaz **İNDİRME**
   (~0.6-1.2 MB/sn), çözme değil.
   - **Paralel çözme varsayılanı 3**, 6 seçeneği KALDIRILDI: telefonda 6'lı
     çözmede toplam çözme işi 4 katına çıktı (8 sn → 32 sn). Masaüstünde duvar
     saati kazanıyordu (2→2147, 3→1542, 6→1181 ms) ama telefonda çekirdekler
     doyuyor.
   - **Şarkı bitince ses ÖNDEN iniyor:** ayrıştırma bittiğinde (durum → done)
     ya da Hi-Fi'a yükseltme bitince (aynı şarkının `stems_version`'ı
     değişince), uygulama açıksa stem'ler arka planda cihaza indiriliyor.
     Kitaplıkta "cihaza iniyor %X" + ince çubuk görünüyor. Kullanıcı bir şarkı
     açarsa indirme **anında duraklıyor** (`AbortController`; yarım kalan stem
     sonra baştan iniyor - telefonda bir stem 10-20 sn sürebildiği için "bir
     sonraki stem'i bekle" çok kaba kalırdı) ve açılış bitince devam ediyor.
     Kuyruğa yalnız GÖZÜN ÖNÜNDE biten şarkılar giriyor; açılışta bütün
     kitaplığı indirmeye kalkmıyor.
   - **Çevrimdışı önbellek sınırı 20 GB** (2 GB'dan). 256k'da şarkı başı
     ~11.5 MB/dk, yani ~400 şarkı. Asıl tavan tarayıcının kotası.
   - Yerelde doğrulandı (mock'a "ayrıştırma bitiyor" ve "yavaş stem" taklidi
     eklendi): geçiş yakalanıyor, 6 stem kendiliğinden iniyor, yüzde ilerliyor,
     başka şarkı açılınca %17'de duruyor ve açılış bitince %67'ye devam ediyor.

### Sırada
7. [ ] **Piyano ve davulu Hi-Fi modelden (BS-RoFormer SW) almak.** PLAN ONAYLANDI
   (2026-09-29), deney KODU henüz yazılmadı (şarkı adları bekleniyor).
   **Temel:** SW altı stem'i tek geçişte zaten üretiyor; `_hifi_vocals` beşini
   atıyor (`app.py:972`). Ek GPU maliyeti 0 sn. Stem sırası (`training.instruments`)
   doğrulanmadı, kod isimle indeksliyor.
   **Dikkat:** kulak testi ŞART. Aşama 9 deneyinde Zeus'ta B, bas-klavye arası bir
   sesi tamamen piyanoya atmıştı; B'nin bas/gitarı da kayıptı.

   **Çıkışlar (şarkı başına):** SW bir kez, demucs iki kez.
   - **V0:** bugünkü canlı zincir (referans, deney şarkıları temizlendiği için yeniden).
   - **V1:** enstrümantal = karışım − vokal − piyano, sonra demucs.
   - **V2:** enstrümantal = karışım − vokal − piyano − davul, sonra demucs.
   Kulak testi V0/V1/V2. Hepsi ORTAK clip_scale ile (yoksa ~1 dB ses farkı
   "daha iyi" yanılgısı yaratır); etiketler nötr harf, anahtar ayrı dosyada.

   **Yön faktörü (demucs artığı nereye gidecek):** ÖNCE ölç: demucs'un piyano/davul
   artığının RMS'i, SW stem'ine oranla (dB), vokal artığı referansıyla. Referansın
   altındaysa yalnız "p" (aynı stem) üretilir. Büyükse o (`other`) ve p ikisi de
   üretilir.

   **Ölçüm:** hepsi 2 sn'lik pencerelerle; şarkı ortalaması + en kötü 5 pencere
   ZAMAN DAMGASIYLA. Dinleme bölümü: bir normal bölüm + en kötü pencere.
   Metrikler: toplam artığı (ε), bas <200 Hz enerjisi (V0'a göre dB), piyano ve
   davul stem'inin <150-200 Hz payı, V0 bas stem'inin adayın piyanosuna geçen
   payı (izdüşüm), demucs artık RMS'i, `::crackle` (HAZBIN, tüm adaylar),
   piyanosuz şarkıda piyano stem'inin karışıma oranı.
   **Davul, V0/V1/V2'nin üçünde de karşılaştırılır:** V1'de piyano demucs'tan
   ÖNCE çıktığı için Below The Surface'teki davul sızıntısı değişebilir.

   **Şarkılar:** Zeus (bas/klavye, 808), Below The Surface (davula piyano sızması,
   gerçek gitar), HAZBIN (cızırtı), piyano ağırlıklı = [BELİRLENECEK], piyanosuz =
   [BELİRLENECEK].

   **Karar kuralı (piyano ve davul ayrı):** en az 2 şarkıda "iyi", hiçbirinde
   "kötü" yok; piyanosuz şarkıda uydurma piyano V0'dan fazla değil. Davul için
   ayrıca: davul kapalıyken `other`'da zil/hi-hat hayaleti yok ve Zeus'ta bas solosu
   kötüleşmemiş. Tutmayan stem V0'da kalır. (c2) uyum kapısı YOK; yalnız Zeus'ta bas
   kaybolursa denenir. Maliyet tahmini ~35-60 sent (5 şarkı; en belirsiz kalem
   yazma süresi, ilk koşuda `timing`'den bakılır).

   **Kulak testi notları (2026-09-30, anahtar HENÜZ AÇILMADI; 5 şarkı bitince açılacak):**
   - Oturum 1 yapıldı: Final Duet ve Zeus (bkz. pd_out, gitignore'lı). Nothing Else
     Matters, Below The Surface, HAZBIN başka gün dinlenecek.
   - **CANLI SÜRÜMDE BAS CIZIRTISI VAR (yeni bulgu).** Orijinal Zeus (harfsiz,
     canlıdaki) hepsi açıkken 2:25-2:40 temiz; bas SOLO'da cızırtı var. Yani kaynak
     şarkıda değil, ayrıştırmadan geliyor ve bugünkü zincirde de var. Anahtar
     açılınca değerlendirilecek: yeni yöntemler bu bas cızırtısını azaltıyor mu,
     artırıyor mu? Ölçüt: bas stem'inde >2 kHz enerji payı ve darbe sayacı
     (`pd_crackle`), canlı şarkının kendi bas stem'iyle karşılaştırmalı. NOT: bu
     karşılaştırma harf kimliğini açık eder, anahtarla birlikte yapılacak.
   - `::crackle` (mutlak eşik 0.25) solo stem cızırtısını GÖREMİYOR (bas tepesi
     0.025); `pd_crackle` stem'e göreli. Darbe sayacı piyano vuruşlarında yanlış
     alarm veriyor, güvenilir gösterge >2 kHz payı.

   **SONUÇ (2026-10-01, anahtar açıldı, 5 şarkı dinlendi): kural GEÇMEDİ, canlı V0'da KALIYOR.**
   - **Piyano (SW'den, V1):** piyano stem'i 4/5 şarkıda V0'dan temiz (Zeus, Final Duet,
     Nothing Else Matters, HAZBIN; BTS benzer). AMA V1'de demucs'un bası bozuluyor:
     Zeus'ta bas ölü, NEM'de bas stem'ine gitar/müzik karışıyor, BTS'de piyano
     bölüm 1'de davula gidip piyano stem'i boş kalıyor. "Hiçbirinde kötü yok" ✗.
   - **Davul (SW'den, V2):** hayalet yok (davul kapalı: hiçbirinde fark), Zeus'ta bas
     V0'dan iyi. AMA BTS'de davula piyano sızıntısı V0'dan KÖTÜ (T en kötü), HAZBIN'de
     davula müzik karışıyor (V0 de kötü). Net kazanç yalnız Zeus. ✗.
   - **Yön:** o (artık other'a) piyano solosunda tutarlı daha temiz; p (artık piyanoya)
     gitar/ses kalıntısı getiriyor (NEM, Zeus, HAZBIN). Piyano kapalıyken o'da
     hayalet duyulmadı.
   - **Sürpriz:** V2 (piyano+davul önce çıkarılınca) Zeus'un basını V0'dan çok daha iyi
     yaptı (kulak: V2 en iyi, V0 "ince, kesintili, cızırtılı"). `bass_low_delta`
     metriği "V2 bas kaybediyor" demişti: YANLIŞ ALARM; metrik V0'ın basını doğru
     kabul ediyor, V0'ın bası kirliymiş. Bu metriği doğruluk ölçüsü olarak KULLANMA.
   - **Canlı (V0) kusurları:** Zeus bas ince/cızırtılı; NEM'de piyanosuz şarkıda piyano
     stem'inde gitar+müzik; Final Duet'te keman sızıntısı; HAZBIN'de davul solosunda
     müzik+hışırtı ve piyano solosunda cızırtı.
   - **Bas cızırtısı (Zeus, >2 kHz payı, 2:25-2:40):** V0 0.0043, V1 0.0087 (2 kat
     kötü), V2 0.0006 (7 kat az). Diğer 4 şarkıda ölçüm anlamlı fark göstermedi.
   - **Kulak gürültüsü:** aynı stem'i taşıyan harfler arasında puan ters dönüyor
     (HAZBIN davul P/W, HAZBIN bas 3:05 Q/T, NEM bas K/Q). Uygulama S/M cızırtısı
     hatası (aşağıda) sebep olabilir. Tek tek satırlara değil, şarkılar arası
     tutarlı örüntüye güvenildi.
   - **Sıradaki aday (CPU, GPU'suz, kararını bekliyor):** V3 = vokal SW, piyano SW (o),
     davul V0'dan, bas/gitar/other V2'den; mevcut FLAC'lerden birleştirilir.
   - **AYRI İŞ: uygulamada S/M cızırtısı.** Kesitlerde solo/mute yaparken bazen
     cızırtı başlıyor, şarkıdan çıkıp girmek düzeltmiyor, uygulamayı kapatıp açmak
     gerekiyor; bir kez süre çubuğu dondu. Üçünde de davul kanalına dokunulduktan
     sonra. Bellek/önbellek ya da mute/solo geçişi şüpheli. Henüz incelenmedi.

   **Canlı yola girerse (sonuç iyi çıkarsa):**
   - `_hifi_vocals`'ın dönüşü genişler, `separate` piyano/davulu çıkarır,
     artığı yön faktörünün sonucuna göre yönlendirir; `hifi_smoke` güncellenir.
   - Şarkı kaydına boru hattı sürümü yazılır: `status.json` → `pipeline: "hifi_v2"`
     (bugünkü zincir `hifi_v1`, alan yoksa v1 sayılır). Telefondaki önbellek anahtarı
     bu sürümü içerir, reprocess sonrası eski stem çalınmaz.
     NOT: `stems_version` (zaman damgası) zaten her yeniden işlemede değişiyor ve
     anahtarda; `pipeline` bunun üstüne anlamsal etiket. Anahtar biçimi değişirse
     cihazdaki her şey bir kez yeniden iner, `pruneSuperseded` regex'i de buna
     uyarlanmalı.
   - Mevcut şarkıları `reprocess` ile yenilemek ~şarkı başı $0.04.
8. [ ] **Aşama 10 - davul alt parçaları.** Düşük öncelik, en sona.

### Sonra (şimdilik gerek yok)
**Anında başlatma (önizleme dosyaları).** KOD YOK, plan. **ERTELENDİ
(2026-09-29):** telefon ölçümünde cihazda kayıtlı şarkılar 1-2 saniyede
(9 dakikalık şarkı 6 saniyede) açılıyor ve ilk açılıştaki darboğaz İNDİRME
(~0.6-1.2 MB/sn), çözme değil. Önden indirme (madde 7) ilk açılış beklemesini
de büyük ölçüde kaldırdığı için bu işin kazancı kalmadı. Plan duruyor,
gerekirse buradan devam edilir.

   **Sunucu:** her stem için ilk 30 saniyeyi ayrı bir dosya olarak da üret
   (`stems/preview/<ad>.m4a`). Kesme `ffmpeg -c copy` ile, YENİDEN KODLAMA
   YOK - AAC çerçeveleri birebir aynı kopyalandığı için çözülen örnekler de
   aynı olmalı (yalnız son çerçeve kırpma sınırında farklı olabilir). Maliyet
   ihmal edilebilir: kod çözme/kodlama yok, sadece kopyalama. `reencode`
   komutu bunları da üretmeli, `stems_version` ortak.

   **Uygulama:** önce önizlemeler çözülüp ÇALMAYA BAŞLANIYOR (6 × 30 sn =
   çözme süresinin ~1/4'ü), tam dosyalar arkada iniyor ve çözülüyor. Hazır
   olunca kaynaklar **zamanlanmış bir anda** değiştiriliyor: seek'te
   kullanılan konum hesabının aynısıyla, örnek hassasiyetinde. Önizleme
   biterken tam dosya hâlâ hazır değilse kısa bir bekleme (sessizlik) olsun -
   yanlış konumdan devam etmektense duraksamak iyi.

   **Neden bu iş:** ölçüm (madde 5) açılışın %90'ından fazlasının
   `decodeAudioData`'da geçtiğini gösterdi; önizleme o sürenin dörtte birini
   ödeyip çalmaya başlıyor, kalanını arkaya atıyor.

   **Kabul testleri:**
   - Önizleme ile tam dosyanın ilk 29 saniyesi ÖRNEK ÖRNEK aynı mı? (İkisini
     de çözüp fark al; eşik: tam sıfır ya da yalnız son çerçevede fark.)
   - Hiza testine **"değişim anı"** satırı: kaynak değiştirme sırasında
     kayma var mı - 1.0x (bypass), 0.8x ve canlı hız değişimi sırasında.
     Eşik yine ±10 ms; saçılma raporlanır.
   - Önizleme bitmeden tam dosya hazır olmazsa davranış: duraksama var ama
     konum DOĞRU.

   **Bilinen risk:** esnetici açıkken düğümün içinde ~120 ms duyulmamış ses
   var; kaynak değişimi o boru hattının hesabını bozmamalı (Aşama 8'deki
   "yeniden çıpalama" kuralı burada da geçerli).


### Kalite zinciri (2026-09-29 sonrası)
| adım | format | kHz | kanal | derinlik/bit hızı |
|---|---|---|---|---|
| sunucu decode | ham f32 PCM | 44.1 | 2 | float32 |
| BS-Roformer (Hi-Fi vokal) | tensör | 44.1 | 2 | fp32 |
| htdemucs_6s | tensör | 44.1 | 2 | float32 |
| `master/*.flac` (asıl) | FLAC | 44.1 | 2 | 24-bit |
| `stems/*.m4a` (telefon) | AAC | **48** | 2 | **256 kbps** |
| telefonda decodeAudioData | AudioBuffer | 48 (cihaz hızı) | 2 | float32 |
| bus + esnetici | — | 48 | 2 | — |

Yeniden örnekleme zincirde **bir kez** ve sunucuda (44.1 → 48, soxr).
Telefon artık hiç yeniden örneklemiyor.

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

## Aşama 8 – Hız ve ton değiştirme — TAMAM (telefonda doğrulandı)
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

### Telefon ölçümü (2026-09-28, Android 10 / Chrome 153 / 8 GB / 10 çekirdek)
SoundTouchJS ile 6 kanal: oran **0.111**, `processorerror` **0**, ses geliyor,
takılma yok. Tek kusur: 0.8x + 2 yarım seste sentetik sinyalde çok hafif bir
gıcırtı. `quickSeek: false` bunun ilk şüphelisi olarak kapatıldı (aşağıda).

### UYGULANDI - tek düğüm, toplama bus'ında
```
6 source (hepsi aynı playbackRate) -> stem gain'leri -> bus
  -> tek SoundTouchNode -> master -> destination
```
Kanal başına ayrı düğüm bilinçli olarak REDDEDİLDİ. WSOLA her sekansta
yapıştırma noktasını kendi sinyaline göre seçiyor; altı ayrı düğümde her stem
kendi `seekWindow`'u (~23 ms) kadar bağımsız oynar ve davulla bas arasında
flam çıkar. Tek düğümde bu yapısal olarak imkânsız, gecikme tek bir sayı,
CPU altıya bölünmüyor. Metronom düğümün DIŞINDA (doğrudan `destination`),
yoksa tıklar zaman esnetmesinde yayılırdı.

Bedeli: fader/solo/mute düğümün ÖNÜNDE, yani esnetici açıkken ~145 ms geç
duyuluyorlar. Master düğümün ARDINDA, ana ses anında. Kabul edildi.

### GECİKME: İÇERİK gecikmesi, tahmin değil ölçüm
Motorun zaman eşlemesinde gereken büyüklük şu: girişe t anında giren bir
olay çıkışa t + D anında çıkıyor. **İlk sürüm yanlış şeyi ölçüyordu** -
"çıkışın ilk sıfırdan farklı karesi", yani WSOLA'nın çıkış üretmeye başlaması
için biriktirdiği BAŞLANGIÇ doluşu. Hiza testi farkı yakaladı: 0.8x'te
+34 ms, 1.2x'te +10 ms sapma (telefon ve masaüstü birebir aynı, yani model
hatası, cihaz değil).

Sonda artık düzensiz aralıklı 24 tıklık bir treni gerçek hızda çalan bir
kaynaktan düğüme geçirip gözlenen/beklenen medyan farkı alıyor. Aralıklar
DÜZENSİZ olmak zorunda: eşit aralıklı trende D ile D+aralık ayırt edilemiyor.
WSOLA bir tıkı düşürüp çiftleyebildiği için kaba hizalama oylamayla, ince
ölçüm medyanla yapılıyor.

**D SİNYALE BAĞLI.** Aynı hızda ölçüldü (0.8x, 32 kHz):

| sondanın sinyali | D |
|---|---|
| tıklar SESSİZLİK üzerinde | 122.3 ms |
| tıklar + akor zemini | 110.6 ms |
| tıklar + armonik/gürültü karışımı | 110.8 ms |
| tıklar + saf sinüsler | 113.1 ms |
| tıklar + gürültü | 114.1 ms |

Sürekli zeminler 3.5 ms içinde uyuşuyor; ayrışan tek şey sessizlik. Gerçek
müzik sürekli olduğu için sonda armonik + deterministik gürültü zemini
kullanıyor (`Math.random` YOK, ölçüm tekrarlanabilir olmalı). Artakalan
birkaç ms WSOLA'nın doğasından; tek tek tıklarda saçılma zaten ±17 ms.

Ölçülen içerik gecikmeleri: 0.8x → 113.5, 1.1x → 123.5, 1.2x → 125.8,
1.5x+6 → 126.2, 0.5x-6 → 109.7 ms. Ölçüm başına ~280 ms, (örnekleme hızı,
0.05'lik oran ızgarası, yarım ses) başına önbellekli, kaydırıcı bırakılınca
yapılıyor. Başarısız olursa 115 ms.

### Canlı hız değişiminde yeniden çıpalama
Değişim anında düğümden ÇIKAN konum ile GİREN konum aynı değil: aralarında
`latency * rate` kadar şarkı zamanı var ve bu dolgu ESKİ hızla birikmişti.
Kararlı rejimde çıkış(t) = giriş(t − D) olduğundan doğru çıpa giriş tarafı:

```
offset    = currentTime + latency_eski * rate_eski   // o anda GİREN konum
startedAt = ctx.currentTime
latency   = D_yeni
```

Önceki kod offset'e ÇIKAN konumu yazıyordu; hata
`D_eski*hız_eski − D_yeni*hız_yeni` kadar oluyordu. 0.8x → 1.1x için
0.11*(1.1−0.8) = 33 ms; hiza testi −34 ms ölçtü. Düzeltmeden sonra +3..5 ms.
Yeniden başlatma gerekmedi.

Bypass sınırı geçilirken (stop + play) boru hattı boşaldığı için orada ÇIKAN
konum doğru çıpa; o dal değişmedi.

### Üç ayrı zaman (`engine.js`)
| | ne | kim kullanıyor |
|---|---|---|
| `currentTime` | esneticiden ÇIKMIŞ olanın şarkı konumu | metronom, duraklatma çıpası, bitiş kontrolü |
| `visualTime` | KULAĞA GİDENİN konumu (`- ctx.outputLatency * rate`) | akor şeridi, süre çubuğu, Media Session |
| `songToCtx(t)` | şarkı zamanı -> ctx saati | metronomun ileriye bakan zamanlayıcısı |

`ctx.outputLatency` metronoma EKLENMİYOR: tıklar da stem'lerle aynı çıkıştan
geçtiği için o gecikmeyi ikisi birlikte yiyor. Bluetooth kulaklıkta 200 ms'yi
bulabildiği için yalnız görsel imleçten düşülüyor.

### Bypass gerçek
`rate === 1 && semitones === 0` iken düğüm hiç YARATILMIYOR, gain'ler
doğrudan master'a gidiyor, worklet modülü bile yüklenmiyor. Sınır geçilirken
(bypass <-> etkin) zincir yeniden kuruluyor - tek yeniden başlatma orada.
Aynı kipte kalındığında değişim canlı, yeniden başlatma yok: kaynakların
`playbackRate`'i ve düğüm parametreleri anında değişiyor, ardından
`startedAt = şimdi - latency` ile yeniden çıpalanıyor.

`stop()` esnetici düğümünü de düşürüyor: içinde henüz DUYULMAMIŞ ~145 ms ses
var, kalıcı tutulsa her duraklat/seek sonrası yanlış konumdan sızardı.
Düğümün kendini boşaltan bir mesajı yok.

### SoundTouch kalite ayarları (erişilebilir)
`stNode.setStretchParameters({...})` ile hepsi çalışma anında değiştirilebiliyor
(mesaj sıraya alınıp bir sonraki render bloğunda uygulanıyor):

| ayar | varsayılan | not |
|---|---|---|
| `sequenceMs` | 0 = otomatik | tempoya göre `130 - 20*tempo` ms, 50..125 arası kırpılmış |
| `seekWindowMs` | 0 = otomatik | `25.67 - 2.67*tempo` ms, 15..25 arası |
| `overlapMs` | 8 | çapraz geçiş; `calculateOverlapLength` 8'in katına yuvarlıyor |
| `quickSeek` | true | kaba arama |

**Seçim:** ilk üçü OTOMATİK bırakıldı - tempoya uyarlanan formül elle
seçilmiş tek bir sabitten iyi. `quickSeek` KAPATILDI: tam arama örtüşme
hizasını düzeltiyor ve telefonda bildirilen hafif gıcırtının ilk şüphelisi
bu. Maliyeti `seekLength` (~23 ms = 736 kare) üzerinden birkaç kat ama tek
düğüm olduğu için ölçülen 0.111 oranı kat kat baş bırakıyor.

Gecikme ölçümüne bu üçlüyü vermek GEREKMİYOR: gecikme yalnızca
`sequenceMs`/`seekWindowMs`/`overlapMs` ve tempodan çıkıyor, `quickSeek`
tampon boyutlarını değiştirmiyor.

### Arayüz
Moises düzeni. Tempo kaydırıcısı BPM gösteriyor, ton kaydırıcısı yeni tonun
adını (`Fm → Gm`); ikisinde de `-`/`+` ve "Orijinale geri dön".

Tempo kaydırıcısının iç birimi BPM DEĞİL, orijinalden tam sayı BPM sapması.
Sebep: 0 sapma tam olarak 1.0 oranı demek. Kaydırıcı doğrudan BPM tutsaydı
127.12'lik bir tempo 127'ye yuvarlanır, "orijinal" konum 0.999 oranına düşer
ve esnetici varsayılanda devre dışı KALMAZDI. Tempo bilinmiyorsa yüzde
gösterimine düşüyor. Aralık ±%50 (oran 0.5-1.5), ton ±6 yarım ses.

### Bağlı işler (bitti)
- [x] Akor şeridi tona göre transpoze; yazım YENİ tona göre (`tonality.js`,
      `_key_uses_flats`'ın ön yüz ikizi, 53 test: `node tests/tonality_test.mjs`).
      Şerit yeniden kurulmuyor, yalnız etiketler yenileniyor.
- [x] Metronom ve akor şeridi esnetilmiş zaman çizgisini takip ediyor.
- [x] bpm göstergesi hız çarpanıyla güncelleniyor.
- [x] Media Session `setPositionState`'e gerçek `playbackRate` veriliyor.

### Yerel doğrulama (mock_server + gerçek stem'ler, masaüstü + mobil emülasyon)
- 0.5x'te 4 sn'de 2 şarkı sn, 0.8x'te 3.2, 1.1x'te 4.4, bypass'ta 4.0
- 6 kaynak da aynı `ctx` anında, aynı `playbackRate` ile başlıyor
- metronom tıklarının ima ettiği gecikme her tıkta 0.144 sn = ölçülen
  esnetici gecikmesi (yani hiza tam)
- canlı ton/hız değişimi 0 yeniden başlatma; bypass sınırı 1
- mobil yol: 32 kHz, mono tampon, 0.8x doğru, `processorerror` yok

### Hiza testi (Ayarlar ekranında)
Kulakla karar verilemeyen sorular için kalıcı ölçüm aracı: `aligncheck.js` +
`tap-processor.js`. Sentetik tık stem'i motorun gerçek zincirinden geçiyor,
master çıkışı ile metronom çıkışı ayrı ayrı bir AudioWorklet'te izleniyor,
zaman damgası render iş parçacığında `currentFrame` + blok içi indeksten
üretiliyor. Kendi Engine/Metronome örneğini kurup kapatıyor, açık şarkıya
dokunmuyor; modül yalnız düğmeye basılınca yükleniyor.

Gerçek davul KULLANILMIYOR, çünkü orada "atak anı" tanıma bağlı: aynı
kayıtta akış tepesi ~10 ms geç, geri izleme ~15 ms erken okuyor. Sentetik
tıkın ilk örneği tam genlikte.

Ölçüt: medyan |fark| < 10 ms. Saçılma WSOLA'nın doğası - raporlanıyor ama
geçti/kaldı kararına GİRMİYOR.

Düzeneğin kendisi doğrulandı: 1.0x bypass'ta +0.0 ms, saçılma ±0.0 ms.

Düzeltme sonrası masaüstü (48 kHz), iki koşuda aynı:

| ölçüm | önce | sonra |
|---|---|---|
| 1.0x (bypass) | +0.0 ms | +0.0 ms |
| 0.8x | +33.0 ms | **+2.5 ms** |
| 1.2x | +4.5 ms | **+2.3 ms** |
| canlı 0.8x → 1.1x | −27.8 ms | **+3.2 ms** |
| seek sonrası bayat ses | yok | yok |
| seek sonrası konum | −17.4 ms | **−7.6 ms** |

### Bilinen, bilinçli DOKUNULMAYAN iki şey
- **Vuruş ızgarası davuldan 8-15 ms ÖNDE.** `sarki.mp3`'ün davul stem'i ile
  `beat_this` vuruşları çapraz ilintiyle karşılaştırıldı (ölçütün
  doğrusallığı bilinen kaydırmalarla sınandı, hata ±1 ms): tüm vuruşlarda
  +14.7 ms, ölçü başlarında +22.1 ms okundu; aynı ölçütün davulun kendi
  onset'lerindeki yanlılığı +7.0 ms, düşülünce +7.7 / +15.1 ms. Tempo
  sürüklenmesi yok (+0.1 ms/sn). Bu 1.0x'te de var, esneticiyle ilgisi yok
  ve TEK ŞARKIDA ölçüldü - genellemeden düzeltme yapmak aşırı uyum riski.
  Birkaç şarkı daha ölçülmeden dokunulmayacak.

  **AAC priming ELENDİ (2026-09-29).** Şüphelilerden biri şuydu: m4a'nın
  encoder priming'i (1024-2112 örnek = 23-48 ms) tarayıcıda kırpılmıyorsa
  ses ızgaraya göre kayar. Ölçüldü: çözülen tamponun süresi ile sunucunun
  ham PCM'den hesapladığı süre arasındaki fark masaüstünde **-1 ms**,
  telefonda **-0.2 ms**. Yani Chrome priming'i ve çerçeve dolgusunu
  kırpıyor; 8-15 ms'lik kaymanın sebebi bu DEĞİL. Mertebe de zaten
  tutmuyordu. Kesin ölçüm (aynı stem'in FLAC aslıyla çapraz ilinti) hâlâ
  yapılabilir ama önceliği düştü.
- **Android'de `ctx.outputLatency` 0 dönüyor.** Görsel imleçten düşülen
  telafi (`visualTime`) o cihazda etkisiz kalıyor. Kod doğru ve destekleyen
  tarayıcıda çalışıyor; Bluetooth kulaklıkta 200 ms'yi bulan gecikme için
  tarayıcı doğru değeri bildirmek zorunda. Uğraşılmayacak.

### KAPANIŞ: telefon doğrulaması (2026-09-28, Android / Chrome / 32 kHz)
Hiza testi TAMAMEN GEÇTİ:

| ölçüm | telefon | masaüstü |
|---|---|---|
| 0.8x | +1.2 ms | +2.4 ms |
| 1.2x | +2.2 ms | +2.2 ms |
| canlı 0.8x → 1.1x | +3.2 ms | +3.2 ms |
| seek sonrası konum | −0.7 ms | −7.6 ms |
| seek sonrası bayat ses | yok | yok |
| içerik gecikmesi 0.8 / 1.1 / 1.2x | 110.8 / 119.9 / 120.5 ms | 113.5 / 123.5 / 125.8 ms |

Ayrıca elle doğrulandı: ton +2'de Fm → Gm ve akor şeridi doğru, kilit ekranı
süre ve konumu uygulamayla aynı hızda ilerliyor, 0.8x'te davul-bas senkronu
ve canlı hız değişimi sorunsuz.

**Kalan tek konu, Aşama 8.1'e devredildi:** 0.8x + ton +2'de gıcırtı yok ama
genel ses kalitesi düşüyor. WSOLA'nın yapısal sınırı; `quickSeek: false`
gıcırtıyı aldı, kaliteyi bu kadar yükseltebildi.

### Plan B (kullanılmadı)
Sunucuda render. Ölçüm iyi çıktığı için gerek kalmadı; her ayar değişiminde
yeniden render + indirme maliyeti ve anlık geri bildirimin kaybı vardı.

## Aşama 8.1 – Esnetici kalitesi — TAMAM (Signalsmith seçildi)
Aşama 8'den devreden tek konu: 0.8x + ton +2'de gıcırtı yok ama genel kalite
düşüyor. WSOLA'nın yapısal sınırı.

### signalsmith yeniden aday
Aşama 8'de "gerçek zamanlıda 4+ düğümde susuyor" diye elenmişti. O ölçüm
kütüphaneyi **tampon kipinde** çalıştırıyordu (`numberOfInputs: 0` +
`addBuffers`). Artık TEK düğüm mimarisindeyiz ve mimari **canlı giriş**
istiyor - o kip hiç denenmemişti.

Duman testi (`bench.html` 3. bölüm, 6 kaynak → bus → tek düğüm, 0.8x + 2 ton):

| | süre | processorerror | sustu mu | tepe | latency() |
|---|---|---|---|---|---|
| signalsmith, masaüstü | 60 sn | 0 | hayır | 0.163 | 120.0 ms |
| soundtouch, masaüstü | 30 sn | 0 | hayır | 0.146 | — |
| signalsmith, telefon | 60 sn | 0 | hayır | 0.157 | 120.0 ms |
| soundtouch, telefon | 60 sn | 0 | hayır | 0.147 | — |

Canlı girişte signalsmith `rate`'i YOK SAYIYOR (README), yani saf perde
kaydırıcı - mimarimize zaten uyuyor. Perde telafisi elle:
`semitones = S − 12·log2(R)`.

### Lisans (teyit edildi)
Depoda gerçek `LICENSE.txt`: **MIT, Copyright (c) 2022 Geraint Luff /
Signalsmith Audio Ltd.** npm tarball'ında ayrı dosya yok, beyan
`package.json`'da.

### Mimari: arka uç kayıt defteri
`stretchers.js` iki kütüphaneyi tek arayüz ardına koyuyor
(`register/create/update/start/dispose/reportedLatency`). Motor hangisinin
seçili olduğunu bilmiyor. Bus, bypass kuralı, düğümün her `play()`'de
yeniden kurulması - hepsi aynı kaldı.

Signalsmith'in fabrikası ASENKRON ve `schedule({active:true})` olmadan hiç
ses üretmiyor; düğüm kaynaklarla AYNI ana yazılıyor (`startNode`).

### ÖLÇÜM: hiza (masaüstü 48 kHz, aynı oturum)

| ölçüm | SoundTouch | Signalsmith |
|---|---|---|
| 1.0x (bypass) | +0.0 ms (±0.0) | +0.0 ms (±0.0) |
| 0.8x | +2.4 ms (**±16.9**) | −0.0 ms (**±0.0**) |
| 1.2x | +2.2 ms (**±8.5**) | 0.0 ms (**±0.1**) |
| canlı 0.8x → 1.1x | −1.1 ms (±9.9) | +0.1 ms (±0.1) |
| seek sonrası konum | −7.6 ms | −0.0 ms |
| seek sonrası bayat ses | yok | yok |
| içerik gecikmesi 0.8 / 1.1 / 1.2x | 113.5 / 123.5 / 125.8 ms | 119.9 / 120.0 / 120.0 ms |

Medyanlar ikisinde de eşiğin içinde; **ayrışan şey SAÇILMA**. SoundTouch
WSOLA olduğu için tek tek darbeleri seekWindow kadar (±8-17 ms) oynatıyor;
signalsmith faz vokoder olduğu için oynatmıyor (±0.1 ms). Kulakla bildirilen
kalite farkının nesnel karşılığı büyük olasılıkla bu.

Signalsmith'in gecikmesi hızdan BAĞIMSIZ (sabit blok gecikmesi) ve
kütüphanenin kendi `latency()` değeriyle 0.1 ms'de uyuşuyor - iki bağımsız
yöntemin aynı sayıyı vermesi sondanın da doğru olduğunun teyidi.

### ÖLÇÜM: CPU payı, gerçek topoloji
Offline render oranı (gerçek zamanlı CPU payı tarayıcıdan okunamıyor, bu en
iyi vekil), 6 kaynak → bus → tek düğüm, 32 kHz mono, masaüstü:

| | 6 AYRI düğüm | 6 → TEK düğüm |
|---|---|---|
| SoundTouch | 0.169 | **0.043** |
| Signalsmith | 0.057 | **0.012** |

Signalsmith gerçek mimaride 3.6 kat ucuz.

### Formant telafisi – ÖLÇÜLDÜ, yönü ters çıktı
Yalın `formantCompensation: true` bizim zincirimizde ZARARLI: kaynağın
`playbackRate`'i formantları zaten rate katı kaydırmış ve düğüm yukarı
akıştaki o kaymayı göremiyor. Spektral ağırlık merkezi ölçümü (f0 150 Hz,
formant 1000 Hz'lik sentetik vızıltı):

| durum | ağırlık merkezi |
|---|---|
| girdi (referans) | 1005 Hz |
| R=0.8 S=0, telafi kapalı | 917 Hz |
| R=0.8 S=0, telafi AÇIK (yalın) | **814 Hz** = tam 0.8 katı |
| R=0.8 S=0, telafi + `formantSemitones = −12·log2(R)` | 917 Hz (düzeldi) |

Bu yüzden ayar açıkken `formantSemitones = −12·log2(rate)` da gönderiliyor;
böylece ayar yalnızca PERDE kaydırmasına karşı formant davranışını
değiştiriyor. Kulakla A/B'de yargılanmak istenen tam olarak bu.

### KARAR: Signalsmith (2026-09-28, telefonda gerçek şarkıyla A/B)
**Signalsmith açık ara kazandı.** Formant telafisi KAPALI daha iyi geldi.
Varsayılanlar buna göre: `DEFAULT_STRETCHER = "signalsmith"`,
`formants: false`. SoundTouch ayarlarda seçenek olarak duruyor.

Kayıtlı tercihe DOKUNULMUYOR: `parsed.stretcher` varsa varsayılan devreye
girmiyor, yani daha önce elle SoundTouch seçmiş bir cihaz öyle kalıyor.

Telefon hiza testi (32 kHz), Signalsmith, tamamen geçti:

| ölçüm | telefon | masaüstü |
|---|---|---|
| 0.8x | −0.1 ms (±0.0) | 0.0 ms (±0.0) |
| 1.2x | −0.0 ms (±0.1) | +0.0 ms (±0.1) |
| canlı 0.8x → 1.1x | −0.0 ms (±0.1) | +0.0 ms (±0.1) |
| seek sonrası konum | +0.1 ms | −0.0 ms |
| seek sonrası bayat ses | yok | yok |
| gecikme 0.8 / 1.1 / 1.2x | 119.8 / 119.9 / 119.9 ms | 119.9 / 120.0 / 120.0 ms |
| kütüphanenin `latency()` değeri | 120.0 ms | 120.0 ms |

Sonda ile kütüphanenin kendi beyanı 0.2 ms içinde uyuşuyor - iki bağımsız
yöntemin aynı sayıyı vermesi sondanın da doğrulanması.

### Yedeğe düşme
Signalsmith WASM ile geliyor. İki katman:
1. **Statik:** `isAvailable()` WebAssembly yoksa Signalsmith'i eliyor,
   `normalizeStretcher()` SoundTouch'a düşürüyor. Ayarlar ekranı bunu
   yazıyor.
2. **Çalışma anı:** WASM derlemesi ya da worklet kaydı patlarsa motor
   (`#createWithFallback`) SoundTouch'la bir kez daha deniyor.
   `activeStretcher` gerçekten kurulanı tutuyor; `update`, `start`, formant
   bayrağı ve gecikme ölçümü hep ona bakıyor - yoksa yedeğe düşen bir
   cihazda yanlış gecikme kullanılırdı.

### Hiza testi açıklaması esneticiye göre
"Saçılma WSOLA'nın doğası" cümlesi yalnız SoundTouch için doğru.
`runAlignmentCheck` artık `{rows, legend}` döndürüyor; Signalsmith'te metin
"faz vokoder darbeleri oynatmadığı için saçılma ~0 bekleniyor" oluyor.

### Elde kalan kart
Signalsmith de yetmezse SoundTouch'ta `overlapMs: 12` denemesi duruyor -
tek satır, `stretchers.js` içindeki `STRETCH_QUALITY`.

## Aşama 9 – Hi-Fi modu — KAPANDI (varsayılan, telefonda doğrulandı)
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

### DENEY KURULDU (`backend/experiment.py`) — koşum bekliyor
Ayrı Modal uygulaması (`stem-mikser-deney`). `backend/app.py` HİÇ değişmedi,
canlı endpoint aynı. Aynı Volume kullanılıyor; API'nin `/songs` ucu zaten
`status.json` içeren her klasörü listelediği için sonuçlar ek bir uç
olmadan kitaplıkta görünüyor.

```
modal run backend/experiment.py::fetch     # ağırlıklar (bir kez, ~1.6 GB)
modal run backend/experiment.py            # A, B, B-max x 3 şarkı
```

Üç kol:

| kol | ne | kitaplıkta |
|---|---|---|
| **A** | Mel-Band Roformer vokal → enstrümantal = karışım − vokal → `htdemucs_6s` | `... [A]` |
| **B** | BS-Roformer SW tek model, 6 stem, `num_overlap 2` | `... [B]` |
| **B-max** | aynı model, `num_overlap 8` + test-time augmentation (3 geçiş) | `... [B-max]` |

A'da demucs'un kendi vokal çıkışı (enstrümantalde kalan artık) **`other`'a
ekleniyor**, atılmıyor: toplam korunsun diye. Artığın RMS'i ayrıca
raporlanıyor — büyükse Roformer vokalin bir kısmını kaçırmış demektir.

Akor ve vuruş orijinalden **kopyalanıyor**, yeniden hesaplanmıyor.

### Lisans kontrolü (2026-09-28)

| bileşen | kaynak | lisans |
|---|---|---|
| A ağırlığı | `KimberleyJSN/melbandroformer`, commit `ac9b0614ab3cd7f77219e18ba494dfd93956c348` | metadata **MIT** |
| A mimarisi | `ZFTurbo/MSST`, commit `84b1eac0887756b4f1a9d7a1ff49105939749ed2` | **MIT**, gerçek LICENSE dosyası |
| A konfigi | aynı MSST deposu, `configs/KimberleyJensen/...kj.yaml` | **MIT** |
| B ağırlığı | `enerjazzer/BS-ROFO-SW-Fixed` (jarredou'nun aynası) | **YOK** |

**A'nın GPL geçmişi:** bu depo bir dönem `gpl-3.0` gösteriyordu (Intel'in
talebiyle eklenmişti; `Intel/vocals_mel_band_roformer_kimberleyJSN_openvino`
hâlâ gpl-3.0 diyor). Yazar sonradan MIT'e çevirmiş. Güncel metadata esas
alındı. Depo public olduğu için GPL kabul edilemezdi — kontrol tarihi ve
commit hash'i bu yüzden kayda geçti.

`KimberleyJensen/Mel-Band-Roformer-Vocal-Model` (çıkarım kodu) **hiç
kullanılmıyor**: o depoda LICENSE dosyası yok, yani varsayılan olarak her
hakkı saklı. Aynı mimari MIT olan MSST'de var.

**B lisanssız.** jarredou HF hesabını silmiş (404 teyit edildi). İki ayna:

| ayna | beyan | sha256 |
|---|---|---|
| `enerjazzer/BS-ROFO-SW-Fixed` | `unknown` | `24e7d35e…c775916e` |
| `Blakus/bs_roformer_sw_6stem` | `mit` | `24e7d35e…c775916e` |

**Aynı dosya** (699 412 152 bayt), yani Blakus sahip olmadığı bir dosyaya
kendi lisansını yazmış — bu lisans yaratmaz. `enerjazzer` kanonik ayna
alındı; `fetch` ikisini de indirip aynı olduğunu doğruluyor.
Deney için indirilip çalıştırılıyor, **yeniden dağıtılmıyor**.

> **Bu kural 2026-09-29'da DEĞİŞTİ.** Yukarıdaki "lisans netleşmeden B
> entegre edilemez" kuralı, proje sahibinin **kişisel kullanım** kararıyla
> kaldırıldı. Lisans hâlâ belirsiz; ağırlık depoda dağıtılmıyor, çalışma
> anında aynadan iniyor. Durum olduğu gibi `NOTICE.md`'de yazılı. Ticari
> kullanım ya da yeniden dağıtım için lisansın netleşmesi gerekir.

### Ölçülenler (şarkı × kol)
soğuk başlangıç, model yükleme (Volume'dan okuma dahil), saf GPU saniyesi,
faturalanan duvar saati, `$0.000164/sn` ile şarkı başı maliyet, tepe VRAM
(allocated + reserved), **stem toplamının karışımdan sapması** (dB + tepe),
kullanılan kesinlik.

`artık dB = 20·log10(rms(karışım − Σ stem) / rms(karışım))`, **ortak
`clip_scale` uygulanmadan ÖNCE** — sonra bakılsa hata ölçek kadar yapay
kayardı.

T4'te bf16 yok. fp16 deneniyor, **NaN nöbetçisiyle**: NaN/Inf çıkarsa
sessizce sıfırlamak yerine aynı şarkı fp32'de yeniden koşuluyor ve raporda
hangisinin kullanıldığı yazıyor.

YAML **güvenli** yükleniyor: konfigler `!!python/tuple` kullanıyor,
`yaml.unsafe_load` bunu çözer ama rastgele kod çalıştırmaya açar. B'nin
konfigi lisansı belirsiz bir aynadan geldiği için `SafeLoader`'a yalnız
tuple kurucusu eklendi (yerelde doğrulandı: `python/object/apply` reddediliyor).

### Torch uyum yaması (ilk koşumda çıktı)
Pinli MSST commit'i `attend.py`'de `sdpa_kernel(..., set_priority=True)`
çağırıyor. Bu kwarg **torch 2.6'da** eklendi; imajdaki **torch 2.5.1**'de
`TypeError` atıp çıkarımı ilk parçada düşürüyor.

Torch YÜKSELTİLMEDİ: 2.5.1 demucs yüzünden bilinçli pinli (2.6
`torch.load` varsayılanını `weights_only=True` yaptı ve demucs'un
checkpoint yükleyicisini kırabiliyor). A yolunun ikinci aşaması demucs
olduğu için yükseltmek asıl riski oraya taşırdı. MSST'yi eski bir commit'e
almak da başka API'leri geri götürürdü.

Seçilen: indirme sırasında **13 satırlık** bir sarmalayıcı ekleniyor,
`set_priority` desteklenmiyorsa kwarg'sız çağrılıyor. Bayrak yalnızca arka
uç **öncelik ipucu** - matematiği değiştirmiyor, yeni bir torch'ta ipucu
kendiliğinden geri kazanılıyor.

`attend.py`'yi hem `bs_roformer` hem `mel_band_roformer` import ediyor,
yani tek yama A ve B'nin ikisini birden düzeltiyor. Üç MSST dosyasında
başka torch 2.6+ API'si tarandı, yok.

Yama `_build_model`'da da uygulanıyor (idempotent): Volume'da yamasız bir
kopya kalmışsa deney tek komutla kendini onarıyor. Yama tutmazsa HATA
veriyor - sessizce yamasız kalıp çıkarımın ortasında patlamasındansa.

T4 notu: log'daki "GPU Compute Capability below 8.0" beklenen, sm_75'te
flash attention yok; math/mem-efficient çekirdek kullanılıyor.

### KULAK TESTİ SONUÇLARI (3 şarkı, orijinal htdemucs'a göre)

| | vokal (kapalı) | vokal (solo) | davul/bas | gitar |
|---|---|---|---|---|
| **A** | temiz | az sızıntı (1.5-3.5 sn) | iyi/çok iyi | orijinalden net |
| **B** | temiz | **en temiz** | davul iyi, **bas kayıp** | gerçek gitarda iyi, ötekilerde **yok** |
| **B-max** | temiz | değişken | iyi | — |

**B-max ELENDİ:** 5 kat süre/maliyet, tutarlı fark yok, HAZBIN'de belirgin
cızırtı (B'de yok).

**B'nin iki kayıp stem'i (deney logundan):** 1. şarkıda bas tepesi 0.0306,
gitar tepesi 0.0422; HAZBIN'de gitar tepesi 0.0024. Yani stem üretiliyor
ama neredeyse boş.

**Gitar ipucu:** gerçek, duyulur gitarı olan şarkıda (BELOW THE SURFACE) B
gitarı düzgün ayırdı. Yani B'nin gitar tespiti çalışıyor; A'nın "gitar"
dediği şey ötekilerde başka bir enstrüman olabilir.

### C: A ve B'nin iyi taraflarının birleşimi
Kulak testi net bir bölünme gösterdi: **vokalde B, bas/gitar/davulda
demucs** iyi. C tam bunu yapıyor - vokal BS-Roformer SW'den, kalan beş
stem `htdemucs_6s`'ten (A ile aynı iskelet, sadece vokal kaynağı farklı).
Demucs'un vokal artığı yine `other`'a ekleniyor.

### Kulak testinden çıkan ÖLÇÜM soruları
`modal run backend/experiment.py::analyze` bunları sayıyla cevaplıyor,
Volume'daki FLAC master'lardan, GPU'suz:

1. **Bas nereye gitti?** Stem başına <150 Hz enerjisi, yöntemler arası
   dağılım tablosu.
2. **Gitar nereye gitti?** Stem'ler arası normalize edilmiş ilişki matrisi:
   A'nın gitarı B'nin hangi stem'iyle örtüşüyor.
3. **A'nın artığı neden büyük?** Her varyantın artığı aynı ölçütle
   hesaplanıyor - ORİJİNAL (htdemucs, tek aşama) dahil. Orijinal de ~-21 dB
   çıkarsa sebep demucs'un kendi yeniden kurma hatası, A'nın yaptığı bir şey
   değil. (Vokal çıkarma tanım gereği tam olduğu için A'nın artığı =
   demucs'un enstrümantal üzerindeki hatası.)
4. **B-max'taki cızırtı?** Stem başına ardışık örnek sıçraması (süreksizlik)
   sayısı ve en büyüğü, ayrıca tepe seviyeleri.

Varyantların stem'leri farklı `clip_scale`'e bölünmüş kaydedildiği için
karşılaştırmadan önce en küçük karelerle ölçek geri kestiriliyor
(`scale = <karışım, toplam> / <toplam, toplam>`).

Ölçüm ilkelleri sentetik sinyalle doğrulandı: 60 Hz tonu <150 Hz bandına
%99.8, 5 kHz tonu %0.0; aynı içerik ilişkisi 1.00, ilgisiz 0.01, yarı
yarıya 0.86; temiz sinyalde 0 sıçrama, enjekte edilen iki tıkta tam 4.

### C KULAK TESTİ ve açık kalan cızırtı

| şarkı | vokal solo | bas | cızırtı |
|---|---|---|---|
| HAZBIN [C] | hafif sızıntı (B gibi) | iyi | **var** (vokal+other kapalıyken) |
| Below The Surface [C] | hafif sızıntı | iyi | yok |
| Zeus [C] | temiz | geri geldi (808 davulda, normal) | yok |

**C vokalde B kadar, basta A kadar iyi** — Hi-Fi adayı C. Ama HAZBIN'deki
cızırtı çözülmeden canlıya alınmıyor. Orijinalde ve A'da aynı ayarda yok,
yani C'nin yöntemine özgü.

**Elenen hipotez:** "fp16 yanlış kullanılıyor". İki konfig de
`use_amp: true` diyor, yani fp16 MSST'nin kendi varsayılanı; ben de öyle
yapıyorum. Kod hatası değil — ama çıkarma sonrası açığa çıkan hatayı
büyütüyor OLABİLİR, sınanıyor.

**Geometri farkı (asıl şüpheli):**

| | chunk | adım (overlap 2) |
|---|---|---|
| A (MelBand) | 352 800 = 8.00 sn | 176 400 = 4.00 sn |
| C (BS-RoFo) | 588 800 = 13.35 sn | 294 400 = 6.68 sn |

`::crackle` bunu varsaymak yerine ölçüyor: en büyük sıçramaların konumu
adıma göre mod alınıp dağılımın toplanıp toplanmadığına bakılıyor.
Sentetik sınamada rastgele sıçramalar 0.023, sınıra oturanlar 1.000 pay
veriyor; yanlış adımla bakıldığında 0.113'e kadar çıkabildiği için eşik
0.25 seçildi.

Düzeltme adayları: `C-fp32` (vokal geçişi fp32), `C-ov4` (num_overlap 4),
`C-fp32-ov4` (ikisi). Kitaplıkta ayrı ad olarak çıkıyorlar.

### Referans kontrolü: bizim `_demix` MSST'ninkiyle aynı mı?
`_demix`'i MSST'nin generic dalına BAKARAK yazdık ama birebir aynı olduğunu
hiç kanıtlamadık. Cızırtı bizim parça birleştirmemizden geliyorsa (B-max'taki
cızırtı da) önce bunu bilmek gerek.

`::reference` MSST'nin GERÇEK `demix()`'ini aynı checkpoint ve ayarlarla
çağırıp çıktıları örnek bazında karşılaştırıyor. Bunun için MSST'nin
`utils/model_utils.py`'si de indiriliyor (modül düzeyi bağımlılıkları hafif:
numpy, torch, ml_collections, tqdm - dataset/losses/metrics YOK).

Eşik: en kötü fark **-60 dB altındaysa aynı** (kayan nokta gürültüsü).
Üstündeyse gerçek fark var ve cızırtı önce orada aranmalı.

Bilinen bir uyuşmazlık adayı: MSST `result.div_(counter)` yapıyor, biz
`counter.clamp(min=1e-8)` ile bölüyoruz. Kenarlarda sayaç sıfıra yakınsa
sonuç ayrışır.

### Ek adaylar (bu turda eklendi)
- **C-inst:** demucs'a "karışım − B vokali" yerine B'nin KENDİ enstrümantali
  (vokal dışı 5 stem toplamı) veriliyor. Çıkarma olmadığı için vokal
  tahminindeki hata enstrümantale sızmıyor; bedeli toplamın tam
  korunmaması (~-33 dB kabul edildi).
- **E (ensemble vokal):** vokal = MelBand ve BS-Roformer vokallerinin
  ortalaması. Gerekçe: BS-Roformer daha az sızıntı ama daha çok artefakt
  üretiyor (SIR/SAR takası); MelBand tersi. İki modelin ilintisi de
  raporlanıyor - 1'e yakınsa ensemble'ın kazancı sınırlı demektir.
  Ağırlıklı ortalama DENENMEDİ: tek şarkıda ağırlık seçmek aşırı uyum.

### DENEY SONUCU ve CANLI BORU HATTI

| aday | vokal | bas/gitar | karar |
|---|---|---|---|
| A (MelBand → demucs) | az sızıntı | iyi | elendi (vokal B'den iyi değil) |
| B (tek model, 6 stem) | **en temiz** | **bas ve gitar kayıp** | elendi |
| B-max (overlap 8 + TTA) | değişken | — | **elendi**: 5 kat maliyet, tutarlı fark yok, bir şarkıda cızırtı |
| **C-fp32** | B kadar temiz | A kadar iyi | **KAZANAN** |

**Cızırtının sebebi fp16'ydı.** HAZBIN'de C (fp16) cızırtılı, C-fp32 ve
C-fp32-ov4 temiz, C-ov4 (fp16) hâlâ hafif cızırtılı. Yani sebep örtüşme
değil, vokal geçişinin hassasiyeti. Hata vokalin İÇİNDE duyulmuyor;
"karışım − vokal" çıkarmasından sonra açığa çıkıyor.

**Referans kontrolü:** kendi `_demix`'imiz MSST'nin `demix()`'iyle 6 stem'de
**maksimum fark 0.000000 (−999 dB)** — birebir aynı. Cızırtı bizim parça
birleştirmemizden gelmiyordu.

**Canlı boru hattı (varsayılan Hi-Fi):**
```
BS-Roformer SW (fp32, overlap 2) → vokal
enstrümantal = karışım − vokal          (tanım gereği tam)
htdemucs_6s → drums/bass/guitar/piano/other
other += demucs'un vokal artığı
```

**Toplam zorla eşitlenmiyor.** Denendi ve REDDEDİLDİ: demucs'un ~−21 dB
artığı tek bir kaynaktan değil tüm stem'lerden geliyor; `other`'a yığmak
davul kapatıldığında `other`'da davul hayaleti bırakırdı. Mute/solo
uygulamanın ana işi. Tüm kanallar açıkken fark duyulmuyor (standart yolda
da aynı artık vardı, fark edilmemişti).

**`ref_mean` kusuru düzeltildi:** `stems * std + mean` yayınlama yüzünden
`ref_mean`'i altı kaynağın hepsine ekliyordu (upstream demucs'ta da aynı
kusur var). Artık yalnız bir kaynağa ekleniyor.

**Ölçülen (HAZBIN, 110 sn):** duvar saati 95.1 sn, GPU 53.1 sn. 10 dakikalık
şarkı için ~5-6 dk bekleniyor; `separate` timeout'u 900 → **1800 sn**.

**Yeniden işleme:** mevcut şarkılar için `POST /songs/{id}/reprocess`;
akor ve vuruş yeniden hesaplanmıyor. `status.json`'a `stems_version`
eklendi ve telefon önbelleğinin anahtarına girdi - **bu olmadan cihaz
eski sesi çalmaya devam ederdi, üstelik sessizce.**

### İLERİDE denenecek (şimdi değil)
**Davulu ve piyanoyu da B'den al.** Below The Surface'te demucs'un davul
stem'ine piyano sızıyor; B'nin davulu ve piyanosu kulak testinde iyiydi.
Ayrıca `htdemucs_6s`'in piyanosu RESMEN zayıf - Demucs'un kendi README'si
6 kaynaklı modelin piyano ayrımının kötü olduğunu söylüyor. C'nin iskeleti
buna hazır: vokal gibi davul/piyano da B'den alınıp enstrümantalden
çıkarılabilir, kalan stem'ler demucs'ta kalır. Önce C'nin cızırtısı çözülsün.

**Enstrümanlar için ensemble.** MVSEP bas/davul/diğer için demucs
ensemble'ı kullanıyor (`htdemucs_ft` dahil). Bizde vokal için E denendi;
aynı fikir enstrümanlara da uygulanabilir. GPU süresi modelle doğrusal
arttığı için maliyeti ayrıca ölçülmeli.

### Deneyin cevapladığı sorular (artık açık değil)
- Roformer'ın T4'teki süresi (Demucs'a EK geliyor, yerine geçmiyor).
- Enstrümantali `htdemucs_6s`'e vermek gitar/piyano kalitesini bozuyor mu?
  Vokal artığı kalmadığı için iyileşmesi de mümkün, kötüleşmesi de.
- B tek modelle 6 stem'i A'nın iki aşamasından iyi mi?
- B-max'in (8 örtüşme + TTA) ek maliyeti kaliteyi hak ediyor mu?

Cevaplar: Roformer T4'te ~53 GPU saniyesi (110 sn'lik şarkı, toplam 95 sn
duvar saati) - Demucs'a EK geliyor. Enstrümantali `htdemucs_6s`'e vermek
gitar/piyanoyu BOZMADI; aynı iskeleti kullanan A'nın kulak testinde gitar
orijinalden daha net çıktı. B tek modelle A'nın iki aşamasından İYİ DEĞİL
(bas ve gitar kayboluyor). B-max'in ek maliyeti kaliteyi hak etmiyor: 5 kat
süre, tutarlı fark yok, bir şarkıda cızırtı.

### KAPANIŞ (2026-09-29, telefonda doğrulandı)
**Aşama 9 KAPANDI.** Hi-Fi varsayılan olarak canlıda; telefon testi geçti:

| kontrol | sonuç |
|---|---|
| Hi-Fi ile yeni yükleme | geçti |
| Standart ile yükleme | geçti |
| eski şarkıda "Hi-Fi'a yükselt" (`reprocess`) | geçti |
| cızırtı (vokal/other kapalı) | yok |

Deploy öncesi kapı olarak `modal run backend/app.py::hifi_smoke` eklendi:
üretim imajı, T4 ve Volume ile tam vokal yolunu koşturuyor (Volume'a
YAZMIYOR), deneydeki `[C-fp32]` vokaliyle SNR ve ölçek karşılaştırması yapıyor,
vendored `attend.py` yamasının gerçekten çalıştığını çağrı sayarak kanıtlıyor
ve canlı yolun `mel_band_roformer`/`utils.model_utils` import ETMEDİĞİNİ
doğruluyor. Yerelde torch olmadığı için bu yolu başka hiçbir test
çalıştırmıyor - Hi-Fi tarafına dokunan her değişiklikten sonra bu koşulmalı.

Açık iş kalmadı. İleride denenecekler yukarıdaki "İLERİDE denenecek"
başlığında (davulu/piyanoyu da B'den almak, enstrümanlar için ensemble).

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
- DELETE /songs/{id} ve POST /songs/delete (govde {"ids": [...]}) -
  tekli ve coklu silme. Kimlik deseni siki (64 hex + istege bagli kisa
  deney eki); nokta ve egik cizgi kabul edilmiyor, boylece silme sarki
  klasoru disina - ozellikle model agirliklarina - cikamiyor.
  Islenmekte olan sarki 409 doner, olmayan kimlik hata degil.
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
- [x] **Bellek önlemleri.** (2026-09-29: ÖLÇÜMLE GEREKSİZ ÇIKTI, aşağıya bak.)
      Mobilde `AudioContext` `sampleRate: 32000`,
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
      önbelleğe alınacak (şarkı id'siyle), 300 MB sınır (2026-09-29: 2 GB),
      en eski kullanılan
      silinecek (LRU). `navigator.storage.persist()` istenecek. Ayarlara
      "çevrimdışı kopyaları sil" düğmesi. İkinci açılışta stem için ağ
      isteği OLMAMALI.

### Aşama 5 notu – bellek önlemi ÖLÇÜMLE ÇÜRÜDÜ (2026-09-29)
"32 kHz mono" kararı ölçüme değil tek bir HESABA dayanıyordu: "6 stem x 4 dk x
44,1 kHz x 2 kanal x 4 bayt = 508 MB, telefon için fazla". Telefonda hiç
denenmemişti - PLAN bu kuralı kod yazılmadan önce koymuştu.

Ölçüm (S24 FE, 8 GB, Chrome): **9.1 dakikalık şarkı Yüksek kipte (48 kHz
stereo, ~1.25 GB PCM) sorunsuz çaldı** - çökme, takılma, kesilme yok. Hiza
testi tamamen geçti (metronom 0.0 / +0.1 ms, esnetici 119.9-120.0 ms).
Kulakla kalite belirgin şekilde daha iyi, stereo doğrulandı.

Bu yüzden **varsayılan artık Yüksek**; 32 kHz mono ayarlarda yedek seçenek
olarak duruyor (başka bir cihaz aynı payı vermeyebilir).

**Süre eşiği YOK.** Uzun şarkıda kaliteyi düşüren bir kural zaten hiç
olmamıştı: `longSongThresholdSec()` yalnızca bir UYARI METNİ eşiği ve
`deviceMemory >= 8` iken `Infinity` dönüyor, yani bu telefonda hiç çıkmıyor.
4 GB'lık bir cihazda 8 dakikada uyarı verir ama açmaya yine izin verir.

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
