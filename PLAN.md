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
- Ses okuma/yazma için torchaudio I/O KULLANMA (yeni sürümlerde backend sorunları var). Okurken ffmpeg ile 44.1 kHz stereo float'a çevir, yazarken soundfile veya ffmpeg kullan.
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

## Aşama 6 – İndirme
- Her kanalda indirme menüsü: M4A / FLAC / WAV. Önce download-link iste, sonra imzalı URL'ye yönlendir.
