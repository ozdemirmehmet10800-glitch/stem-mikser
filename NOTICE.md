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

### Mel-Band Roformer Karaoke (becruily) — **LİSANS BELİRSİZ, kişisel kullanım**

Aşama 10 (alt parçalar) vokal ayrımı: ana vokal / arka vokal. Deneyde
kullanılıyor (`backend/app.py::separate_sub`), canlıya BAĞLI DEĞİL.

| | |
|---|---|
| dosya | `mel_band_roformer_karaoke_becruily.ckpt`, 1 719 139 254 bayt |
| sha256 | `d3aa262ac01df870b9fc033e9c7b6cad33fe04fc9c148b6c40841326a515a0e0` |
| config | `config_karaoke_becruily.yaml`, sha256 `cd37b0dcc285fc22d88090415722ac7127ee1d9ea2f3346c3b8d8fcc61e0c74b` |
| indirildiği yer | `becruily/mel-band-roformer-karaoke` (Hugging Face), commit `0c149975cfaa261c7d87baf54330a9da85bcf888` |
| o deponun lisans beyanı | **yok** (model kartı ve lisans metadata'sı boş) |

**Durum olduğu gibi:**

- Depoda lisans beyanı yok. HF'deki "License" tartışmasında (#1, "Under what
  license is this model released?") sahibi şöyle yanıtlamış: *"You can use the
  model freely as long as it's not commercial use."* ve ticari kullanım için
  iletişime geçilmesini istemiş. Yani gayriresmî "ticari olmayan serbest".
  Kontrol tarihi: 2026-10-01.
- Ağırlık **bu depoda dağıtılmıyor**. Çalışma anında yukarıdaki sürümden
  Modal Volume'a iniyor (`fetch_sub_weights`) ve sha256 doğrulanıyor.
- Kullanım **kişisel**. Bu, proje sahibinin bilinçli kararıdır; lisans
  belirsizliği bilinerek kabul edilmiştir. Ticari kullanım ya da yeniden
  dağıtım yok; olacaksa sahibinden yazılı izin gerekir.
- Mimari kodu (`mel_band_roformer.py`) MSST'den, MIT (aşağıya bak).

### MDX23C DrumSep (aufr33 & jarredou) — **LİSANS BELİRSİZ, kişisel kullanım**

Aşama 10 davul alt parçaları (kick / snare / toms / hihat / cymbals / drumsother).
Deneyde kullanılıyor (`backend/app.py::separate_sub`, grup `drums`), canlıya BAĞLI
DEĞİL. Modelin 6 çıkışı: kick, snare, toms, hh, ride, crash; ride + crash
sunucuda tek "cymbals" kanalına toplanıyor, `drumsother` = davul − hepsinin
toplamı.

| | |
|---|---|
| dosya | `aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.ckpt`, 437 652 699 bayt |
| sha256 | `d2a4aa53eb584d21eead358a4e66d1882ad182911be018f052b5da73be9096d0` |
| config | `aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.yaml`, 2 417 bayt, sha256 `440a13f67461b2cdad2bb1cb86c08ff27a8ec53093c4a24d4d7fc2c19cb9f5f5` |
| indirildiği yerler | ckpt: `Sucial/MSST-WebUI` (Hugging Face), commit `90b617b15bd0dc0b784f3d361faca1b51173fe44`, `All_Models/multi_stem_models/`; config: `lainlives/audio-separator-models`, commit `3b39120409f3c2d50e9cc4c391f4169131e9d643` |
| lisans beyanı | **yok**: MSST'nin model listesi (`docs/pretrained_models.md`) lisansı "belirtilmemiş" gösteriyor; her iki aynada da lisans metadata'sı boş |

**Durum olduğu gibi:**

- **Orijinal kaynak SİLİNMİŞ.** MSST dokümanının gösterdiği
  `github.com/jarredou/models/releases/...` adresi, `github.com/jarredou` ve
  `huggingface.co/jarredou` 2026-10-01'de 404 veriyor (SW modeliyle aynı durum,
  yukarıya bak). Lisans metni yazara sorulamıyor.
- **İki bağımsız ayna aynı dosya:** `Sucial/MSST-WebUI` ve
  `lainlives/audio-separator-models` aynı sha256'yı ve aynı boyutu veriyor
  (LFS meta verisi); aynı hash = orijinal dosya, elimizdeki tek kanıt bu.
  Config için ikinci bir bağımsız kopya YOK (yalnız `lainlives`); sha256'sı
  koda gömülü ve her yüklemede doğrulanıyor.
- Ağırlık **bu depoda dağıtılmıyor**. Çalışma anında Modal Volume'a iniyor
  (`fetch_drum_weights`), sha256 doğrulanıyor.
- Kullanım **kişisel**. Bu, proje sahibinin bilinçli kararıdır; lisans
  belirsizliği bilinerek kabul edilmiştir. Ticari kullanım ya da yeniden
  dağıtım için lisansın netleşmesi gerekir.
- Mimari kodu (`models/mdx23c_tfc_tdf_v3.py`) MSST'den, MIT, depoda
  (`backend/vendor/msst/`, pinli commit, sha256'sı oradaki README'de).

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
