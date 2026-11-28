# Stem Mikser: çalışma günlüğü (gözetimsiz oturum, 2026-11-14)

Önce bu dosyayı oku. En yeni kayıt "Kayıtlar" bölümünün en üstünde.

## Senin kararın gereken

- **Mikserden geri dönünce çalma sürsün mü?** Yeni görünümde şarkı çalarken geri tuşuna basarsan müzik KİTAPLIKTA çalmaya devam
  ediyor ve küçük oynatıcıdan durdurulup mikser yeniden açılabiliyor (müzik uygulaması gibi). Eskiden geri = duraklat idi (PLAN.md,
  "mini oynatıcı yok - bilinçli"). Karar: yeni görünümde sürsün; çalma listesinde ve mikrofon/antrenör açıkken eskisi gibi DURUYOR
  (sıradaki şarkıya geçiş seni kitaplık gezerken mikser ekranına çekmesin; mikrofon arka planda açık kalmasın). Eski davranışı
  istersen Ayarlar > Görünüm'den klasiğe geç ya da söyle, tek satırla yeni görünümde de durdurturum.

- **Kapak önceliği:** İstediğin sıra "gömülü kapak → senin seçtiğin resim → otomatik" idi. Belirsiz kaldı: senin açıkça seçtiğin resmin (ya da
  onayladığın "Kapak bul" sonucunun) gömülüyü EZMESİ daha mantıklı olduğu için öyle yaptım. Ters olsun istersen söyle.
- **Modal deploy ve üst sunucu sorunu (önemli):** `app.py`'nin SATIR SAYISI Modal imaj önbelleğine giriyor (kaynak tarama sayısı). Satır eklenince GPU imajındaki
  `beat_this` ağırlık indirmesi yeniden koşuyor ve o dosyanın sunucusu (`cloud.cp.jku.at`) bugün HTTP 500 veriyor, yani deploy iki kez başarısız oldu
  (hiçbir şey bozulmadı, eski sürüm çalışıyor). Çözüm: kapak kodunu ayrı dosyaya (`backend/coverart.py`) koydum, `app.py` satır sayısı AYNI kaldı; deploy
  6 saniyede imaj kurmadan geçti. Sonraki oturumlarda `app.py`'ye satır eklemek gerekirse bu sorun tekrar çıkar; testte uyarı var
  (`test_cover_api.py`). O sunucu hâlâ 500 veriyorsa `beat_this` ağırlığının başka yerden alınması kararı sana kalıyor.
- **"Kapak bul" ve User-Agent:** Tarayıcı kodundan User-Agent değiştirilemez; MusicBrainz'e tarayıcının kendi başlığı gider. Kişisel bilgi, e-posta, depo adresi
  HİÇ gönderilmiyor (yalnız senin "Ara"ya bastığında şarkı adı/sanatçı). Saniyede en çok 1 istek.
- **Takeout içinde şarkı adı yoksa:** Google'ın "beğenilen videolar" CSV'si genelde yalnız video kimliği veriyor (ad yok). Bunlar "Başlıksız bağlantı" olarak eklenir
  (bağlantıyı açabilirsin, otomatik eşleşme olmaz). Adı olan "müzik kitaplığı şarkıları" CSV'si normal eklenir.
- **Test şarkısı:** Hız ölçümü için kitaplığına "Hiz testi - yapay ses" adlı yapay bir şarkı eklendi (telifsiz ton/davul). İstemezsen
  kendin silebilirsin; ben silmedim (sunucudaki şarkıları silmeme kuralı).
- **Klipler telefonda saklansın mı?** Yüklediğin klip (videonun kendisi) varsayılan olarak sahne modu için telefonda saklanıyor; klip başına
  onlarca MB tutabilir. İstemezsen Ayarlar > Sahne klipleri'nden kapat; saklananları oradan silebilirsin (şarkılar ve sesleri silinmez).

## Cep (sonra yapılacak fikirler, henüz yapılmadı)

- (şu an boş)

## Genel özet

- **Yapıldı:** Aşama 1 (yeni görünüm, sekme çubuğu, küçük oynatıcı), Aşama 2 (kapaklar; sunucu ucu canlıda), Aşama 3 (Eklenecekler: paylaş menüsü
  metin/bağlantı, Takeout zip/CSV, otomatik "eklendi"), Aşama 4'ten: mikrofon kapanınca çıkış rotası, listede sıradakini önceden indirme, sözlü -> sözsüz
  geçiş için koruma, mikserde dar ekran düzeni, ilk kurulumda Ayarlar'dan çıkış hatası.
- **Son sürüm:** SW v97 (yükleme sırası saklanır + ekran açık; v96 çoklu şarkı ekleme; v95 sahnede okunuş + çeviri; v94 söz arka planı şarkı başına; v93 açılış ekranı; v92 kod sadeleştirme; v91 karaoke; v90 Sözleri bul; v89 Rusça + okunuş, yatay ekran).
  sunucuyla yapıldı; **telefonda hiçbir şey denenmedi.**
- **Sunucu:** yalnız bir salt okunur CPU ucu eklendi (kapak). GPU işi eklenmedi, mevcut şarkılara iş başlatılmadı, Volume'da hiçbir şey silinmedi/taşınmadı.
  Modal harcaması: iki başarısız imaj kurma denemesi (kısa CPU) + birkaç salt okunur istek; 2 $ sınırının çok altında (kesin rakam Modal panelinde).
- **Yapılmadı (Aşama 4'ten kalan):** bellek ve yavaş açılış ölçümü (telefon gerekir), kod sadeleştirme. Antrenörün otomatik gecikmesine baktım:
  v63'te zaten güven ölçütü, makul aralık, sıçrama direnci ve ortanca eklenmiş, 62 testle korunuyor; telefondan yeni ölçüm olmadan değiştirmedim. Sözlü -> sözsüz geçiş hatasını
  sahte sunucuda YENİDEN ÜRETEMEDİM (doğru çalışıyor); yalnız olası bir yarış durumunu kapattım, telefonda senin doğrulaman gerekiyor.

## Kayıtlar (en yeni üstte)

### Yükleme sırası sağlamlaştırıldı: ekran açık kalır, yarım kalan sıra sürer; "холод по спине"de satır atlamanın nedeni bulundu

- **Ekran açık:** şarkılar yüklenirken ayrı bir ekran kilidi tutulur (çalmanınkine dokunmaz), sıra bitince bırakılır.
- **Yarım kalan sıra:** seçilen dosyalar önce telefona yazılır (yeni `js/uploadqueue.js`, IndexedDB `stem-mikser-uploads`). Yüklenen ya da
  kalıcı hata veren (çok büyük, ses değil, iptal) sıradan çıkar; internet/sunucu hatasında sıra durur ve kalanlar saklı kalır. Uygulama
  açılınca (2,5 sn sonra) ve internet gelince kaldığı yerden sürer ("Yarım kalan N şarkı yükleniyor…"). 24 saatten eski sıra kendiliğinden
  silinir (unutulmuş sıra GPU açmasın). IndexedDB yoksa eskisi gibi yalnız bellekte.
- **Denendi (tarayıcı, sahte sunucu):** 3 dosya -> yüklendi, sıra boş; sunucu kapalıyken 2 dosya -> "0/2 yüklendi, 2 sırada bekliyor",
  ikisi saklı; sunucu açılıp sayfa yenilenince ikisi kendiliğinden yüklendi, sıra boş. **Test:** yeni `uploadqueue_test.mjs`; 89 dosya yeşil.
  **SW:** v97. **Telefonda denenmedi.**
- **Satır atlama (холод по спине):** sözlerde nakarat ("Ночь так темна ...") art arda iki kez yazılı (30-33, 34-37); hizalayıcı seste tek
  kopyayı ikinciye bağladı, birinci kopya 1,5 sn'lik boşluğa sıkıştı (satır başı 0,24 sn) -> ekran 2:30'da dört satırı bir anda geçiyor.
  Sunucu raporunda 171-212 sn arası "metinde karşılığı olmayan ses" var: ikinci tekrar büyük ihtimalle orada. Diğer 9 şarkıda böyle sıkışma
  yok (taranarak). Düzeltme (tekrar eden kıtada sıkışan kopyayı öbürüyle değiştirme) sunucudaki hizalama kodunda; GPU denemesi gerektiği için
  kullanıcı onayı bekleniyor. Hemen çözüm: "Zamanı düzelt" ile o dört satıra çalarken dokunmak (CPU, ücretsiz).

### Birden çok şarkıyı aynı anda ekleme (Şarkı ekle + paylaş menüsü)

- **İstek:** (4) birden çok şarkıyı birden ekleyebilmek. Ayrıca "telefondaki şarkılar geceleri 04-11 arası kendiliğinden yüklensin" istendi:
  PWA telefonun dosyalarını kendiliğinden okuyamaz ve belli saatte arka planda çalışamaz (Android/Chrome izin vermiyor); bunun yerine
  yatmadan şarkıları seçip bırakmak aynı sonucu verir (yüklemeler bitince ayırma sunucuda sürer, sabaha hazır). Kullanıcıya anlatıldı.
- **Ne:** "Şarkı ekle" artık çoklu seçim. Seçilenler SIRAYLA yüklenir ("(2/5) ad yükleniyor %40"); sonda durum satırında özet
  ("5 şarkı yüklendi; sunucuda sırayla ayrılıyor... uygulamayı kapatsan da devam eder"). Paylaş menüsünden birden çok dosya: sw.js en
  çok 20 dosyayı saklar (ilki `share-pending/current`, diğerleri `extra-N`), kartta "X ve N şarkı daha · N dosya", düğme "N şarkıyı
  yükle ve ayır"; ses/klip olmayan ya da çok büyük dosyalar notta "atlandı". Kartın kalite seçimi hepsine uygulanır.
- **Sunucu:** değişiklik yok. Ayırma zaten kuyruklu (separate max_containers=1): aynı anda gelen şarkılar "sırada" bekleyip tek tek
  ayrılır; şarkı başı maliyet aynı (GPU ~4 dk).
- **Yakalanan eski hata (sadeleştirmeden):** taşıma aracı paylaş modülünde bir yazının içindeki adı da değiştirmişti
  (`el("settings-message")` -> `el("settings()-message")`; ayarlar boşken paylaşım mesajı görünmüyordu). Düzeltildi; `ui_modules_test`
  artık yazı içine getter çağrısı karışmasını yakalıyor (denendi).
- **Test sunucusu:** `mock_server.py` yükleme gövdesini okumadan cevap veriyordu (tarayıcıda bağlantı sıfırlanıyordu); artık okuyor.
- **Denendi (tarayıcı, sahte sunucu):** 3 dosya çoklu seçim -> (1/3), (2/3), (3/3) sırayla, özet satırı; paylaş kartı 3 dosya -> kart
  görünümü, hepsi yüklendi, kart kapandı, paylaşım kaydı temizlendi. **Testler:** share_test, sw_share_test (3 dosya, 23 dosyada 20 sınırı,
  temizleme) güncellendi; 88 dosya yeşil. **SW:** v96. **Telefonda denenmedi.**
- **Telefonda kontrol:** 1) "SW v96". 2) Kitaplık > Şarkı ekle > birden çok şarkı seç: sırayla yüklenmeli. 3) Dosya yöneticisinden 3 şarkı
  seçip Paylaş > Stem Mikser: kartta "ve 2 şarkı daha", "3 şarkıyı yükle ve ayır". 4) Uygulamayı kapat, sonra aç: şarkılar "sırada/
  ayrıştırılıyor" ilerlemeli.

