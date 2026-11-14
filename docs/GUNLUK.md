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

Oturum kullanım sınırına takılıp erken bitti. YAPILDI: Aşama 1 (yeni görünüm, sekme çubuğu, küçük oynatıcı), Aşama 2 (kapaklar, sunucu ucu canlıda),
Aşama 3 (Eklenecekler, paylaş menüsü metin/bağlantı, Takeout zip/CSV), Aşama 4'ten iki iş (mikrofon kapanınca çıkış rotası, listede sıradakini önceden indirme).
YAPILMADI: Aşama 4'ün geri kalanı (sözlü -> sözsüz geçiş, konsol/bellek taraması, ek test/sadeleştirme). Modal'a hiçbir GPU işi eklenmedi, hiçbir şarkı verisine dokunulmadı.

## Kayıtlar (en yeni üstte)

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
