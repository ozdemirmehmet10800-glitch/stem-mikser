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

// 1 saniyelik sessiz WAV (44 baytlık başlık + sıfırlar), data URI olarak.
// Ağdan dosya çekmemek için gömülü: 8 kHz mono 8-bit -> ~8 KB base64.
function silentWavDataUri(seconds = 1) {
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

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
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

  // Sessiz elementi kullanıcı hareketiyle başlatmak gerekiyor; play()
  // çağrısından çağrılıyor.
  async startKeeper() {
    if (!this.keeper) {
      const audio = document.createElement("audio");
      audio.src = silentWavDataUri(1);
      audio.loop = true;
      audio.volume = 0.0001; // tam 0 bazı platformlarda "medya yok" sayılıyor
      audio.setAttribute("playsinline", "");
      audio.setAttribute("aria-hidden", "true");
      audio.style.display = "none";
      document.body.append(audio);
      this.keeper = audio;
    }
    try {
      await this.keeper.play();
    } catch {
      // Otomatik oynatma reddedildi; Media Session çalışmayabilir ama
      // uygulamanın geri kalanı etkilenmiyor.
    }
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
    set("seekbackward", (details) =>
      this.onSeek(this.engine.currentTime - (details.seekOffset || 10)));
    set("seekforward", (details) =>
      this.onSeek(this.engine.currentTime + (details.seekOffset || 10)));
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
        playbackRate: 1,
        position: Math.min(Math.max(this.engine.currentTime, 0), duration),
      });
    } catch {
      // Bazı tarayıcılar position > duration'da atıyor; yut.
    }
  }
}

export { silentWavDataUri };
