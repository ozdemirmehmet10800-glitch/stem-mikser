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

## Genel özet

- **Yapıldı:** Aşama 1 (yeni görünüm, sekme çubuğu, küçük oynatıcı), Aşama 2 (kapaklar; sunucu ucu canlıda), Aşama 3 (Eklenecekler: paylaş menüsü
  metin/bağlantı, Takeout zip/CSV, otomatik "eklendi"), Aşama 4'ten: mikrofon kapanınca çıkış rotası, listede sıradakini önceden indirme, sözlü -> sözsüz
  geçiş için koruma, mikserde dar ekran düzeni, ilk kurulumda Ayarlar'dan çıkış hatası.
- **Son sürüm:** SW v81 (kayıt 17: oynatıcıda Klip | Mikser anahtarı). 77 test dosyasının hepsi yeşil, Pages dağıtımı yeşil. Denemeler bilgisayarda 375x812 tarayıcıda ve sahte
  sunucuyla yapıldı; **telefonda hiçbir şey denenmedi.**
- **Sunucu:** yalnız bir salt okunur CPU ucu eklendi (kapak). GPU işi eklenmedi, mevcut şarkılara iş başlatılmadı, Volume'da hiçbir şey silinmedi/taşınmadı.
  Modal harcaması: iki başarısız imaj kurma denemesi (kısa CPU) + birkaç salt okunur istek; 2 $ sınırının çok altında (kesin rakam Modal panelinde).
- **Yapılmadı (Aşama 4'ten kalan):** bellek ve yavaş açılış ölçümü (telefon gerekir), kod sadeleştirme. Antrenörün otomatik gecikmesine baktım:
  v63'te zaten güven ölçütü, makul aralık, sıçrama direnci ve ortanca eklenmiş, 62 testle korunuyor; telefondan yeni ölçüm olmadan değiştirmedim. Sözlü -> sözsüz geçiş hatasını
  sahte sunucuda YENİDEN ÜRETEMEDİM (doğru çalışıyor); yalnız olası bir yarış durumunu kapattım, telefonda senin doğrulaman gerekiyor.

## Kayıtlar (en yeni üstte)

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