### Sahne modunda okunuş ve çeviri

- **İstek (kullanıcı ekran görüntüsü, klipli sahne):** söz satırının altına okunuş ve çeviri de gelsin.
- **Ne:** Sahnede söz satırının altında iki satır: okunuş (italik) ve Türkçe çeviri. Kaynak söz paneliyle aynı (`TR.subsList`):
  Rusçada okunuş telefonda üretilir, İngilizce/Japoncada sunucudan gelir; çeviri yapılmamışsa yalnız okunuş görünür. Söz panelindeki
  "Okunuş" / "Çeviri" düğmelerine uyar. Satır değişince ve çeviri gelince yenilenir (her karede değil). Tam klip görünümünde küçülür.
- **Denendi (tarayıcı, 300-390 px genişlik, klipli tam ekran sahne, Rusça sözler + çeviri):** "Привет, мой друг" altında
  "Privet, moy drug" ve çeviri; söz satırı ile alt çubuk arasına sığıyor, üst üste binme yok. **Test:** `stage_test.mjs` +6 kontrol;
  88 dosya yeşil. **SW:** v95. **Telefonda denenmedi.**
- **Telefonda kontrol:** 1) "SW v95". 2) Rusça şarkıda Sözler > Çevir (bir kez). 3) Sahne'yi aç, çal: satırın altında okunuş ve çeviri.
  4) Sözlerde "Okunuş"u kapat: sahnede de kaybolmalı.

### Tam ekran söz arka planı artık ŞARKI BAŞINA (bir şarkıya koyulan resim diğerlerini değiştirmiyor)

- **Belirti (kullanıcı):** iki Rusça şarkıya farklı resim koydu, ikisi de aynı resmi gösteriyordu.
- **Neden:** tam ekran sözlerin "kendi resmim / videom" arka planı tasarım gereği TEK kayıttı (tüm şarkılar için tek ayar); her seçim
  öncekini eziyordu. Kapak resimleri zaten şarkı başına (onlarda sorun yok).
- **Ne:** `js/bgstore.js` şarkı başına saklar (`song:<id>`). Açık şarkıda seçilen dosya YALNIZ o şarkıya. Kendi dosyası olmayan şarkı
  varsayılanı kullanır: varsayılan = eski tek kayıt (şimdiye kadar koyulan son resim kaybolmadı). Ayarlar'da şarkı açık değilken seçilen
  dosya varsayılan olur. "Kaldır": önce şarkının kendi dosyası (şarkı varsayılana döner), kendi dosyası yoksa varsayılan. Notta hangisi
  olduğu yazar ("Bu şarkının: ..." / "Tüm şarkılar ..."). Silinen şarkıların dosyası da silinir.
- **Denendi (tarayıcı, gerçek IndexedDB):** şarkı A'ya kırmızı, B'ye mavi resim; B'den sonra A'ya dönünce A hâlâ kırmızı, B mavi;
  konsolda hata yok. **Test:** yeni `bgstore_test.mjs` (sahte IndexedDB: ezmeme, varsayılana düşme, Kaldır sırası, silme, IndexedDB yok).
  88 dosya yeşil. **SW:** v94. **Telefonda denenmedi.**
- **Not:** iki Rusça şarkının şu anki ortak resmi "varsayılan" olarak kaldı; her birine resmini YENİDEN seçince artık ayrı kalır.
- **Telefonda kontrol:** 1) "SW v94". 2) Rusça şarkı 1: tam ekran sözler > ayar > Dosya seç > resim A. 3) Rusça şarkı 2: resim B.
  4) Şarkı 1'e dön: resim A görünmeli.

### Açılış ekranı: logo, uygulama adı ve "Geliştiren: Berkay Özdemir"

- **Ne:** Uygulama açılırken ~2,4 sn'lik şık bir açılış ekranı: mikser sürgülerini andıran beş renkli düğme sırayla yerine kayar, ardından
  "Stem Mikser", alt yazı ("Şarkıyı kanallarına ayır, istediğin gibi çal") ve altta ince çizgiyle "GELİŞTİREN" + renk geçişli
  **Berkay Özdemir**. Arkada vurgu renklerinden yumuşak ışık. Temaya uyar (koyu / sahne siyahı / aydınlık; klasik görünümde de çalışır).
- **Davranış:** yalnız sayfa ilk yüklenirken; dokununca hemen geçer; paylaş menüsünden gelinince gösterilmez (onay kartı beklemesin).
  Ayarlar > Görünüm > "Açılış ekranı" ile kapatılabilir (`stem-mikser.splash`, varsayılan açık; sonraki açılışta geçerli).
- **Sağlamlık:** zamanlama tamamen CSS'te; ana betik geç yüklense ya da yüklenemese de ekran kendiliğinden kalkar. Mantık `look.js`'te
  (sayfa boyanmadan önce çalışan küçük betik): kapalıysa hiç boyanmaz. Yalnız transform/opacity animasyonu; azaltılmış harekette sade.
- **Denendi (tarayıcı, 375x812):** koyu ve aydınlık temada görüntü, 3,2 sn sonra kalkıyor, dokununca 0,45 sn içinde gidiyor, Ayarlar'dan
  kapatınca görünmüyor. **Test:** yeni `splash_test.mjs`; 87 dosya yeşil. **SW:** v93. **Telefonda denenmedi.**
- **Not:** ad "Berkay Özdemir" olarak yazıldı (kullanıcının mesajındaki yazım hatası yorumlandı); farklıysa `index.html` #splash.
- **Telefonda kontrol:** 1) Uygulamayı kapatıp aç: açılış ekranı gelip ~2 sn'de kaybolmalı. 2) Dokununca hemen geçmeli.
  3) Ayarlar > Görünüm'den kapatıp uygulamayı yeniden aç: gelmemeli. 4) Tekrar aç.

### Nothing Else Matters'ta sözler satır atlıyordu: yeni yöntemle yeniden hizalandı (kullanıcı onayıyla)

- **Belirti (kullanıcı videosu, tam ekran sözler):** şarkı bir satırdan sonra aradaki satırları atlayıp aşağıdaki bir satırdan devam ediyordu.
- **Neden:** şarkının yapıştırılmış sözleri Ekim'de ESKİ (global) hizalamayla üretilmişti; 13-18. satırlar 143,2-143,4 sn'ye, 23-26 ve 31-32
  de tek ana yığılmıştı (sıfır süreli 12 satır). Ekran sıfır süreli satırları bir anda geçiyordu. PLAN.md'de (YAPIŞTIR-HİZALA v2) "NEM eski
  yolla üretildi, yeniden hizalanmalı (kullanıcı onayıyla)" notu vardı; adım yapılmamıştı. Kod hatası yok.
- **Tarama:** sözü olan 9 şarkının hepsi okundu (salt okuma): yığılma yalnız bu şarkıda.
- **Düzeltme:** aynı metinle `POST /songs/{id}/lyrics` (mode pasted, en). Yeni yol "anchored": eşleşme %94,6, satırlar 67-380 sn'ye
  yayıldı (şarkı 432 sn), sıfır süreli/yığılan/geri giden satır 0, düşük güven 0. 25,5 sn, ~0,0042 $ GPU. Metin değişmedi.
- **Telefonda:** şarkıyı internet varken aç (yeni söz sürümü iner); satırlar sırayla akmalı, 2:23 civarında atlama olmamalı.

### Kod sadeleştirme: app.js 9.664 -> 7.468 satır (14 bölüm ayrı dosyaya), davranış aynı

- **Yedek:** git etiketi `yedek-sadelestirme-oncesi-20261126` (push edildi) + `C:\Users\user\stem-mikser-yedek-sadelestirme-20261126.zip`.
- **Ölçüm:** kullanılmayan kod neredeyse yok (yalnız 3 gereksiz içe aktarım). Asıl sorun tek dev dosya: 45 bölüm, çoğu ortak değişkenlerle
  birbirine bağlı. Her bölümün bağımlılığı ölçüldü; ana dosyadaki ortak bir değişkeni DEĞİŞTİREN bölümler taşınmadı (riskli).
- **Taşınanlar (`frontend/js/ui/`):** klip önizlemesi, uyku zamanlayıcısı, etiket sayfası, hiza testi, miks dışa aktarma, şarkı söyleme
  antrenörü + çizimi, paylaş menüsü, PWA, çevrimdışı, açılış bilgi önbelleği, çalma listeleri ekranı, kapaklar, klipten ses ayıklama.
  Ortak `el`/`on` yardımcıları `js/dom.js`'e. Ana dosyadan kullanılmayan 89 içe aktarım silindi.
- **Yöntem:** bölümler elle değil bir araçla taşındı (satır kaybı denetimi: her bölümde "eksik satır yok"). Her bölüm `bind(...)` ile
  ana dosyadan ihtiyacını alır; değişen değerler (şarkı, ayarlar, döngü...) her kullanımda güncel okunur (getter). Başlatma sırası korundu
  (bind bölümün eski yerinde çağrılır).
- **Yakalanan hatalar (hepsi yayından ÖNCE, tarayıcıda/testte):** (1) hiza testi açılmıyordu (sonradan yüklenen dosyanın göreli yolu),
  (2) açılışta "peaksCache before initialization" (henüz tanımlanmamış değer erken istendi), (3) Listeler sekmesi açılmıyordu (bir yerde
  güncel değer okunmuyordu). Üçü de düzeltildi ve her biri için kalıcı test kuralı eklendi.
