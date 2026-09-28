// Kilit ekranı kontrolleri (Media Session) + iOS sessiz anahtarı.
//
// Saf Web Audio ile Media Session çoğu platformda çalışmıyor: işletim
// sistemi "çalan bir medya elementi" görmediği için kilit ekranında kontrol
// göstermiyor. Çözüm sessiz, döngüsel bir <audio> elementi çalmak.
//
// Aynı element iOS'ta ikinci bir işi de görüyor: sessiz anahtar açıkken
// Web Audio susturuluyor, ama playsinline bir <audio> çalmak ses oturumunu
// "playback" kipine alıp sesi geri getiriyor.
//
// İkisi de garanti değil; desteklenmeyen yerde sessizce devre dışı kalır.

// Sessiz WAV kodda üretiliyor, ağdan dosya çekilmiyor.
//
// SÜRE EN AZ 10 SANİYE olmalı: Chrome Android 5 saniyeden kısa medyayı
// bildirime almıyor, o yüzden kilit ekranında kontrol çıkmıyordu.
// 8 kHz 8-bit mono ile 10 saniye ~80 KB.
export const KEEPER_SECONDS = 10;

function silentWavBytes(seconds = KEEPER_SECONDS) {
  const rate = 8000;
  const samples = rate * seconds;
  const size = 44 + samples;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, size - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);   // 8 bit
  ascii(36, "data");
  view.setUint32(40, samples, true);
  // 8-bit PCM'de sessizlik 128'dir, 0 değil.
  for (let i = 0; i < samples; i += 1) view.setUint8(44 + i, 128);

  return new Uint8Array(buffer);
}

// Blob URL, data URI değil: base64 dosyayı 1/3 oranında şişiriyor.
function silentWavUrl(seconds = KEEPER_SECONDS) {
  return URL.createObjectURL(new Blob([silentWavBytes(seconds)], { type: "audio/wav" }));
}

export class MediaBridge {
  constructor(engine, { onSeek } = {}) {
    this.engine = engine;
    this.onSeek = onSeek;
    this.keeper = null;
    this.handlersBound = false;
  }

  get supported() {
    return "mediaSession" in navigator;
  }

  // Sessiz elementi kullanıcı hareketiyle başlatmak gerekiyor. play()
  // BU FONKSİYONDA, await'ten ÖNCE çağrılıyor ki tarayıcı jesti kaybetmesin.
  startKeeper() {
    if (!this.keeper) {
      const audio = document.createElement("audio");
      audio.src = silentWavUrl();
      audio.loop = true;
      audio.volume = 0.0001; // tam 0 bazı platformlarda "medya yok" sayılıyor
      audio.setAttribute("playsinline", "");
      audio.setAttribute("aria-hidden", "true");
      audio.style.display = "none";
      document.body.append(audio);
      this.keeper = audio;
    }
    // play() bir Promise döndürüyor ama BEKLEMİYORUZ: await, çağrıyı
    // kullanıcı hareketinin dışına taşıyıp reddedilmesine yol açabiliyor.
    const started = this.keeper.play();
    if (started && started.catch) {
      started.catch(() => {
        // Otomatik oynatma reddedildi; kilit ekranı kontrolleri çıkmayabilir
        // ama uygulamanın geri kalanı etkilenmiyor.
      });
    }
    return started;
  }

  stopKeeper() {
    if (this.keeper) this.keeper.pause();
  }

  setMetadata({ title, artist, album }) {
    if (!this.supported || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: title || "Stem Mikser",
      artist: artist || "",
      album: album || "Stem Mikser",
      artwork: [
        { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  }

  bindHandlers({ onPlay, onPause }) {
    if (!this.supported || this.handlersBound) return;
    const set = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Bu eylemi desteklemiyor; sorun değil.
      }
    };
    set("play", () => onPlay());
    set("pause", () => onPause());
    // visualTime: kilit ekranı kullanıcının DUYDUĞU konumu gösteriyor,
    // ileri/geri de ona göre olsun.
    set("seekbackward", (details) =>
      this.onSeek(this.engine.visualTime - (details.seekOffset || 10)));
    set("seekforward", (details) =>
      this.onSeek(this.engine.visualTime + (details.seekOffset || 10)));
    set("seekto", (details) => {
      if (details.seekTime != null) this.onSeek(details.seekTime);
    });
    set("previoustrack", () => this.onSeek(0));
    this.handlersBound = true;
  }

  setPlaybackState(playing) {
    if (!this.supported) return;
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  updatePosition() {
    if (!this.supported || !navigator.mediaSession.setPositionState) return;
    const duration = this.engine.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        // Hız esnetmesi açıkken kilit ekranı çubuğu da o hızda ilerlemeli;
        // sabit 1 verilirse şarkı ile çubuk birbirinden kopuyor.
        playbackRate: this.engine.playing ? this.engine.rate : 1,
        position: Math.min(Math.max(this.engine.visualTime, 0), duration),
      });
    } catch {
      // Bazı tarayıcılar position > duration'da atıyor; yut.
    }
  }
}

export { silentWavBytes, silentWavUrl };
