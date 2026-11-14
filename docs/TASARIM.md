# Stem Mikser: görsel tasarım rehberi ("Yeni görünüm")

Amaç: uygulama bir "araç paneli" gibi değil, modern bir müzik uygulaması gibi hissettirsin.
Telefon öncelikli (Samsung S24 FE, dikey, 375-412 px genişlik), koyu tema, tek elle kullanım.

Yeni görünüm **yalnızca CSS katmanı + küçük bir kabuk**tur (`css/modern.css`, `js/shell.js`). Mevcut HTML/JS
mantığına dokunmaz; `<html class="ui-new">` varken devreye girer. Eski görünüm (`css/styles.css`) olduğu gibi
kalır ve her zaman geri dönülebilir:

- Ayarlar > Görünüm > "Yeni görünüm" anahtarı (varsayılan AÇIK).
- Adres çubuğuna `?klasik=1` yazılırsa eski görünüme dönülür **ve tercih kapalı olarak kaydedilir**
  (yeni görünüm bozulur da Ayarlar'a ulaşılamazsa diye). `?klasik=0` yeni görünümü yeniden açar.

Özgünlük: başka bir uygulamanın (YouTube Music, Spotify...) renk, logo, simge ya da yerleşim kimliği kopyalanmaz.
Burada: soğuk koyu zemin + "sahne ışığı" gradyanı (camgöbeği → mor) + yumuşak köşeler. Simgeler bu projede çizildi.

## Renk paleti (CSS değişkenleri, `html.ui-new` altında)

| Değişken | Değer | Kullanım |
|---|---|---|
| `--bg` | `#090b10` | sayfa zemini |
| `--bg-2` | `#0e1118` | gömülü alanlar (söz listesi, akor şeridi, dalga) |
| `--panel` | `#141821` | kart / satır zemini |
| `--panel-2` | `#1b202b` | yükseltilmiş yüzey (alt sayfa, açılır panel) |
| `--panel-3` | `#242a37` | basılı / seçili yüzey |
| `--line` | `rgba(255,255,255,.09)` | ince ayırıcı |
| `--text` | `#f2f4f9` | ana metin (zeminde ~17:1) |
| `--text-dim` | `#aab3c5` | ikincil metin (~9:1) |
| `--text-faint` | `#8991a6` | üçüncül metin (~5.6:1, büyük/ikincil yerlerde) |
| `--accent` | `#52d9f2` | vurgu, etkin simge, ilerleme |
| `--accent-2` | `#9a7cff` | gradyanın öbür ucu |
| `--accent-dim` | `#1f5f73` | seçili çip zemini |
| `--grad` | `linear-gradient(135deg,#46d3f0,#8f7bff)` | ana düğme, çalma düğmesi, sekme göstergesi |
| `--on-grad` | `#06121a` | gradyan üstündeki yazı (≥ 8:1) |
| `--danger` / `--warn` / `--ok` | `#ff7b7b` / `#ffc24d` / `#43d9a0` | durum renkleri |

Kontrast kuralı: normal metin ≥ 4,5:1, büyük metin ve simgeler ≥ 3:1. Renk tek başına anlam taşımaz (durum
metni ya da simgesi de yazılır).

## Yazı tipi

Sistem yazı tipi (`system-ui`, Roboto/Segoe/SF): **yeni yazı tipi indirilmez**, lisans ve ağ maliyeti yok. Rakamlar
`font-variant-numeric: tabular-nums`. Japonca için mevcut `:lang(ja)` yedekleri korunur.

| Rol | Boyut / ağırlık |
|---|---|
| Ekran başlığı (Kitaplık...) | 30 px / 800, harf aralığı -0,03em |
| Bölüm başlığı | 18 px / 700 |
| Satır başlığı (şarkı adı) | 16 px / 600 |
| Gövde | 15 px / 400 |
| İkincil | 13 px / 500 (renk: `--text-dim`) |
| Etiket / sekme yazısı | 11-12 px / 600 |

## Boşluk ve boyutlar

- Boşluk ölçeği: 4 · 8 · 12 · 16 · 20 · 24 · 32 px. Ekran yan boşluğu 16 px.
- Köşe yarıçapı: 8 (küçük kontrol) · 12 (giriş, satır) · 16 (kart, düğme) · 24 (alt sayfa üst köşeleri) · 999 (çip, hap).
- **Dokunma alanı ≥ 44×44 px.** Görsel olarak daha küçük çip/anahtarlar görünmez bir `::after` ile 44 px'e genişler.
- Alt gezinti: sekme çubuğu 64 px + güvenli alan; küçük oynatıcı 64 px (yalnız çalan şarkı varken).

## Bileşenler

- **Düğme** (`.btn`): 48 px yükseklik, 16 px köşe, `--panel` zemin. `.btn-primary` = gradyan + `--on-grad` yazı.
  `.btn-small` 44 px. Basınca `transform: scale(.97)`.
- **Kart**: `--panel`, 16 px köşe, kenarlık yok (yalnız `--line` hattı gerekirse). Gölge yok; derinlik zemin farkıyla.
- **Çip** (`.chip`, `.lib-chip`, `.tag-chip`): 36 px görsel yükseklik, hap biçimli; seçili = `--accent-dim` zemin + `--accent` kenar.
- **Kaydırıcı / fader**: iz 4 px, topuz 20 px, dolu kısım `--grad`; dokunma alanı 44 px (fader.js geometrisi aynı).
- **Anahtar** (`input[role=switch]`): 52×32; açıkken gradyan zemin.
- **Alt sayfa** (`.export-box`, `.fx-box`): üst köşeler 24 px, üstte tutamaç çizgisi, aşağıdan kayarak açılır.
- **Şarkı satırı**: 56 px kapak (12 px köşe) + başlık/alt yazı + favori yıldızı; ayraç çizgisi yok, satır arası 4 px.
- **Sekme çubuğu**: Kitaplık / Listeler / Ayarlar; etkin sekme `--accent` + üstte gradyan çizgi. Oynatıcıda (mikser) görünmez.
- **Küçük oynatıcı**: kapak + ad + oynat/duraklat; altında 2 px ilerleme çizgisi; gövdeye dokununca mikser açılır.

## Simge seti

`index.html` başındaki SVG sprite (`<symbol id="i-...">`): 24×24, çizgi kalınlığı 2, uçlar yuvarlak, `currentColor`.
Projede çizildi, dışarıdan simge paketi yok. Mevcut dolgulu simgeler (ayar çarkı, geri oku vb.) yerinde kalır.
Simge adları: `i-library`, `i-lists`, `i-settings`, `i-play`, `i-pause`, `i-plus`, `i-search`, `i-wish`, `i-link`, `i-trash`.

## Animasyon kuralları

- **Yalnız `transform` ve `opacity`** (kompozitör). `width/height/top/left`, `filter`, `backdrop-filter`, gölge animasyonu YOK.
- Süre 120-220 ms, eğri `cubic-bezier(.2,.8,.2,1)`. Ekran geçişi: opaklık 0→1 + 6 px yukarı. Alt sayfa: 24 px aşağıdan.
- Sürekli (döngülü) animasyon yok; yalnız zaten var olan yükleme çarkı ve tam ekran söz akışı.
- `prefers-reduced-motion: reduce` ise tüm yeni animasyonlar kapanır.
- Ses motorunun CPU bütçesine dokunulmaz: yeni görünüm ek `requestAnimationFrame` döngüsü eklemez. Küçük oynatıcının
  ilerleme çizgisi çalarken saniyede 2 kez (500 ms), yalnız oynatıcı ekranı kapalıyken güncellenir.

## Kapaklar (Aşama 2)

Kaynak sırası: dosyanın gömülü kapağı → kullanıcının seçtiği resim → şarkı adından üretilen renkli kapak (aynı ad hep
aynı renk, `js/cover.js`). Otomatik kapak SVG/CSS ile kodla çizilir; ham resim üretilmez.

## Dosyalar

- `frontend/js/look.js`: görünüm tercihi (erken, `<head>`te çalışan klasik betik; yanıp sönme olmasın).
- `frontend/css/modern.css`: tüm yeni stiller, hepsi `html.ui-new` kapsamında.
- `frontend/js/shell.js`: sekme/küçük oynatıcı saf mantığı (test: `tests/shell_test.mjs`, `tests/look_test.mjs`).
