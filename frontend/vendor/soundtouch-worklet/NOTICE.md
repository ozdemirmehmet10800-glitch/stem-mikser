# @soundtouchjs/audio-worklet 2.1.1

Kaynak : https://www.npmjs.com/package/@soundtouchjs/audio-worklet
Lisans : **MPL-2.0** (paketin kendi `LICENSE` dosyası da alındı)

Not: npm'deki eski `soundtouchjs` paketi **LGPL-2.1**; o KULLANILMIYOR.
Bu paket MPL-2.0 ve depo public olduğu için uygun.

Neden bu kütüphane: `signalsmith-stretch` (MIT) gerçek zamanlı bir
AudioContext'te 4. düğümden itibaren tüm işlemcilerde processorerror atıp
susuyor (offline render'da sorun yok). SoundTouchJS gerçek zamanlıda
8 kanalda bile hatasız.

Depoya alınan dosyalar (değiştirilmedi): index.js, SoundTouchNode.js,
soundtouch-processor.js, processOffline.js, constants.js, package.json,
README.md, LICENSE.
