# Klip sorunu: oynatıcıda klip + mikser aynı anda (devir notu)

Bu not, sorunu başka bir modelin / oturumun sıfırdan devralması için yazıldı. Depo: Stem Mikser (vanilla JS PWA, `frontend/`, GitHub Pages;
arka uç Modal, `backend/`). Kullanıcı telefonda (Android, PWA) kullanıyor. Kullanıcı Türkçe konuşur.

## Kullanıcının istediği (kendi sözleriyle)

- "Klibi açamıyorum, direkt ses yeri çıkıyor" -> şarkıyı açınca klibi görmek istiyor, ayrı bir düğmeye basmadan.
- "Klip bir butonla açılıyor, açık gelse direkt", "klibi direkt ekrana koyabilir misin".
- "Klip olanlarda bu sefer şarkı yerleri gitmiş, solo gitar vs." -> klip açıkken mikser kanalları (vokal, davul, bas, gitar, piyano, diğer) da
  erişilebilir olmalı.
- "Hiç olmamış ... önceki daha iyiydi, açıp kapatma hâliyle" -> v80 (klip kanalların arkasında) beğenilmedi; v79 (klip mikserin yerinde +
  Klip/Mikser ile aç-kapa) daha iyi bulundu.

**Özet hedef:** Klibi saklı bir şarkı açılınca klip hemen, NET (karartılmadan) görünsün; mikser kanalları tek dokunuşla erişilebilsin ve geri
dönülebilsin (aç/kapa); seçim hatırlansın. Hiçbir şey üst üste binmesin, mikser kullanılamaz hâle gelmesin.

## Denenenler ve neden olmadı

| Sürüm | Ne yapıldı | Sonuç |
|---|---|---|
| v78 (commit 5af325b) | Oynatıcıda "Klip" düğmesi -> tam ekran sahne (`openStage("full")`). | Kullanıcı düğmeye basmadan görmek istedi. |
| v79 ilk deneme (yayınlanmadı) | Akor şeridinin üstüne 16:9 klip kutusu. | Oynatıcı sabit yükseklikte; kanallar ~88 px'e indi, "Sözler" satırı sıkışıp üst üste bindi. |
| v79 (a0d7ceb, yayını 36d5ebb) | Klip KANALLARIN YERİNDE (kanallar `display:none`), videoda "Mikser" düğmesi, üstteki "Klip" geri getirir; seçim saklanır. | Kanallar görünmüyordu ("solo gitar gitmiş"). Ama kullanıcı sonradan bunu v80'den iyi buldu (aç/kapa net). |
| v80 (0eb3db2, yayını 32bbe41) | Klip kanal bölgesinin ARKASINDA (absolute, JS ile kanal kutusuna oturtulur, karartılmış, `pointer-events:none`), kanallar önde. | "Hiç olmamış": video kanalların arkasında kayboluyor, net görünmüyor. |
| v81 | Fikir 1: başlığın altında "Klip \| Mikser" anahtarı. Klip: video akışta, net, tam genişlik (16:9 193-214 px); mikser düğmeleri, kanallar, döngü gizli, kalan yer sözlere. Mikser: eskisi gibi. Seçim `stem-mikser.clipview`'da. Kitaplığa dönünce video durur (eski hata). | Telefonda bekleniyor. |

## Yerleşim kısıtı (asıl zorluk)

Oynatıcı (`#view-player`, yeni görünüm `html.ui-new`) ekran yüksekliğinde sabit bir flex sütun; yalnız kanallar (`#channels`, içi kayar) ve söz
listesi esner. 375x812'de ölçülen yükseklikler (px):

| Parça | Yükseklik |
|---|---|
| üst çubuk (`.topbar`) | 64 |
| yöntem satırı + Sahne/Klip düğmeleri (`#player-method-row`) | 55 |
| akor şeridi (`.chordstrip`) | 64 |
| sözler bölümü (`#lyrics`, söz yokken) | 88 |
| mikser düğme satırı (`.mix-bar`) | 46 |
| **kanallar (`#channels`)** | **~188 kalan** (içerik 6 kanal ~460, kayar) |
| döngü çubuğu (`.loop-bar`) | 142 |
| alt çalma çubuğu (`.transport`) | 145 |

