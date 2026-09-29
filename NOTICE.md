# Üçüncü taraf bileşenler ve lisans durumu

Bu dosya, projenin kullandığı üçüncü taraf kod ve model ağırlıklarının
nereden geldiğini ve hangi şartlarla kullanıldığını kayda geçirir.
Kontrol tarihi: **2026-09-29**.

Depo public. Hiçbir model ağırlığı bu depoda dağıtılmıyor; ağırlıklar
çalışma anında kaynağından indiriliyor.

---

## Model ağırlıkları

### htdemucs_6s (Demucs) — MIT

Kod ve ağırlıklar MIT. Ağırlık Modal imajının build aşamasında Demucs'un
kendi dağıtım kanalından iniyor.

### BS-Roformer SW — **LİSANS BİLİNMİYOR**

Hi-Fi vokal yolunda kullanılan checkpoint.

| | |
|---|---|
| dosya | `BS-Rofo-SW-Fixed.ckpt`, 699 412 152 bayt |
| sha256 | `24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e` |
| indirildiği yer | `enerjazzer/BS-ROFO-SW-Fixed` (Hugging Face), commit `a443a2985534b3bc815ef54a5d446c6a0390f974` |
| o deponun lisans beyanı | `unknown` |

**Durum olduğu gibi:**

- Ağırlığın orijinal sahibi `jarredou`; Hugging Face hesabı **silinmiş**
  (2026-09-28'de 404 doğrulandı). Dolayısıyla yazarın koyduğu bir lisans
  metni yok, sonradan da sorulamıyor.
- İki ayna mevcut ve **ikisi de birebir aynı dosya** (aynı sha256, aynı
  boyut): `enerjazzer/BS-ROFO-SW-Fixed` lisansı `unknown` diyor,
  `Blakus/bs_roformer_sw_6stem` ise `mit` diyor. İkincisi üçüncü bir
  kişinin yeniden yüklerken doldurduğu bir alan; **sahip olmadığı bir hakkı
  veremez**. Bu yüzden lisans "bilinmiyor" kabul ediliyor ve kanonik ayna
  olarak `enerjazzer` alınıyor.
- Ağırlık **bu depoda dağıtılmıyor**. Çalışma anında yukarıdaki aynadan
  Modal Volume'a iniyor ve sha256 doğrulanıyor.
- Kullanım **kişisel**. Bu, proje sahibinin bilinçli kararıdır; lisans
  belirsizliği bilinerek kabul edilmiştir. Ticari kullanım ya da yeniden
  dağıtım için lisansın netleşmesi gerekir.

### Mel-Band Roformer (KimberleyJSN) — MIT, **artık kullanılmıyor**

Aşama 9 deneyinde A yolu için denendi, C yolu kazandığı için devrede değil.
Kayda geçirilmesinin sebebi lisans geçmişinin ilginç olması: depo bir dönem
`gpl-3.0` gösteriyordu (Intel'in talebiyle eklenmişti; Intel'in openvino
kopyası hâlâ öyle diyor), yazar sonradan MIT'e çevirmiş. 2026-09-28'de
kontrol edilen güncel metadata `mit`, commit
`ac9b0614ab3cd7f77219e18ba494dfd93956c348`.

---

## Kod

### Music-Source-Separation-Training (ZFTurbo) — MIT

BS-Roformer mimarisi buradan. Commit
`84b1eac0887756b4f1a9d7a1ff49105939749ed2`'ye **pinli**. Gerçek `LICENSE`
dosyası var, MIT.

Dört dosya **bu depoda dağıtılıyor** (kod MIT olduğu için buna izin var;
lisans metni ve telif bildirimi yanında duruyor):
`backend/vendor/msst/` altında `models/bs_roformer/attend.py`,
`bs_roformer.py`, `mel_band_roformer.py` ve `utils/model_utils.py`; upstream
`LICENSE`'ın birebir kopyası da orada. Ayrıntı, dosya başına orijinal
sha256'lar ve güncelleme tarifi: `backend/vendor/msst/README.md`.
Modal imajına `add_local_dir` ile giriyorlar; **build sırasında ağ erişimi
yok**. (Önceden build'de `curl` ile iniyorlardı — temel imajda curl olmadığı
için build hata veriyordu, ayrıca pinli bir commit'te indirmenin faydası
yoktu.)

`attend.py`'de tek bir uyumluluk değişikliği var ve **depodaki dosyada
görünüyor** (eskiden build/çalışma anında metin değiştirilerek uygulanıyordu):
pinli commit `sdpa_kernel(..., set_priority=True)` çağırıyor, bu kwarg torch
2.6'da eklendi, imajda torch 2.5.1 var (demucs yüzünden bilinçli pinli).
Çağrı `_sdpa_kernel_compat()` sarmalayıcısına alındı; yama yalnızca arka uç
öncelik ipucunu düşürüyor, matematiği değiştirmiyor.

**`KimberleyJensen/Mel-Band-Roformer-Vocal-Model` KULLANILMIYOR:** o depoda
hiçbir LICENSE dosyası yok, yani varsayılan olarak her hakkı saklı.

### signalsmith-stretch — MIT

Ön yüzdeki hız/ton esneticisi. Ayrıntılı not:
`frontend/vendor/signalsmith-stretch/NOTICE.md`.

### SoundTouchJS — MPL-2.0

Yedek esnetici. Ayrıntılı not:
`frontend/vendor/soundtouch-worklet/NOTICE.md`.

### beat_this — bkz. paket lisansı

Vuruş/ölçü takibi. pip paketi olarak kuruluyor, depoda dağıtılmıyor.
