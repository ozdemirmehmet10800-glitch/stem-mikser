// Web Audio motoru.
//
// AudioBufferSourceNode tek kullanımlık: play/pause/seek her seferinde altı
// kaynağı yeniden kuruyor. Hepsi AYNI ctx zamanında başlatıldığı için tek
// AudioContext içinde örnek hassasiyetinde hizalı kalıyorlar.

export const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"];

export const STEM_LABELS = {
  vocals: "Vokal",
  drums: "Davul",
  bass: "Bas",
  guitar: "Gitar",
  piano: "Piyano",
  other: "Diğer",
};

const START_LEAD = 0.08; // planlama payı (sn)
const GAIN_GLIDE = 0.012; // setTargetAtTime zaman sabiti; tık sesi olmasın

export function gainToDb(gain) {
  if (gain <= 0.0001) return "-∞";
  return (20 * Math.log10(gain)).toFixed(1);
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.channels = new Map(); // name -> {buffer, gainNode, fader, solo, mute, source}
    this.playing = false;
    this.offset = 0;       // duraklatıldığında nerede kaldık
    this.startedAt = 0;    // ctx.currentTime cinsinden başlangıç anı
    this.duration = 0;
    this.onEnded = null;
  }

  // Autoplay politikası: AudioContext ilk KULLANICI hareketiyle oluşturulmalı
  // ya da resume edilmeli. Masaüstü Chrome'da da geçerli.
  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
      // Motor kurulmadan önce yüklenen kanallar varsa şimdi bağla.
      for (const channel of this.channels.values()) {
        if (!channel.gainNode) {
          channel.gainNode = this.ctx.createGain();
          channel.gainNode.connect(this.master);
        }
      }
      this.#applyAllGains(true);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  get currentTime() {
    if (!this.playing || !this.ctx) return this.offset;
    const elapsed = this.ctx.currentTime - this.startedAt;
    return Math.min(Math.max(this.offset + elapsed, 0), this.duration);
  }

  async setStems(entries) {
    // entries: [{name, arrayBuffer}]
    await this.ensureContext();
    this.stop();
    this.channels.clear();
    this.duration = 0;

    for (const entry of entries) {
      // decodeAudioData ArrayBuffer'ı tüketir; kopya vermiyoruz çünkü her
      // stem'i bir kez çözüyoruz.
      const buffer = await this.ctx.decodeAudioData(entry.arrayBuffer);
      const gainNode = this.ctx.createGain();
      gainNode.connect(this.master);
      this.channels.set(entry.name, {
        buffer,
        gainNode,
        fader: 1,
        solo: false,
        mute: false,
        source: null,
      });
      this.duration = Math.max(this.duration, buffer.duration);
    }
    this.offset = 0;
    this.#applyAllGains(true);
    return this.duration;
  }

  get anySolo() {
    for (const channel of this.channels.values()) {
      if (channel.solo) return true;
    }
    return false;
  }

  // Mute HER ZAMAN öncelikli; solo varsa yalnızca solo kanallar duyulur.
  isAudible(name) {
    const channel = this.channels.get(name);
    if (!channel) return false;
    if (channel.mute) return false;
    if (this.anySolo && !channel.solo) return false;
    return true;
  }

  #effectiveGain(name) {
    const channel = this.channels.get(name);
    if (!channel) return 0;
    return this.isAudible(name) ? channel.fader : 0;
  }

  #applyAllGains(immediate = false) {
    if (!this.ctx) return;
    for (const name of this.channels.keys()) {
      const channel = this.channels.get(name);
      if (!channel.gainNode) continue;
      const target = this.#effectiveGain(name);
      if (immediate) {
        channel.gainNode.gain.value = target;
      } else {
        channel.gainNode.gain.setTargetAtTime(target, this.ctx.currentTime, GAIN_GLIDE);
      }
    }
  }

  setFader(name, value) {
    const channel = this.channels.get(name);
    if (!channel) return;
    channel.fader = value;
    this.#applyAllGains();
  }

  toggleSolo(name) {
    const channel = this.channels.get(name);
    if (!channel) return;
    channel.solo = !channel.solo;
    this.#applyAllGains();
  }

  toggleMute(name) {
    const channel = this.channels.get(name);
    if (!channel) return;
    channel.mute = !channel.mute;
    this.#applyAllGains();
  }

  setMaster(value) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(value, this.ctx.currentTime, GAIN_GLIDE);
  }

  async play() {
    if (this.playing || !this.channels.size) return;
    await this.ensureContext();

    if (this.offset >= this.duration - 0.01) this.offset = 0;

    const startAt = this.ctx.currentTime + START_LEAD;
    for (const channel of this.channels.values()) {
      const source = this.ctx.createBufferSource();
      source.buffer = channel.buffer;
      source.connect(channel.gainNode);
      // Altısı da AYNI startAt ile başlıyor -> aralarında sürüklenme yok.
      source.start(startAt, Math.min(this.offset, channel.buffer.duration));
      channel.source = source;
    }
    this.startedAt = startAt;
    this.playing = true;
  }

  stop() {
    for (const channel of this.channels.values()) {
      if (channel.source) {
        try {
          channel.source.onended = null;
          channel.source.stop();
        } catch {
          /* zaten durmuş olabilir */
        }
        channel.source.disconnect();
        channel.source = null;
      }
    }
    this.playing = false;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stop();
  }

  async seek(time) {
    const target = Math.min(Math.max(time, 0), this.duration);
    if (this.playing) {
      this.stop();
      this.offset = target;
      await this.play();
    } else {
      this.offset = target;
    }
  }

  // Şarkı bitti mi? rAF döngüsünden çağrılıyor; onended stop()'ta da
  // tetiklendiği için daha güvenilir.
  checkEnded() {
    if (!this.playing) return false;
    if (this.currentTime < this.duration - 0.02) return false;
    this.stop();
    this.offset = 0; // bitince başa sar
    if (this.onEnded) this.onEnded();
    return true;
  }

  dispose() {
    this.stop();
    this.channels.clear();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
    }
  }
}