Gerçek telefon (PWA, ~412x840-860) birkaç on px daha fazla verir. Yani 16:9 klip (genişlik 343-380 -> 193-214 px) ile kanallar aynı anda tam
sığmıyor. İlgili CSS: `frontend/css/modern.css` (`html.ui-new .channels { flex: 1 1 132px; min-height: 88px; }`, kısa ekran media query'leri,
`html.ui-new .lyrics ...` kuralları; v79'da eklenen "sözler başlığı sıkışmasın" kuralı korunmalı).

## Değerlendirilebilecek fikirler (karar senin)

1. v79'a dön (aç/kapa net) ve iyileştir: Klip/Mikser arasında görünür bir sekme/anahtar (ör. kanal bölgesinin üstünde "Klip | Mikser"), seçim hatırlanır.
2. Klip açıkken yer aç: söz bölümü (88) ve döngü çubuğu (142) tek satıra katlansın; akor şeridi videonun alt kenarına bindirilsin. Böylece klip + birkaç kanal sığabilir.
3. Bölünmüş görünüm: klip üstte (ör. %55), kanallar altta kayar; kısa ekranda otomatik olarak 1'e düşer.
4. Yüzen küçük video (16:9 ~160x90, sürüklenebilir, dokununca tam ekran) ya da tarayıcının Picture-in-Picture API'si (kullanıcı hareketi gerekir).
5. Klip açıkken oynatıcı sayfası kaydırılabilir olsun (klip üstte tam boy, alt çalma çubuğu yapışkan).

## Kod nerede

- `frontend/js/app.js`
  - Oynatıcı klibi: `playerClipLoad`, `playerClipApply`, `playerClipPlace` (v80), `playerClipTick`, `playerClipUnload`, `setPlayerClipPref`.
  - Şarkı yüklenince: `refreshClipChip(); playerClipLoad();` (`syncCoverUi` sonrası).
  - Senkron: ana rAF döngüsünde `playerClipTick(time)` (şarkı açıkken duraklatılmışta da döner), `setPlayIcon` ve `visibilitychange` içinde zorlamalı çağrı.
  - Üstteki düğme: `on("clip-open", ...)`, `refreshClipChip`; klip ekleme `on("clip-file", "change", ...)`; kaldırma `on("clip-remove", ...)`.
  - Tam ekran sahne: `openStage("full")`, `stageClip*` işlevleri (ayrı `<video id="stage-clip">`).
- `frontend/js/stage.js` -> `clipSync(...)` (saf; video/ses kayması 0,3 sn üstünde konumlar, tempo, oynat/durdur). Yeniden kullanılmalı.
- `frontend/js/clipstore.js` -> IndexedDB `stem-mikser-clips` (şarkı kimliği -> klip Blob), `settingOn`, `PLAYER_CLIP_KEY = "stem-mikser.mixerclip"`,
  `STAGE_CLIP_KEY`, `CLIP_KEEP_KEY`.
- `frontend/index.html` -> `#player-clip` (içinde `<video id="player-clip-video" muted playsinline>`), `#channels`'tan hemen önce; Ayarlar'da
  `#setting-mixerclip`.
- `frontend/css/styles.css` -> "oynatıcıda klip" bloğu (`.player-clip`, `#view-player.clip-on ...`).
- Testler: `tests/clipframe_test.mjs` (kaynak taraması; yerleşim değişince ilgili kontroller güncellenmeli), `tests/mp4audio_test.mjs`,
  `tests/clip_fixtures_test.mjs`. Hepsi: `PYTHONUTF8=1 PYTHONIOENCODING=utf-8 node tests/run_all.mjs`.

## Kurallar (projede sabit)

- Kullanıcının telefondaki verisi korunur: localStorage anahtarları (`stem-mikser.*`), IndexedDB (`stem-mikser-clips`, `stem-mikser-covers`). Silme/temizleme yok.
- Arayüz değişince `frontend/sw.js` içindeki `VERSION` artırılır (şu an v80) ve yeni modül varsa `SHELL` listesine eklenir.
- Push'tan önce tüm testler yeşil + 375x812 tarayıcı kontrolü. Git: dosyalar ADIYLA eklenir (`git add -A` yok), force push yok, geçmiş yeniden yazılmaz.
- Push sonrası GitHub Pages yeşil olmalı (iş akışı artık build+deploy ayrı işler). `docs/GUNLUK.md`'ye kayıt eklenir (Türkçe, sade, telefonda 4 adımlık kontrol).
- Sunucuya (Modal) bu iş için dokunmaya gerek yok. Ses yalnız mikserden gelir; videolar her zaman `muted`.

## Kabul ölçütleri

1. Klibi saklı bir şarkıyı açınca klip düğmesiz, hemen ve NET görünür; sesle senkron (oynat, duraklat, sar, tempo).
2. Mikser kanallarına tek dokunuşla geçilir ve klibe tek dokunuşla dönülür (ya da ikisi aynı anda kullanılabilir biçimde görünür); seçim hatırlanır.
3. 375x812 ve ~412x860'ta hiçbir şey üst üste binmez, yatay taşma yok; kanallar kullanılabilir boyutta (en az ~2 satır) kalır.
4. Oynatıcı görünmüyorken (kitaplık, sahne, uygulama arka planda) video durur; şarkı değişince/silinince klip bırakılır.
5. Tüm testler yeşil, SW sürümü artmış, GUNLUK kaydı yazılmış.

## Yerelde deneme

- `.claude/launch.json`: `frontend` (python http.server 8000) ve `mock-api` (8001, token `mock-token`). Ayarlar'da adres `http://127.0.0.1:8001`.
- Örnek klip: `tests/fixtures/clips/clip-rec.mp4` (yapay, telifsiz). Bir şarkıya bağlamak için oynatıcıda "Klip ekle" (tarayıcı konsolunda
  `DataTransfer` ile `#clip-file`'a dosya verilip `change` olayı tetiklenebilir).
- Tuzaklar: geliştirme sunucusunda service worker eski `app.js`'i önbellekten verebilir (kayıt silinip `caches` temizlenmeli); python http.server
  ara sıra bağlantıyı keser (yeniden dene / sunucuyu yeniden başlat).
