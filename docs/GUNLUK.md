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

## Genel özet

- **Yapıldı:** Aşama 1 (yeni görünüm, sekme çubuğu, küçük oynatıcı), Aşama 2 (kapaklar; sunucu ucu canlıda), Aşama 3 (Eklenecekler: paylaş menüsü
  metin/bağlantı, Takeout zip/CSV, otomatik "eklendi"), Aşama 4'ten: mikrofon kapanınca çıkış rotası, listede sıradakini önceden indirme, sözlü -> sözsüz
  geçiş için koruma, mikserde dar ekran düzeni, ilk kurulumda Ayarlar'dan çıkış hatası.
- **Son sürüm:** SW v73 (kayıt 9'daki sahne modu dahil). 65 test dosyasının hepsi yeşil, Pages dağıtımı yeşil. Denemeler bilgisayarda 375x812 tarayıcıda ve sahte
  sunucuyla yapıldı; **telefonda hiçbir şey denenmedi.**
- **Sunucu:** yalnız bir salt okunur CPU ucu eklendi (kapak). GPU işi eklenmedi, mevcut şarkılara iş başlatılmadı, Volume'da hiçbir şey silinmedi/taşınmadı.
  Modal harcaması: iki başarısız imaj kurma denemesi (kısa CPU) + birkaç salt okunur istek; 2 $ sınırının çok altında (kesin rakam Modal panelinde).
- **Yapılmadı (Aşama 4'ten kalan):** bellek ve yavaş açılış ölçümü (telefon gerekir), kod sadeleştirme. Antrenörün otomatik gecikmesine baktım:
  v63'te zaten güven ölçütü, makul aralık, sıçrama direnci ve ortanca eklenmiş, 62 testle korunuyor; telefondan yeni ölçüm olmadan değiştirmedim. Sözlü -> sözsüz geçiş hatasını
  sahte sunucuda YENİDEN ÜRETEMEDİM (doğru çalışıyor); yalnız olası bir yarış durumunu kapattım, telefonda senin doğrulaman gerekiyor.

## Kayıtlar (en yeni üstte)

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
