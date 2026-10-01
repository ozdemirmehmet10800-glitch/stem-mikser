# MSST (Music-Source-Separation-Training) — depoya alınmış dosyalar

Kaynak: [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)
Lisans: **MIT**, Copyright (c) 2024 Roman Solovyev (ZFTurbo) — tam metin
[`LICENSE`](LICENSE) dosyasında (upstream `LICENSE`'ın birebir kopyası,
sha256 `3282dc057695ef5b9a64909a7092ca40b2c292c232580fc6ace6e5d665cc0207`).

Commit **PİNLİ**: `84b1eac0887756b4f1a9d7a1ff49105939749ed2`

## Neden depoda?

Önceden bu dosyalar Modal imajının build aşamasında `curl` ile
raw.githubusercontent.com'dan iniyordu. İki sorun:

1. **Temel imajda `curl` yok** — `fetch_hifi` build'i `/bin/sh: 1: curl: not
   found` (exit 127) ile patladı.
2. Build'in ağa ve GitHub'ın erişilebilirliğine bağlı olması. Commit pinliyken
   içerik zaten sabit; indirmenin bir faydası yok.

Şimdi dosyalar depoda ve imaja `add_local_dir` ile giriyor: build sırasında
**hiç ağ erişimi yok**, MIT lisansı da hangi sürümü kullandığımızla birlikte
görünür durumda.

## Dosyalar ve orijinal sha256'ları

Aşağıdaki hash'ler dosyaların **başlık eklenmeden önceki**, upstream'den
inen halinin hash'leridir. Her dosyanın başına kaynağı/commit'i/lisansı
yazan bir yorum bloğu eklendi; içerik bunun dışında yalnızca `attend.py`'de
değişti (aşağıda).

| dosya | bayt | sha256 (orijinal) |
|---|---|---|
| `models/bs_roformer/attend.py` | 4410 | `c7abbc40a3fd20ff7f6001fa9f8ee9ad5df6452272712a5e719b8f8468bf2223` |
| `models/bs_roformer/bs_roformer.py` | 20494 | `a6f670325cdb8a7a212914f62602119b23eb888df9bcfe4a85f9be74728b3ef4` |
| `models/bs_roformer/mel_band_roformer.py` | 22532 | `3b4a57ab268933900172e05fb76dd9e8acc1eb770c745d583a4e42b94b79ec15` |
| `models/mdx23c_tfc_tdf_v3.py` | 7121 | `5b29c37cbba4b06e49dcd6bef668d372501df2517392b71b93804355cb7d535e` |
| `utils/model_utils.py` | 39219 | `5cd24dac438ebc8243fb5b19e71296f1eb113b1181b607d085ae4f74fa333a86` |

`__init__.py` dosyaları upstream'den DEĞİL, bizim yazdığımız boş dosyalardır:
MSST'nin kendi `models/__init__.py`'si tüm model ailelerini import ediyor ve
imajda kurulu olmayan paketleri çekiyor.

Hangi dosyayı kim kullanıyor:

| dosya | kullanan |
|---|---|
| `attend.py` | `bs_roformer.py` ve `mel_band_roformer.py` import ediyor |
| `bs_roformer.py` | canlı Hi-Fi vokal yolu (`app.py`) + deney B/C kolları |
| `mel_band_roformer.py` | yalnız deney (`experiment.py`, A ve E kolları) + vokal alt ayrımı (`separate_sub`, becruily karaoke) |
| `mdx23c_tfc_tdf_v3.py` | davul alt ayrımı (`separate_sub`, DrumSep MDX23C). `utils.model_utils.prefer_target_instrument` ve `ml_collections.ConfigDict` ister |
| `utils/model_utils.py` | yalnız deney (`experiment.py::reference`) |

## `attend.py`'deki tek değişiklik: torch 2.5.1 uyumu

Pinli commit `sdpa_kernel(INFERENCE_SDPA_BACKENDS, set_priority=True)`
çağırıyor. `set_priority` kwarg'ı **torch 2.6'da** eklendi; imajda **torch
2.5.1** var ve orada `TypeError` atıp çıkarımı ilk parçada düşürüyor.

Torch YÜKSELTİLMİYOR: 2.5.1 demucs yüzünden bilinçli pinli (2.6
`torch.load` varsayılanını `weights_only=True` yaptı ve demucs'un checkpoint
yükleyicisini kırabiliyor). Hi-Fi yolunun ikinci aşaması demucs olduğu için
yükseltmek asıl riski oraya taşırdı.

Değişiklik: çağrı `_sdpa_kernel_compat()` sarmalayıcısına alındı, sarmalayıcı
`TypeError`'da kwarg'sız deniyor. Bayrak yalnızca arka uç **öncelik ipucu** —
matematiği değiştirmiyor, düşürülmesi sonucu etkilemiyor, yeni bir torch'ta
ipucu kendiliğinden geri kazanılıyor. Dosyada `stem-mikser yaması` yorumlarıyla
işaretli; eskiden bu yama build/çalışma anında metin değiştirerek
uygulanıyordu, artık depodaki dosyada doğrudan görünüyor.

`attend.py`'yi hem `bs_roformer` hem `mel_band_roformer` import ediyor, yani
tek yama her iki yolu birden düzeltiyor. Üç MSST model dosyasında başka
torch 2.6+ API'si tarandı, yok.

## Güncelleme tarifi

Pinli commit'i değiştirmek gerekirse:

1. `app.py`/`experiment.py` içindeki `MSST_SHA`'yı güncelle.
2. Dosyaları yeni commit'ten indir, yukarıdaki hash tablosunu yenile.
3. `attend.py` yamasını elden geçir — upstream `set_priority`'yi kendisi
   koşullu hale getirmiş olabilir, o zaman yama gereksizdir.
4. Başlık bloklarını yeni commit hash'iyle güncelle.