- **Yeni testler:** `ui_modules_test.mjs` (her bölüm: bind bir kez çağrılır, verilmeyen ad yok, değişen değer getter, getter hep çağrılır,
  bind'e verilen değer önceden tanımlı, göreli yollar doğru, çevrimdışı kabukta; kuralların hatayı yakaladığı denendi);
  `appsource.mjs` (kaynak taraması yapan testler app.js + ui/*.js okur); `syntax_test` ui/ klasörünü de ayrıştırır. Mikrofon gizlilik
  testleri antrenörün yeni dosyalarını tarar (denetim aynı sıkılıkta).
- **Taşınmayanlar (bilerek):** şarkı sözleri, döngü, hız/ton, mikser hafızası, Eklenecekler, çalma sırası, dalga şeritleri, tam ekran sözler
  vb.: ortak durumu değiştiriyorlar; ayırmak için durumun sahipliğini yeniden düzenlemek gerekir (ayrı, daha riskli iş).
- **Denendi (tarayıcı, 375x812, sahte sunucu):** açılış, kitaplık + kapaklar + klip önizlemesi, şarkı açma/çalma, uyku zamanlayıcısı
  (geri sayım), dışa aktarma paneli, etiket ekleme, liste oluşturma, Listeler sekmesi, Ayarlar'da SW/önbellek bilgisi, hiza testi
  başlıyor, antrenör paneli; konsolda hata yok. **Testler:** 86 dosya yeşil. **SW:** v92. **Telefonda denenmedi.** Commit a7b384f.
- **Telefonda kontrol:** 1) Ayarlar'da "SW v92". 2) Bir şarkı aç, çal, uyku zamanlayıcısını kur ve iptal et. 3) Listeler sekmesi ve
  etiketler açılmalı. 4) Dışa aktar panelini aç-kapat. Sorun olursa yedek etikete dönülebilir.

### Otomatik söz çıkarma güçlendirildi: daha geniş arama (ölçüme dayalı)

- **Onay:** GPU denemesi için kullanıcı "4 olsun" dedi (tahmin ~0,05 $ söylenmişti). **Harcanan: 0,049 $** (0,035 + 0,014), tek konteyner.
- **Deney:** yeni `backend/lyrics_tune.py` (ayrı Modal uygulaması; canlıdaki `_lyr_*` kodunun aynısını AST ile alıp çalıştırır, canlı imajla aynı
  tanım, Volume yalnız okundu, hiçbir şarkıya iş başlatılmadı/yazılmadı). 4 şarkı, referans sözlerle kelime hata oranı (WER, düşük iyi):

  | Şarkı | Canlı ayar | Ad ipucu | Geniş arama | İpucu + geniş |
  |---|---|---|---|---|
  | Zeus (tr) | 0,328 | 0,328 | 0,328 | 0,232 |
  | Madem (tr) | 0,275 | 0,275 | 0,270 | 0,311 |
  | ADDICT (en) | 0,379 | 0,335 | 0,332 | 0,332 |
  | холод по спине (ru) | 0,336 | 0,314 | 0,200 | 0,200 |
  | **Ortalama** | **0,330** | 0,313 | **0,283** | 0,269 |

  Referanslar: Zeus eski referans, Madem/ADDICT LRCLIB, Rusça kullanıcının yapıştırdığı metin (hepsi `backend/lyrics_ref/`, gitignore'lı).
  Rusça dil algılama 4/4 doğru (ru dahil).
- **Karar:** yalnız **geniş arama** (`beam_size=10, patience=2`, `LYRICS_SEARCH`): hiçbir şarkıda kötüleşmedi, ortalama %14 daha az hata.
  Ad ipucu (initial_prompt) ALINMADI: bir şarkıda (Madem) bozdu ve başlığın söze sızma riski var.
- **Bedel:** otomatik çıkarma ~%30 daha uzun (şarkı başı birkaç saniye; maliyet şarkı başı ~0,003 $ -> ~0,004 $).
- **Değişmeyen:** yapıştır-hizala (çapa kelimeleri eski ayarda; hizalama böyle ölçülmüştü). Mevcut sözler değişmez; yeni ayar yalnız
  bundan sonra "Sözleri çıkar"a basılınca kullanılır.
- **Sınır:** 4 şarkıyla ölçüldü; ses kaydına göre kazanç değişir. "Kusursuz" için hâlâ en iyi yol **Sözleri bul** (doğru metin + hizalama).
- **Sunucu:** `app.py` satır sayısı 9296 (yorum satırı birleştirildi), deploy edildi. **Test:** `test_lyrics_gate.py` (auto'da arama var,
  çapada yok); 85 dosya yeşil. Arayüz değişmedi (SW v91 aynı).
- **Telefonda kontrol:** sözü olmayan (ya da yeniden çıkarmak istediğin) bir şarkıda "Sözleri çıkar": birkaç saniye daha uzun sürebilir,
  sözler öncekinden daha az hatalı gelmeli.


### Karaoke kelime vurgusu (oynatıcı ve tam ekran sözler) + Ayarlar'da aç/kapa

- **Ne:** Çalan satırda o an söylenen kelime vurgu renginde parlar, söylenmiş kelimeler tam parlak, sıradakiler sönük. Oynatıcıdaki söz
  listesinde ve tam ekran sözlerde (Sahne modunda zaten vardı). Kelime zamanları sözlerle birlikte zaten geliyordu (`w`), yeni sunucu işi yok.
- **Ayar:** Ayarlar > **Sözler** > "Kelime kelime parlasın (karaoke)"; varsayılan AÇIK, `stem-mikser.wordglow`. Kapatınca satır eskisi gibi bütün parlar.
- **Ne zaman çalışmaz:** kelime zamanı olmayan ya da sonradan metni elle değiştirilmiş satır (kelimeler metinle uyuşmazsa) düz kalır;
  akorlu söz sayfası açıkken kapalı (satırlar akorla çiziliyor).
- **Yük:** yalnız çalan satır kelimelere bölünür; kare başına yalnız kelime değişince sınıf yazılır (yerleşim değişmez, yalnız renk/opaklık).
- **Kod:** yeni `js/karaoke.js` (`WordGlow`, `sungIndex`), `lyricsscreen.js` (`wordGlow`, `setWordGlow`), app.js. Test: `karaoke_test.mjs`.
- **Denendi (tarayıcı, 375x812, sahte sunucu):** çalarken kelimeler sırayla "now -> done" oldu (listede ve tam ekranda), ayar kapatınca
  ikisi de düz metne döndü, açınca geri geldi. **Testler:** 85 dosya yeşil. **SW:** v91. **Telefonda denenmedi.**
- **Telefonda kontrol:** 1) Ayarlar'da "SW v91". 2) Sözü olan şarkıyı çal: çalan satırda kelimeler sırayla parlamalı. 3) Tam ekran sözlerde de.
  4) Ayarlar > Sözler'den kapat: satır bütün parlamalı.


### "Sözleri bul": doğru söz metni açık söz veritabanından (LRCLIB), sonra sese hizalama

- **Neden:** Otomatik çıkarma (Whisper) sesi dinleyip tahmin eder; ölçümde kelimelerin ~%10-30'u yanlıştı. Doğru metin yapıştırılıp
  hizalanınca sonuç neredeyse birebir. Metni artık elle aramak gerekmiyor.
- **Ne:** Sözler panelinde **Sözleri bul** düğmesi. Basınca düzenleme kutusu açılır, üstünde şarkı adı ve sanatçı (başlıktan otomatik:
  "Official Video", "slowed + reverb", "nightcore", "lyrics", "Turkish", parantez notları, dosya uzantısı atılır) ve arama kendiliğinden
  başlar. En çok 6 sonuç: sanatçı - ad, albüm, süre, satır sayısı ve ilk iki satır. Birine dokununca sözler kutuya gelir ve dil kendiliğinden
  seçilir (tr/en/ja/ru; emin değilse Otomatik). Kontrol edip **Hizala** (ya da "Kaydet ve hizala"): her zamanki yapıştır ve hizala.
  Hiçbir şey kendiliğinden gönderilmez. Bulunamazsa adı/sanatçıyı değiştirip yeniden Ara; olmazsa "Sözleri çıkar" duruyor.
- **Sıralama:** ad benzerliği > sanatçı > süre yakınlığı (slowed/nightcore'da süre farklı olabildiği için zayıf) > zamanlı sözler.
  Enstrümantal ve sözü boş kayıtlar ile aynı metnin kopyaları atılır. Arama sırası: ad+sanatçı, serbest metin, yalnız ad.
- **Gizlilik ve masraf:** LRCLIB'e yalnız sen bastığında, yalnız ad ve sanatçı gider (çerez/referrer yok). Ücretsiz, anahtarsız.
  Hizalama her zamanki gibi şarkı başı ~0,003 $ GPU. Sunucu kodu DEĞİŞMEDİ (deploy yok). Sözler telifli: yalnız telefonda ve Volume'da,
  depoya girmez; testler uydurma metin kullanır.
- **Sınır:** Her şarkı veritabanında yok (popülerlerde iyi; Türkçe uyarlama/cover gibi kayıtlarda yanlış şarkı da çıkabilir, sanatçıya bakıp
  seç). Bulunan metnin doğruluğu veritabanına bağlı.
- **Denendi (tarayıcı, 375x812, gerçek LRCLIB):** "HAZBIN HOTEL - Bağımlı (Addict) - Turkish" -> ad "Bağımlı", sanatçı "HAZBIN HOTEL" ayrıştı;
  "Addict" + "Hazbin Hotel" araması 1 sonuç, seçince 54 satır kutuya geldi, dil English, "Kaydet ve hizala" etkin; yana taşma yok.
- **Ders:** Bu işte app.js'te iki hata çıktı (aynı ad iki kez tanımlıydı; bir dize satır sonuyla bölünmüştü) ve uygulama BOŞ açıldı; mevcut
  testler app.js'i yüklemediği için yakalamadı. Yeni `tests/syntax_test.mjs` bütün modülleri ayrıştırıyor (iki hatayı da yakaladığı denendi).
- **Testler:** 84 dosyanın hepsi yeşil (yeni `lyricsfind_test.mjs`, `syntax_test.mjs`). **SW:** v90. **Telefonda denenmedi.**
- **Telefonda kontrol (4 adım):**
  1. Ayarlar'da "Sürüm: SW v90" yazmalı.
  2. Bir şarkıda Sözler > **Sözleri bul**: ad ve sanatçı dolu gelmeli, sonuçlar listelenmeli.
  3. Doğru sonuca dokun: sözler kutuya gelmeli, dil seçili olmalı; "Hizala"ya bas.
  4. Hizalama bitince satırlar sesle birlikte akmalı. Bulunamazsa adı değiştirip "Ara".


### Rusça sözler ve okunuşu; yatay ekran düzeni (klip solda, mikser sağda)

- **Yedek:** git etiketi `yedek-rusca-yatay-oncesi-20261126` (v88).
- **Rusça sözler:** Sözler ekranındaki dil seçicide artık **Русский** var; "Otomatik" de Rusçayı tanıyor (Whisper large-v3 Rusçayı destekliyor;
  sunucudaki dil listesine "ru" eklendi). Yapıştır ve hizala da Rusça metinle çalışır.
- **Çeviri:** Rusça sözlerde **Çevir** düğmesi çıkar: Gemini Rusçadan Türkçeye satır satır çevirir (İngilizce ve Japoncadaki gibi).
- **Okunuş:** Her Rusça satırın altında Türkçe harflerle okunuşu çıkar (örnek: "Привет, мой друг" -> "Privet, moy drug"). Telefonda
  kural tabanlı hesaplanır (yeni `js/rureading.js`): **ücretsiz, anında, internetsiz** ve çeviri yapılmadan da görünür. "Okunuş" düğmesiyle aç/kapa.
  Sık söyleyiş kuralları var: что -> şto, -ого/-его -> -ovo/-evo (ничего -> niçevo), -тся/-ться -> -tsa, ж/ш/ц'den sonra и -> ı.
  **Sınır:** Rusçada vurgu yazıda görünmez, vurgusuz "o"nun "a" gibi okunması yapılmaz (хорошо -> "horoşo"; gerçekte "haraşo").
- **Sunucu:** `backend/app.py` yalnız 4 satırda yerinde değişti (satır sayısı 9296, imaj yeniden kurulmadı, deploy 6,6 sn). GPU işi
  başlatılmadı, Volume'a dokunulmadı. Rusça sözü telefondan sen istediğinde her zamanki söz çıkarma kadar GPU harcar.
- **Yatay ekran (Cep'ten):** Klibi olan şarkıda telefonu yan çevirince **klip solda, altında sözler; sağda kanallar, ön ayarlar ve alt çubuk**,
  hepsi aynı anda. Klip | Mikser anahtarı yatayda gizlenir (seçimin değişmez; dik çevirince eski hâline döner). Yer kalmadığı için yatayda
  **akor şeridi, döngü çubuğu ve Sahne/yöntem satırı gizli**; döngüyü soldaki sözlerde satıra uzun basarak kurabilirsin. Antrenör açıkken
  yatay düzen devre dışı (eski düzen).
- **Ölçüm (tarayıcı, sahte sunucu, 892x400 yatay):** klip 446x216, sözler 160 px yükseklik (kendi içinde kayar), sağda üst çubuk 54,
  ön ayarlar 46, kanallar 181 (~3 kanal, kayar), alt çubuk 119; ekrandan taşma ve yana kayma yok (yeni ve klasik görünüm). 375x812 dikeyde
  yerleşim eskisiyle aynı.
- **Testler:** 82 dosyanın hepsi yeşil (yeni `rureading_test.mjs`; `clipframe_test`, `lyrics_test`, `translation_test`,
  `trainer_layout_test`, `test_lyrics_gate.py` güncellendi). **SW:** v89. **Telefonda denenmedi.**
- **Telefonda kontrol (4 adım):**
  1. Ayarlar'da "Sürüm: SW v89" yazmalı (gerekirse uygulamayı kapat-aç).
  2. Rusça bir şarkıda Sözler > dil "Русский" (ya da Otomatik) ile sözleri çıkar: satırların altında Türkçe harfli okunuş görünmeli.
  3. "Çevir"e bas: Türkçe çeviri gelmeli; "Okunuş" düğmesi okunuşu gizleyip göstermeli.
  4. Klibi olan şarkıyı açıp telefonu yan çevir: klip solda, kanallar sağda; çalınca video sesle birlikte oynamalı. Dik çevir: eski düzen.

### Teknik ve ayar denetimi

- **Nasıl:** (1) Ayarlar'daki 14 anlık ayarın hepsi değiştirilip sayfa yeniden açıldı: hepsi korundu. (2) Uygulama 375x812'de gezildi (mikser
  ön ayarları, Slowed/Nightcore aç-kapa, 8D kipleri, Yankı, Dalga, Dışa aktar, hız/ton, döngü, bilgi sayfası, Kapak bul, uyku, sahne + kilit,
  Klip/Mikser, Listeler, Eklenecekler, Ayarlar): konsolda hata yok. (3) Kod taraması: çift kimlik yok, olay bağlanıp sayfada olmayan öğe yok,
  önbellekler şarkı sayısıyla sınırlı (40).
- **Bulunan ve düzeltilenler:**
  - Klasik görünümde telefon genişliğinde oynatıcı yana taşıyordu (375 px ekranda sayfa 462 px; "Hi-Fi'a yükselt" ve "Başa sar" kesik).
    Dar ekranda düğme üst satıra taşınıyor, alt çubuk daralabiliyor: artık tam 375 px.
  - Tema ve "vurgu rengi kapaktan" klasik görünümde seçilebiliyordu ama hiçbir şey yapmıyordu (yalnız yeni görünümde çalışırlar).
    Klasikte pasif ve yanında açıklama var.
  - Ana ayar kaydı (API adresi, token, ses kalitesi, esnetici...) telefonun uygulama hafızası dolarsa hata verip yarıda kalıyordu, mesaj da
    çıkmıyordu. Artık çökmüyor: ayar o oturumda geçerli, Kaydet'te "kaydedilemedi" uyarısı çıkar.
- **Sorun olmayanlar (bilgi):** Sahne açıkken arka planda ekran değişirse sahnenin "Kapat"ı çalışmayabiliyor; ama buna yalnız programla
  basılarak düşülebiliyor (kilitli sahne dokunuşları ve geri tuşunu yutuyor), gerçek kullanımda olmuyor. Dokunulmadı.
- **Yeni test:** tests/audit_test.mjs (kota, klasik dar ekran, yalnız-yeni-görünüm ayarları, HTML/JS kimlik tutarlılığı).
- **SW:** v88. Telefonda denenmedi.

### Genel optimizasyon (ölçüme dayalı)

- **Yedek:** GitHub'da etiket `yedek-optimizasyon-oncesi-20261126` (SW v86, commit 9bdcfac) + bilgisayarda `C:\Users\user\stem-mikser-yedek-20261126.zip`.
  Geri dönmek gerekirse bu etikete dönülür.
- **Ölçülen sorun:** Oynatıcı ekranında her karede (120 Hz ekranda saniyede 120 kez) geçen/kalan süre yazıları değişmese de yeniden yazılıyordu:
  duraklatılmışken bile saniyede ~330 sayfa değişikliği. Akor şeridi her karede ekran genişliğini ölçüyordu. Geçiş ayarı her karede hafızadan okunuyordu.
- **Yapılan:** kare döngüsü yalnız değişeni yazar; duraklatılmışken ve hiçbir şey değişmiyorken kare işi atlanır (dokunuş, boyut değişimi, geri
  dönüş ve akor şeridi kurulunca bir kare yeniden değerlendirilir); akor şeridi genişliği yalnız boyut değişince ölçer, aynı konumu yazmaz;
  geçiş ayarı bellekte tutulur. Nadiren kullanılan klip ayıklayıcı, kapak karesi ve Takeout okuyucu açılışta değil ilk gerektiğinde yüklenir
  (~47 KB; çevrimdışı için önbellekte durmaya devam eder).
- **Sonuç (masaüstü tarayıcı, 375x812):** duraklatılmışken sayfa değişikliği 331/sn -> 0/sn, JS işi 18,7 -> 2,2 ms/sn (-%88);
  çalarken 342/sn -> 15/sn (-%96), JS işi 20,4 -> 8,6 ms/sn (-%58). Saat, sarma, sahne modu, klip yükleme ve Takeout içe aktarma denendi.
  Yeni test: tests/perf_test.mjs (akor şeridi gerçek sınıfla, döngü kaynak taramasıyla). Commit 86a9dd5.
- **Bilerek dokunulmayanlar:** kanal çözme (zaten ölçülerek 3 paralel), kitaplık yenilemesi (atlamak favori/etiket/çevrimdışı işaretlerini
  bayatlatabilirdi), kodu küçültme/paketleme (testler ve yayın düzeni ham dosyaya dayanıyor; risk/kazanç oranı düşük), sunucu.
- **SW:** v87. Telefonda denenmedi; pil ve ısınmadaki fark özellikle oynatıcı ekranı açıkken (duraklatılmış da olsa) hissedilmeli.

### 8D hafifletildi (uygulamadan çıkınca cızırtı)

- **Sorun:** "Uygulamadan çıkınca cızırtı artıyor." Arka planda Android işlemciyi kısıyor; ses ağırsa yetişemiyor.
- **Ölçüm (tarayıcıda, 20 sn ses, 6 kanal):** 8D kapalı 209 ms; eski 3D 1369 ms (6,5 kat). Ağırlık, 3D zincirindeki ayarların her ses örneğinde
  (saniyede 48 bin kez) yeniden hesaplanmasından ve 6 kanalın her birinde ayrı zincir olmasından.
- **Düzeltme:** (1) 8D ayarları 128 örnekte bir güncelleniyor (dönüş çok yavaş, fark duyulmuyor; tık testi 0). (2) Klasik 8D'de bütün kanallar
  aynı döndüğü için karışıma TEK zincir. Yeni yük: klasik 8D 285 ms (eskisinden ~5 kat hafif, 8D kapalıya göre yalnız 1,4 kat); kanal kanal
  623 ms (~2 kat hafif). Uygulamada doğrulandı: klasik kipte 1 zincir, ses ±0,85 dönüyor.
- **Bilinen:** arka planda en hafif kip klasik 8D'dir; hâlâ cızırtı olursa kanal kanal kipten klasiğe geç ya da Ayarlar'dan 3D'yi kapat.
  Telefonda denenmedi.
- **SW:** v86.
- **Telefonda kontrol (2 adım):**
  1. 8D açıkken uygulamadan çık (ana ekrana dön), birkaç dakika dinle: cızırtı olmamalı.
  2. Aynısını "8D kanal" ve 8D kapalıyken dene; fark varsa hangisinde olduğunu söyle.

### Nightcore, şarkılar arası yumuşak geçiş, kitaplıkta klip önizlemesi

- **Slowed + Reverb:** zaten vardı (mikserdeki ön ayar satırı). Artık açıkken düğme vurgulu; tekrar dokununca normale döner (hız, ton, karışım, oda).
- **Nightcore (yeni):** ön ayar satırında. Plak gibi hızlandırır (1,25x; hız ve ton birlikte yükselir). Tekrar dokununca normale döner.
  Karışıma dokunmaz. Elle tempo değiştirince ya da şarkı değişince "açık" göstergesi kalkar.
- **Yumuşak geçiş (Cep'ten):** Çalma listesinde / sırada sonraki şarkı varken şarkı son saniyelerde (varsayılan 5 sn) kısılarak biter, sonraki
  açılınca ~2,5 sn'de yükselir. Ayarlar > Şarkılar arası geçiş: Kapalı / 3 / 5 / 8 sn. İki şarkı aynı anda belleğe alınmıyor (6 kanal x 2 şarkı
  telefonda ~1 GB olurdu); arada sonraki şarkının açılması kadar kısa bir sessizlik var. Geri sararsan / döngü açarsan ses geri açılır.
  Ses motoruna ayrı bir geçiş düğümü eklendi (ana ses ve döngü dikişinden bağımsız). Tarayıcıda ölçüldü: sona 5 sn kala kısma başladı, şarkı
  bitince 0; sıradaki şarkıda 2,5 sn'de 1'e çıktı. Geçiş kodu hata verse bile çalma döngüsü ve çalmayı başlatma etkilenmez (yakalanır).
- **Kitaplıkta klip önizlemesi (Cep'ten):** Klibi saklı şarkının kapağında birkaç saniyelik sessiz döngü (klibin %35'inden). Yalnız ekrandaki
  satırlarda, aynı anda en çok 3; uygulama arka plandayken durur. Ayarlar > Şarkılar arası geçiş bölümünde aç/kapa.
- **Cep'te kalan:** yatay ekran düzeni.
- **SW:** v85.
- **Telefonda kontrol (4 adım):**
  1. Mikserde "Nightcore"a dokun: hızlı ve tiz çalmalı; tekrar dokun: normale dönmeli. "Slowed + reverb" de aynı.
  2. Bir listeyi çal, şarkının sonuna sar: son saniyelerde kısılıp sıradaki yavaşça açılmalı.
  3. Klibi olan bir şarkının kitaplık kapağında video oynamalı.
  4. Ayarlar'dan geçişi "Kapalı" yap: şarkılar eskisi gibi geçmeli.

### 8D ses

- **Ne:** Mikserde "8D" düğmesi. Dokundukça: kapalı -> bütün şarkı başının etrafında döner -> kanal kanal (vokal ortada sabit, bas ortaya yakın,
  davul/gitar/piyano/diğer farklı hız ve yönde) -> kapalı. Seçim bu telefonda saklanır, her şarkıda geçerli; sahne modunda da çalışır.
  Ayarlar > 8D ses: dönüş hızı (yavaş 12 sn / orta 8 sn / hızlı 4,5 sn tam tur). Kulaklıkla dinlenmeli.
- **Nasıl:** Her kanalın sağ-sol ayarına ses motorunun kendi yavaş osilatörü bağlanır; dönüş ses kartında, pürüzsüz, ekran kapalıyken de sürer,
  işlemciyi neredeyse hiç yormaz. Kendi pan ayarın taban olarak kalır. Sunucuya dokunulmadı.
- **Denendi (tarayıcıda ölçüm):** klasik kipte ses sağ +0,85 ile sol -0,85 arasında 8 sn'lik düzgün dalga; kanal kanalda vokal ortada, bas ±0,2,
  diğerleri farklı evrede; kapatınca dönüşler kalkıyor. Telefonda ve kulaklıkla denenmedi.
- **Sınırlar:** Dışa aktarılan dosyaya 8D girmez.
- **SW:** v82.
- **Ek (v83): gerçek 3D.** Kullanıcının telefonu (Galaxy S24 FE) güçlü olduğu için Ayarlar > 8D ses > "Gerçek 3D" eklendi (varsayılan açık).
  Her kanal kulak modeliyle (HRTF) başın etrafında bir çember üzerinde gezer: önünden, sağından, arkandan, solundan. Dar kanallar (bas) önde
  küçük elips çizer. Tarayıcı desteklemezse kendiliğinden sağ-sol dönüşe düşer. Ölçüm: 6 kanala HRTF bağlandı, ses 8 sn'lik turla dönüyor;
  sağ-sol farkı 2D'ye göre daha doğal/yumuşak (yön tını ipuçlarıyla verilir). Daha belirgin sağ-sol isteyen 3D'yi kapatabilir. Telefonda denenmedi.
- **Düzeltme (v84): 3D'de cızırtı.** Kullanıcı "güzel ama cızırtı oluyor" dedi. Ölçüldü: tarayıcının HRTF 3D düğümü HAREKETLİ seste tık/sıçrama
  üretiyor (8 sn'de kanal başına ~370; 2D dönüşte 0). Konumu adım adım ya da rampayla güncellemek de düzeltmedi. HRTF bırakıldı; 3D artık kulağın
  yön ipuçlarıyla kendi zincirimizde: düzey farkı + uzak kulağa <1 ms gecikme (zaman farkı) + ses arkadayken tizleri yumuşatan süzgeç (arka gölgesi),
  hepsi pürüzsüz LFO ile. Aynı ölçümde dönüş boyunca 0 sıçrama (yalnız sesin başladığı ilk 4 ms'de gecikme hattı dolarken). Sağ-sol hareketi de
  daha belirgin (±0,86). 3D açılıp kapanırken bir kez küçük bir geçiş olabilir. Telefonda denenmedi.
- **Telefonda kontrol (3 adım):**
  1. Kulaklık tak, şarkıyı aç, "8D"ye dokun: ses başının etrafında dönmeli.
  2. Bir daha dokun ("8D kanal"): vokal ortada kalmalı, enstrümanlar dönmeli.
  3. Bir daha dokun: normale dönmeli; mikser ayarların bozulmamalı.

### 17. Klip | Mikser anahtarı: klip NET, mikser tek dokunuşta

- **İstek:** Klibi olan şarkı açılınca klip düğmesiz ve net görünsün; kanallara (solo gitar, vokal...) tek dokunuşla geçilsin, geri dönülsün (v79'daki aç/kapa hâli, v80'den iyi bulundu).
- **Ne:** Klibi saklı şarkıda başlığın altında **Klip | Mikser** anahtarı çıkar.
  - **Klip:** video tam genişlikte, karartmasız oynar (sessiz, sesle senkron: oynat, duraklat, sar, tempo). Mikser düğmeleri, kanallar ve döngü çubuğu bu görünümde gizlenir;
    kalan yer sözlere gider. Videoya (ya da köşedeki düğmeye) dokununca tam ekran.
  - **Mikser:** her şey eskisi gibi (kanallar, döngü, düğmeler); video durur.
  - Seçim hatırlanır (yeni anahtar `stem-mikser.clipview`; v79/v80'in anahtarları silinmedi, yalnız okunmuyor, yani güncellemeden sonra klip yine doğrudan açılır).
    Varsayılanı değiştirmek: Ayarlar > Sahne klipleri > "Klibi olan şarkı klip görünümünde açılsın".
  - Klip eklenmiş şarkıda üstteki "Klip" düğmesi artık yok (anahtar onun yerine); klibi olmayan şarkıda "Klip ekle" duruyor.
- **Düzeltilen eski hata:** Müzik çalarken kitaplığa dönünce oynatıcının görünmeyen videosu oynamaya devam ediyordu; artık ekran değişince hemen duruyor (müzik sürer).
- **Ölçüm (tarayıcı, sahte sunucu):** 375x812'de klip görünümü: üst çubuk 64, Sahne satırı 38, anahtar 38, video 16:9 193 px, akor 64, sözler kalanı, alt çubuk 145; taşma yok.
  412x860'ta video 214 px. Mikser görünümünde yerleşim v80 öncesiyle aynı (kanallar 88-90 px, kayar). Dikey klipte video en çok ekranın %38'i kadar uzar.
- **Testler:** 77 dosyanın hepsi yeşil (`clipframe_test` yeni yerleşime göre güncellendi). **SW:** v81. **Telefonda denenmedi.**
- **Telefonda kontrol (4 adım):**
  1. Ayarlar'da "Sürüm: SW v81" yazmalı (gerekirse uygulamayı kapat-aç).
  2. Klibi saklı bir şarkıyı aç: üstte "Klip | Mikser", altında klip net görünmeli; çal: video sesle birlikte oynamalı, duraklatınca durmalı.
  3. "Mikser"e dokun: bütün kanallar ve döngü gelmeli; şarkıyı kapatıp yeniden aç: Mikser görünümünde açılmalı. "Klip"e dokun: klip geri gelmeli.
  4. Videoya dokun: tam ekran açılmalı. Geri dön, çalarken kitaplığa geç: müzik sürmeli.

### 16. Klip mikserin ARKASINDA, kanallar önde

- **Sorun:** v79'da klip mikserin yerine geçiyordu; klip açıkken kanallar (solo gitar, vokal...) görünmüyordu.
- **Ne:** Klip artık kanal bölgesinin arka planında oynar; bütün kanallar yerinde ve önde kalır (sürgüler, S/M, kaydırma aynı). Video dokunmayı
  almaz; yazılar okunsun diye kenarlardan karartılır, kanal adları beyaz ve gölgeli. Tam ekran: üstteki "Klip" düğmesi.
  Arka planı kapatmak için: Ayarlar > Sahne klipleri > "Klibi mikserin arkasında oynat". v79'daki "Mikser" düğmesi kalktı (artık gerek yok).
- **Neden üste ya da yana değil:** Oynatıcı ekranı sabit yükseklikte; ayrı bir kutu miksere ~90 px bırakıyordu. Arka planda ikisi aynı yeri paylaşıyor.
- **SW:** v80.
- **Kullanıcı geri bildirimi:** Beğenilmedi ("hiç olmamış"; video kanalların arkasında net görünmüyor). v79'daki aç/kapa hâli daha iyi bulundu.
  Sorun başka bir modele devredilmek üzere `docs/KLIP_SORUNU.md`'ye yazıldı (denenenler, ölçüler, kod yerleri, kabul ölçütleri).
- **Telefonda kontrol (3 adım):**
  1. Klibi saklı bir şarkıyı aç: kanallar görünmeli, klip arkalarında oynamalı; kanal adları okunmalı.
  2. Bir kanalın sürgüsünü/S/M düğmesini kullan: video dokunmayı almamalı, kanal çalışmalı.
  3. "Klip"e dokun: tam ekran açılmalı.

### 15. Klip oynatıcıda doğrudan; ayırma ~1,5 dk hızlandı

- **Klip doğrudan ekranda:** Klibi saklanmış bir şarkıyı açınca klip artık düğmeye basmadan, MİKSERİN YERİNDE görünür; sessiz, sesle senkron
  (duraklat, sar, tempo). Üstte koyamadım: oynatıcı ekranı sabit yükseklikte, üste koyunca miksere ~90 px kalıyordu. Videodaki "Mikser" düğmesi
  kanalları geri getirir; üstteki "Klip" düğmesi klibe döndürür (seçim hatırlanır). Videoya ya da köşedeki simgeye dokununca tam ekran.
  Oynatıcı ekranı görünmüyorken (kitaplık, sahne, uygulama arka planda) video durur.
- **Eski bir kusur da düzeldi:** Dar/kısa ekranda "Sözler" satırı sıkışıp alttaki düğmelerle üst üste biniyordu; artık yalnız söz satırları küçülür.
- **Sunucu (onayınla):** Ayırma sonrasında 6 kanalın AAC'ye çevrilmesi artık aynı anda (ayırma işine 4 CPU çekirdeği ayrıldı), ilerleme kaydı
  6 yerine 1 kez. Ses dosyaları ve kalitesi aynı. `app.py` satır sayısı korundu, imaj yeniden kurulmadı. Commit f4d6b2e.
- **Ölçüm (aynı uzunluk, 4 dk, Hi-Fi):** kodlama 96,6 -> 32,4 sn; durum kayıtları 32,6 -> 11,6 sn; FLAC 13,7 -> 11,6 sn.
  Yüklemeden hazıra ~5 dk 49 sn -> ~4 dk 19 sn. Ölçüm, kitaplığa eklenen yapay "Hiz testi - yapay ses" şarkısıyla yapıldı (birkaç sentlik GPU).
  Kalan sürenin çoğu sunucunun açılışı, Hi-Fi aşaması ve analiz; onlara dokunulmadı.
- **SW:** v79.
- **Telefonda kontrol (4 adım):**
  1. Klibi saklı bir şarkıyı aç: klip mikserin yerinde hemen görünmeli; oynatınca sesle birlikte gitmeli.
  2. Videodaki "Mikser"e dokun: kanallar gelmeli; üstteki "Klip"e dokun: klip geri gelmeli.
  3. Videoya dokun: tam ekran açılmalı.
  4. Yeni bir şarkı yükle: eskisine göre ~1,5 dk daha erken "hazır" olmalı.

### 14. Oynatıcıda "Klip" düğmesi; ayırma süresinin ölçümü

- **Sorun:** "Klibi açamıyorum, direkt ses ekranı çıkıyor." Sebep: (1) bugünkü yüklemen v77 yayına girmeden önceydi, klip saklanmamıştı;
  (2) klip yalnız "Sahne"nin içinde, karartılmış arka plan olarak görünüyordu, oynatıcıdan açılmıyordu.
- **Ne:** Oynatıcıda "Sahne"nin yanına "Klip" düğmesi. Klip varsa tam ekran, NET (karartmasız) açar; akor ve söz küçülüp alta iner, ses mikserden
  gelir, video sesle senkron. Klip yoksa düğme "Klip ekle" der: telefondaki mp4'ü seçersin, bu şarkıya bağlanır (yükleme yok) ve hemen açılır.
  Sahnedeki film düğmesi artık üç durum arasında döner: arka planda (akor/söz önde) -> tam ekran -> gizli; kısa bir yazıyla hangisi olduğu söylenir.
- **Ölçüm (salt okunur, sunucuya iş verilmedi):** son şarkı 4 dk, Hi-Fi: yüklemeden hazıra ~6 dk. GPU ayırması 14 sn; kanalları AAC'ye çevirme 97 sn
  (sırayla); durum kayıtları 33 sn; analiz 34 sn. Bu yüklemenin 11,4 MB'lık dosyası klibin tamamıydı (v76); v77'den beri yalnız sesi gidiyor.
  Sunucu iyileştirmesi "Senin kararın gereken"de, onay bekliyor.
- **SW:** v78.
- **Telefonda kontrol (4 adım):**
  1. Klipten yüklediğin şarkıyı aç: "Sahne"nin yanında "Klip ekle" görünmeli; dokun, aynı mp4'ü seç: klip tam ekran açılmalı.
  2. Oynat: video sesle aynı yerde gitmeli, duraklatınca durmalı.
  3. Film simgesine dokun: "arka planda" -> "tam ekran" -> "gizli" diye dönmeli.
  4. Kapat, şarkıyı yeniden aç: düğme artık "Klip" demeli.

### 13. Klip geliştirmeleri: gerçek dosya testi, webm/mkv, parçalı mp4, klipten kapak, ilerleme/iptal, sahnede klip

- **Gerçek dosyalarla denendi:** Dört gerçek klip ürettim (içerik yapay: 3 sn ton + renkli kare, telif yok): Windows'un kendi kodlayıcısıyla normal mp4,
  tarayıcının kaydedicisiyle parçalı mp4, webm ve mkv. Dördünde de ayıklanan ses, klibin kendi sesiyle tarayıcıda örnek örnek AYNI çözüldü (fark 0).
  Bu dosyalar artık kalıcı test (`tests/fixtures/clips`, `tests/clip_fixtures_test.mjs`). Telefonda ve gerçek bir müzik klibiyle hâlâ denenmedi.
- **Yeni desteklenenler:** webm ve mkv (ses .webm/.mka olarak), parçalı (streaming) mp4. Süre bilgisi yazılmamış webm'lerde süre son ses bloğundan
  hesaplanıp eklenir (sunucu süresiz dosyayı reddediyordu). Şifreli (korumalı) klipler ayıklanmaz, nedeni söylenir.
- **Ad, sanatçı, kapak:** Klibin içindeki başlık/sanatçı/kapak bilgisi ayıklanan sese aynen taşınır; sunucu şarkı adını ve kapağı oradan okur.
  Klibin kendi kapağı yoksa ve şarkıda resimli kapak yoksa, klibin ortalarından karanlık/düz olmayan bir kare kapak yapılır (yalnız bu telefonda;
  bilgi sayfasında "Kapak: klipten bir kare", "Kapağı sıfırla" ile kaldırılır; senin seçtiğin ya da dosyanın kapağının üstüne yazmaz).
- **İlerleme ve iptal:** Ayıklama sırasında yüzde görünür, "Ayıklamayı iptal et" düğmesi çıkar. Sonunda "Klipten ses ayıklandı: 112 MB → 4,1 MB"
  gibi bilgi verilir. Artık KÜÇÜK klipler de ayıklanıp yüklenir (daha hızlı); ayıklanamayan küçük klip eskisi gibi olduğu gibi gider.
- **Sahnede klip:** Yüklediğin klip (ayar açıksa) telefonda saklanır; sahne modunda arka planda sessizce, şarkıyla senkron (tempo dahil) oynar,
  yazılar okunsun diye karartılır. Sahnede film simgesiyle gizlenir/açılır. Eski şarkılara: şarkı bilgisi > "Klip seç" (yükleme yapılmaz).
  Ayarlar > Sahne klipleri: saklama aç/kapa, toplam boyut, hepsini sil (onay ister). Şarkı silinince klibi de gider. Ses yalnız mikserden gelir.
- **Düzeltilen hata (v76'dan):** 30 MB üstü klip paylaşım kartından yüklenince kartta seçilen kalite yok sayılıyordu; artık kalite en başta okunuyor
  (testle korunuyor).
- **Sunucu:** dokunulmadı (sınır 30 MB, GPU işi yok).
- **SW:** v77.
- **Telefonda kontrol (4 adım):**
  1. Büyük bir mp4 klip seç: yüzde ilerlemeli "ayıklanıyor", sonra "112 MB → … MB" yazmalı ve yüklenmeli; "iptal" düğmesi ayıklama sırasında çalışmalı.
  2. Bitince şarkının adı/kapağı gelmeli (klipte yoksa klipten bir kare); şarkı bilgisinde "Sahne klibi: var" yazmalı.
  3. Şarkıyı aç > Sahne: klip arka planda sesle aynı yerde oynamalı; duraklatınca durmalı; film simgesi gizlemeli.
  4. Ayarlar > Sahne klipleri: toplam boyut doğru görünmeli; mevcut şarkıların mikser ayarları ve döngüleri yerinde olmalı.

### 12. 30 MB sınırı klibe değil sesine uygulanır

- **Ne:** 30 MB'tan büyük bir klip (mp4/m4v/mov) seçince uygulama görüntüyü telefonda atar, sesi YENİDEN KODLAMADAN yeni bir .m4a dosyasına koyar ve yalnız onu yükler. Ses kalitesi değişmez (baytlar aynen kopyalanır). Yeni dosya: `js/mp4audio.js`.
  Paylaş menüsünden gelen klipler de artık 400 MB'a kadar saklanır (ses dosyası sınırı 30 MB kaldı).
- **Sunucu sınırı bilerek değişmedi:** Sunucu yüklemeyi belleğe alıyor; sınırı yükseltmek riskli. Bu yol sunucuya hiç dokunmaz.
- **Çalışmayanlar:** webm/mkv ve "parçalı" (streaming) mp4 telefonda ayıklanamaz; uygulama nedenini söyler ve yalnız ses dosyası yüklemeni önerir. 400 MB üstü klip reddedilir. Ayıklanan ses yine 30 MB'ı geçerse uyarılır.
- **Sınırlı test:** Yalnız sentetik mp4 ile testli (ses baytları ve ofsetler doğrulandı). Gerçek bir "şarkı evreni" klibiyle ilk denemede sonucu söyle; çalışmazsa kayıt 11'deki gibi ses dosyası yolu geçerli.
- **SW:** v76.
- **Telefonda kontrol (4 adım):**
  1. 30 MB'tan büyük bir mp4'ü "Şarkı ekle"den seç: "klipten ses ayıklanıyor…" yazmalı.
  2. Bitince şarkı kitaplıkta görünmeli ve çalmalı (ses klibin sesi olmalı).
  3. Büyük bir webm/mkv seç: nedenini söyleyen uyarı çıkmalı, uygulama bozulmamalı.
  4. Mevcut şarkıların ayarları (mikser, döngüler) olduğu gibi durmalı.

### 11. Klip (mp4) dosyası yükleme

- **Ne:** "Şarkı ekle", Eklenecekler'deki yükle düğmesi ve Paylaş menüsü artık `.mp4 .m4v .mov .webm .mkv` dosyalarını da kabul ediyor. Videonun yalnız SESİ alınır (sunucu ffmpeg ile okur), görüntü atılır; şarkı adı dosya adından gelir.
  Paylaşım kartında "Video dosyası: yalnız sesi alınır" notu çıkar.
- **Sınır (önemli):** Sunucunun 30 MB / 10 dk sınırı TÜM dosyaya uygulanır, klipte görüntü de sayılır. Çoğu müzik klibi 30 MB'ı geçer; geçince uygulama yüklemeden önce "dosya çok büyük" der. Çözüm: daha düşük çözünürlüklü sürüm ya da yalnız ses dosyası.
  Sınırı yükseltmek sunucu belleğini zorlar, bilerek dokunmadım. Karar senin: istersen sınırı (örn. 60 MB) ayrıca değerlendiririz.
- **Dokunulmayanlar:** Mevcut şarkılar, kanallar, mikser ayarları, sözler, listeler. Yeni dosya yalnız yeni şarkı ekler; aynı dosya ikinci kez yüklenirse çoğalmaz (kimlik dosyanın sha256'sı).
- **Gerçek bir mp4 ile sunucuda denenmedi** (yerelde yalnız dosya seçimi/paylaşım mantığı testli). İlk denemede bir klip yükleyip sonucu söyle.
- **PWA notu:** Paylaşım hedefi bildirimi (manifest) değişti; Android'in yeni türleri tanıması için uygulamayı bir kez kapat-aç, olmazsa ana ekrandan kaldırıp yeniden ekle.
- **SW:** v75.
- **Telefonda kontrol (4 adım):**
  1. Kitaplıkta "Şarkı ekle"ye dokun: seçicide mp4 dosyaların görünmeli.
  2. 30 MB altı bir klip seç: kart/ilerleme çıkmalı, bitince şarkı kitaplıkta görünmeli (adı dosya adı).
  3. 30 MB üstü bir klip seç: yüklemeden önce "çok büyük" mesajı çıkmalı.
  4. Dosya yöneticisinde bir mp4'e uzun bas > Paylaş > Stem Mikser: kart "yalnız sesi alınır" demeli.

### 10. Görsel cila (7 madde)

Hepsi yeni görünümde; klasikte etkisiz (dönen kapak ve ekolayzır animasyonları hariç, onlar iki görünümde de var). SW v74.

1. **Kapaktan renk çıkarma + şarkıya özel vurgu rengi:** Çalan şarkının kapağından baskın renk alınır (kapak resmi yoksa şarkı adından üretilen ton); uygulamanın vurgu rengi (düğmeler, sekme, ilerleme, sahne ışığı) o renge döner. Gri/siyah-beyaz kapakta varsayılan camgöbeği-mor. Parlaklık her ton için kontrasta göre ayarlanır (testle sabit: koyu ve aydınlık temada okunur).
   Ayarlar > Görünüm > "Vurgu rengi çalan şarkının kapağından gelsin" ile kapatılabilir.
2. **Sahnede nabız ışığı:** Zemindeki ışık çıkış sesinin seviyesiyle nabız atar (analizör yalnız sahne açıkken bağlanır, saniyede ~15 okuma, kapanınca sökülür).
3. **Dönen kapak / plak:** Çalarken küçük oynatıcıdaki ve mikser başlığındaki kapak daire olup yavaşça döner; "Plak gibi" kipi açıkken üstüne plak çizgileri ve orta delik biner. Ayarlar > "Kapak çalarken dönsün" ile kapanır.
4. **Sahnede kelime kelime parlayan söz:** Kelime zamanlaması olan satırlarda çalan kelime parlar ve hafif büyür; satır değişince yumuşak kayarak girer.
5. (1 ile birlikte) **Şarkıya özel renk teması** yukarıda.
6. **Boş/yükleniyor:** Boş kitaplıkta ekolayzır çubukları ve karşılama yazısı; yükleniyor ekranında dönen halka yerine ekolayzır çubukları.
7. **Tema seçimi:** Ayarlar > Görünüm > Tema: Koyu (varsayılan), Sahne siyahı (tam siyah, OLED), Aydınlık. Aydınlık tema yeni; en çok kullandığın ekranlarda (kitaplık, mikser, ayarlar, alt sayfalar) denendi, nadir ekranlarda küçük renk uyumsuzlukları kalmış olabilir, görürsen söyle.
   (Kitaplıkta ızgara görünümü, istediğin gibi, yapılmadı.)

- **Telefonda kontrol (4 adım):**
  1. Kapağı olan bir şarkı çal: düğmelerin ve sekmenin rengi kapağa uymalı; küçük oynatıcıdaki kapak dönmeli. Ayarlar'dan kapatıp aç.
  2. Ayarlar > Tema > Aydınlık: kitaplık, mikser ve ayarlar okunur olmalı; sonra "Sahne siyahı" ile zemin tam siyah olmalı.
  3. Sahne modunu aç: ışık müzikle nabız atmalı; sözü olan şarkıda çalan kelime parlamalı.
  4. Tempo/ton panelinde "Plak gibi"yi aç: dönen kapakta plak çizgileri görünmeli.

### 9. Sahne modu

- **Ne:** Mikserde başlığın altındaki satırda "Sahne" düğmesi. Tam ekran, koyu: devasa **akor** (altında sıradaki akor), altında büyük **söz satırı** (+ sıradaki satır), ilerleme çizgisi, oynat/duraklat, listedeyken önceki/sonraki, "Sıradaki: ..." şarkı adı.
  Ekran hep açık kalır. Arka planda şarkı adından üretilen iki renkli, yavaş kayan ışık (kapak resmin varsa soluk görünür); yalnız transform/opacity ile hareket eder, ek animasyon döngüsü yok.
- **Kilit:** Sağ üstteki kilit simgesine dokununca ekran kilitlenir (dokunmalar yutulur, geri tuşu da kapatmaz); açmak için kilit simgesine **basılı tut** (0,7 sn). Sahnede yanlışlıkla durdurmayı önler.
- **Akor ve söz yoksa** ilgili alan boş kalır, ekran yine çalışır. Ton/transpoze ayarı akorlara uygulanır.
- **SW:** v73. Bilgisayarda 375x812'de denendi (kilit, geri tuşu, oynat/duraklat, sözlü/sözsüz); telefonda denenmedi.
- **Telefonda kontrol (4 adım):**
  1. Bir şarkıyı aç, çal; başlığın altındaki "Sahne"ye dokun: büyük akor ve ilerleme görünmeli.
  2. Sözü olan bir şarkıda büyük söz satırı akmalı.
  3. Kilit simgesine dokun, ekrana vur: hiçbir şey olmamalı; geri tuşu da kapatmamalı. Kilidi basılı tutarak aç.
  4. Çalma listesinde önceki/sonraki düğmeleri ve alttaki "Sıradaki" yazısı görünmeli.

### 8. On yeni özellik (öneri listesinin hepsi)

Hepsi yeni görünümde ve klasikte çalışır; veriler yalnız telefonda. Her biri saf mantık modülü + testli. SW v72, 71 test dosyası yeşil.

1. **Eklenecekler'den yükleme:** Bekleyen satırda yukarı-ok düğmesi: ses dosyasını sen seçersin, onay kartı kitaplıkta açılır, "Yükle ve ayır"a basınca yüklenir ve istek "eklendi" olur. (GPU yine yalnız o düğmeyle başlar.)
2. **Kapak yedeği:** Ayarlar > "Kapak yedeğini indir/yükle". Yalnız senin seçtiğin/onayladığın kapaklar; yükleme birleştirir, şarkıda zaten kendi kapağın varsa dokunmaz.
3. **Kitaplık sıralaması:** Aramanın altında "Sırala": Yeni, Ada göre, En çok çalınan, En uzun, En kısa. Çalma sayacı yalnız telefonda (şarkı baştan başlayınca +1).
4. **Uyku zamanlayıcısı:** Mikser başlığında ay simgesi: 15/30/60 dk ya da "Şarkı sonu". Son 20 sn ses kısılır, sonra durur; küçük oynatıcıda kalan süre görünür.
5. **Çalma sırası:** Kitaplıkta uzun bas > "Sıraya ekle"; Listeler sekmesinde "Çalma sırası" kartı (kaldır/temizle). Şarkı bitince sıradaki başlar. Çalma listesi modunda sıra işlemez.
6. **Kilit ekranı önceki/sonraki:** Liste dışında da çalışır: sonraki = sıra, yoksa kitaplıktaki sonraki şarkı; önceki = 3 sn'den sonra başa sar, değilse önceki şarkı. ±10 sn atlama da duruyor.
7. **Kendi mikser ön ayarların:** Ön ayar satırının sonunda "+ Kaydet" (ad sorar, en çok 12); dokun = uygula, uzun bas = sil. Ana sese dokunmaz, şarkıda olmayan kanal atlanır.
8. **Adlı A-B döngüler:** Döngü çubuğunda "+ Adla kaydet" (ör. Nakarat, Solo); chip'e dokun = döngüyü aç, "×" = sil. Şarkı silinince döngüleri de gider.
9. **Tanı raporu:** Ayarlar > "Tanı raporunu kopyala": sürüm, sayılar, durum, son hatalar. Token, API adresi, söz ve mikrofon verisi İÇERMEZ (testle sabit); sorun olunca bana yapıştır.
10. **Cihazdaki şarkılar:** Ayarlar > "Cihazdaki şarkılar (tek tek sil)": şarkı başına boyut ve "Sil" (onaylı). Hiçbir şey kendiliğinden silinmez.

- **Telefonda kontrol (4 adım):**
  1. İki şarkıyı seçip "Sıraya ekle" de, birini çal, sonuna doğru ilerlet: sıradaki kendiliğinden başlamalı; kilit ekranında ileri düğmesi de sıradakine geçmeli.
  2. Mikserde ay simgesinden 15 dk seç; küçük oynatıcıda "uyku 14:xx" görünmeli. "+ Kaydet" ile bir ön ayar, "+ Adla kaydet" ile bir döngü kaydet.
  3. Kitaplıkta "Sırala > En çok çalınan"; Eklenecekler'de bir satırın yukarı-ok düğmesiyle dosya seçip karta düştüğünü gör (yüklemek zorunda değilsin).
  4. Ayarlar'da "Tanı raporunu kopyala" ve "Cihazdaki şarkılar"ı aç.

### 7. Eklenecekler'de arama

- **Ne:** Eklenecekler ekranına arama kutusu: ad, sanatçı ya da kaynak (ör. Takeout liste adı) ile süzer. Türkçe harf, aksan ve büyük-küçük farkı önemsiz;
  birden çok sözcük yazarsan hepsi geçmeli. Bekleyen / Eklendi / Hepsi çipleriyle birlikte çalışır.
- **SW:** v71.
- **Telefonda kontrol:** Eklenecekler'de arama kutusuna bir şarkı adının bir kısmını yaz: yalnız eşleşenler kalmalı; silince hepsi geri gelmeli.

### 6. Eklenecekler: uzun liste sayfa sayfa

- **Ne:** Takeout binlerce kayıt getirebilir; hepsini birden çizmek telefonda ekranı saniyelerce dondururdu. Artık 150'şer kayıt çiziliyor, altta "Daha fazla göster (N kaldı)".
  Bilgisayarda 1200 kayıtla denendi: ekran 11 ms'de açılıyor, sonraki 150 kayıt 74 ms.
- **SW:** v70.
- **Telefonda kontrol:** Takeout içe aktardıktan sonra Eklenecekler hızlı açılmalı; listenin sonunda "Daha fazla göster" çıkmalı.

### 5. Yeni görünüm düzeltmeleri ve sözlü -> sözsüz geçiş (Aşama 4)

- **İlk kurulum hatası (önemli, düzeltildi):** Yeni görünümde Ayarlar'ın "geri" düğmesini gizlemiştim; uygulama ilk kez kurulduğunda (adres/token yokken) Ayarlar'dan
  çıkış yolu kalmıyordu, Kitaplık sekmesi tepki vermiyordu. Senin telefonun zaten ayarlı olduğu için görmezdin; v65-v68 arasında yeni kurulumu etkilerdi. Artık Kitaplık sekmesi çalışıyor.
- **Mikser dar ekranda:** Sözler açıkken kanallara neredeyse hiç yer kalmıyordu (20 piksel). Artık söz listesi esniyor, en az ~2 kanal satırı görünüyor. "Hi-Fi'a yükselt" düğmesi
  alt çubuktan şarkı bilgisi satırına taşındı (alt çubuk tek satır). Döngü ve söz düğmeleri alt satıra sarmak yerine yana kayıyor.
- **Sözlü -> sözsüz geçiş:** Sahte sunucuda liste modunda, tam ekran sözler açıkken denedim: "Bu şarkıda söz yok" doğru çıkıyor, hatayı yeniden üretemedim. Kodda bir boşluk buldum:
  şarkı değişirken yeni şarkının bilgisi ağdan gelene kadar eski şarkı için geç gelen bir tazeleme eski sözleri geri koyabiliyordu. Bunu kapattım (şarkı değişimi bitene kadar söz yüklemesi tutulur).
  Canlıda OMORI'nin söz durumuna da baktım (salt okunur): "vokal yok", önceki kayıt yok; yani veri tarafında bir tuhaflık yok.
- **Commit:** `a1ed891`. **SW:** v69.
- **Telefonda kontrol (4 adım):**
  1. Ayarlar'da "Sürüm: SW v69" yazmalı.
  2. Sözü olan bir şarkıyı aç: sözler açıkken en az iki kanal (Vokal, Davul) görünmeli, alt çubuk tek satır olmalı.
  3. Listede sözlü bir şarkıdan sonra OMORI olsun; tam ekran sözler açıkken sonraki şarkıya geç: "Bu şarkıda söz yok" yazmalı, eski sözler kalmamalı.
  4. Hi-Fi olmayan bir şarkıda "Hi-Fi'a yükselt" düğmesi başlığın altındaki satırın sağında görünmeli.

### 4. Küçük iyileştirmeler (Aşama 4, kısmen)

- **Mikrofon kapanınca ses rotası:** Antrenör mikrofonu kapanınca, çalmıyorsak ses bağlamı askıya alınır; sonraki çalma çıkışı normal rotada yeniden kurar
  (Android'de mikrofondan sonra sesin gitmesi şikâyeti için önlem; telefonda doğrulanmadı). Çalarken dokunulmaz. Antrenör varsayılan kapalı kaldı.
- **Listede geçiş:** Çalma listesinde bir şarkı başlayınca sıradakinin sesi arka planda cihaza indirilir (yalnız indirme; çözme/motor yok), geçiş ağdan değil cihazdan açılır.
- **SW:** v68. Telefonda kontrol: (1) iki şarkılı liste çal, ilk şarkıdayken sıradaki "cihaza iniyor" görünmeli; (2) geçiş hızlı olmalı.

### 3. Eklenecekler (Aşama 3)

- **Ne yaptım:** Listeler sekmesinde "Eklenecekler" ekranı: yüklemek istediğin şarkıların listesi. (1) YouTube Music'ten "Paylaş > Stem Mikser" dersen şarkı adı + bağlantı
  buraya yazılır; bağlantıya HİÇBİR istek atılmaz, hiçbir şey indirilmez. (2) Google Takeout zip'ini (açmadan) ya da CSV dosyalarını seçersin; uygulama tarayıcıda
  açıp beğenilen şarkıları ve listeleri bulur (dosya adlarına bağlı değil, sütunlara bakar), veri sunucuya gitmez. (3) Elle ekleme. Satırda: kapak, ad, sanatçı, bağlantıyı aç,
  "eklendi", sil. Kitaplığa şarkı yüklenince adı benzeyen istek kendiliğinden "eklendi" olur (elle geri alınabilir).
- **Veri:** collection belgesinde (`wishes`, yedeğe dahil, eski veriler ve bilinmeyen alanlar korunur; testle sabit). Yedek sınırı 1 MB'tan 4 MB'a çıktı.
- **Commit:** `e0edc53` (+ `a850e5d`). **SW:** v67 (manifest paylaşım alanları da değişti: PWA'nın yeni paylaşım hedefini alması için uygulamayı bir kez kapat-aç; gerekirse
  ana ekrandan kaldırıp yeniden ekle). Pages yeşil.
- **Telefonda kontrol (4 adım):**
  1. YouTube Music'te bir şarkıda Paylaş > Stem Mikser: "Eklenecekler'e eklendi" yazmalı; Listeler > Eklenecekler'de görünmeli.
  2. Eklenecekler > "Takeout'tan al": Takeout zip'ini seç; "N kayıt bulundu, M yeni eklendi" yazmalı.
  3. Bir satırda bağlantı simgesine dokun: bağlantı açılmalı. Onay işareti: "eklendi" olur, tekrar dokununca geri alır.
  4. Listede olan bir şarkının adını elle ekle: kitaplık yenilenince "eklendi" olmalı.

### 2. Kapaklar (Aşama 2)

- **Ne yaptım:** Kitaplık satırlarında, küçük oynatıcıda, mikser başlığında ve kilit ekranında kapak. Sıra: senin seçtiğin resim > dosyanın içindeki kapak > şarkı adından üretilen renkli kapak
  (aynı ad hep aynı renk, harfli). Mikserde kapağa dokununca "Şarkı bilgisi" sayfası: Resim seç, Kapak bul (MusicBrainz + Cover Art Archive; yalnız "Ara"ya basınca, sonuç listesinden
  seçince kaydolur), Kapağı sıfırla. Kapaklar yalnız telefonda (IndexedDB), çevrimdışı çalışır, silinen şarkıyla gider.
- **Sunucu:** `GET /songs/{id}/cover` (salt okunur CPU; mp3/m4a/flac içindeki kapağı okur; Volume'a yazmaz, GPU yok). **Canlıya deploy edildi (imaj kurulmadan, 6 sn);** 8 şarkıda da dosyada
  kapak bulunamadı (204), yani şimdilik otomatik kapaklar görünür; yeni yüklediğin kapaklı mp3'te gömülü kapak gelir.
- **Commit:** `016f988`, `a850e5d`. **SW:** v66.
- **Telefonda kontrol (4 adım):**
  1. Kitaplıkta her şarkıda renkli harfli kapak görünmeli.
  2. Bir şarkıyı aç, başlığın solundaki kapağa dokun: "Resim seç" ile galeriden bir resim seç; satırda ve küçük oynatıcıda değişmeli.
  3. "Kapak bul" > "Ara": sonuçlardan birine dokun; kapak kaydolmalı. "Kapağı sıfırla" ile geri alınır.
  4. Şarkı çalarken kilit ekranında kapak görünmeli.

### 1. Yeni görünüm (Aşama 1)

- **Ne yaptım:** Uygulamaya modern bir müzik uygulaması görünümü verdim: yeni renkler (koyu zemin + camgöbeği-mor degrade),
  yumuşak köşeler, büyük dokunma alanları, altta **Kitaplık / Listeler / Ayarlar** sekme çubuğu ve kitaplıkta gezerken **küçük
  oynatıcı** (çalan şarkı, oynat/duraklat, ilerleme çizgisi; dokununca mikser açılır). Tasarım kuralları `docs/TASARIM.md`'de.
- **Nasıl:** Eski ekranlara dokunmadım; yeni görünüm ayrı bir stil dosyası (`css/modern.css`) ve küçük bir kabuk (`js/shell.js`).
  Ayarlar > Görünüm > "Yeni görünüm" anahtarı (varsayılan AÇIK). Bozulursa adres çubuğuna `?klasik=1` yaz: eski görünüm gelir ve
  tercih kapalı olarak kaydedilir (`?klasik=0` yeniye döner).
- **Yan bulgu:** `navstack.js` service worker'ın çevrimdışı dosya listesinde yokmuş (yeni `sw_shell_files_test` yakaladı), ekledim.
- **Veri güvenliği:** Görünüm tercihi kendi anahtarında (`stem-mikser.look`); ayarlar, favori/etiket, çevrimdışı şarkılar, mikser
  hafızasına dokunmuyor (testle sabit: `tests/look_test.mjs`).
- **Commit:** `6b0137c`. **SW:** v65. Pages dağıtımı yeşil.
- **Telefonda kontrol (4 adım):**
  1. Uygulamayı aç (gerekirse bir kez kapat-aç; Ayarlar'da "Sürüm: SW v65" yazmalı): altta üç sekme görünmeli.
  2. Bir şarkı aç, çal, geri tuşuna bas: müzik sürmeli, altta küçük oynatıcı çıkmalı; ona dokununca mikser geri gelmeli.
  3. Listeler ve Ayarlar sekmelerine geç; Ayarlar'da "Görünüm > Yeni görünüm" anahtarını kapatıp aç: eski/yeni görünüm değişmeli.
  4. Mikserde alt çubuk (konum, oynat, hız/ton) taşmadan görünmeli.
