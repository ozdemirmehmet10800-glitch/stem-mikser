// Metronom.
//
// Tık sesi burada ÜRETİLİYOR (kısa gürültü patlaması + hızlı sönen zarf),
// dosya indirilmiyor.
//
// Zamanlama rAF ile YAPILMIYOR: rAF sekme arkaplandayken yavaşlıyor ve tık
// kayıyor. Bunun yerine ileriye bakan bir zamanlayıcı - her SCHEDULE_EVERY
// ms'de uyanıp LOOKAHEAD saniyelik ilerisini AudioContext saatine yazıyor.
// Web Audio kendi saatiyle çaldığı için JavaScript gecikse bile tık kaymıyor.
//
// LOOKAHEAD ctx saniyesi cinsinden, yani hız 1.5x iken 0.18, 0.5x iken 0.06
// şarkı saniyesine karşılık geliyor - ikisi de zamanlayıcı aralığından (25 ms)
// büyük, dolayısıyla esnetme açıkken de tık atlanmıyor.

const SCHEDULE_EVERY = 25;   // ms, zamanlayıcı uyanma aralığı
const LOOKAHEAD = 0.12;      // sn, ne kadar ileriyi yazıyoruz
const CLICK_LENGTH = 0.03;   // sn

export const SUBDIVISIONS = [
  [0.5, "0.5x"],
  [1, "1x"],
  [2, "2x"],
];

export class Metronome {
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.volume = 0.6;
    this.pan = 0;
    this.subdivision = 1;
    this.beats = [];
    this.downbeats = new Set();
    this.ticks = [];        // {time, accent}
    this.nextIndex = 0;
    // A-B döngüde: hangi turdayız (0 = ilk geçiş) ve motorun hangi çıpa
    // dönemini (engine.epoch) gördük. Dönem değişince (başlatma, döngü
    // kurma/kapama) tur ve indeks motordan yeniden alınıyor.
    this.turn = 0;
    this.epoch = -1;
    this.lastAt = -Infinity;   // en son zamanlanan tıkın ctx anı (çift tık engeli)
    this.timer = null;
    this.gain = null;
    this.panner = null;
    this.noise = null;      // paylaşılan gürültü tamponu
  }

  setGrid(beats, downbeats) {
    this.beats = (beats || []).map(Number).filter(Number.isFinite);
    this.downbeats = new Set((downbeats || []).map((t) => Number(t).toFixed(3)));
    this.#rebuild();
  }

  setSubdivision(value) {
    this.subdivision = value;
    this.#rebuild();
    this.resync();
  }

  // Alt bölüm: 0.5x vuruşun birini atlar, 2x aralara ara nokta ekler.
  #rebuild() {
    const beats = this.beats;
    const isAccent = (i) => this.downbeats.has(beats[i].toFixed(3));

    if (this.subdivision === 0.5) {
      // Yarım hız. Hangi vuruşların atlanacağını ilk DOWNBEAT'e göre
      // hizalıyoruz; yoksa ölçü başı atlanıp metronom ters düşüyor.
      let phase = 0;
      for (let i = 0; i < beats.length; i += 1) {
        if (isAccent(i)) { phase = i % 2; break; }
      }
      this.ticks = beats
        .map((time, i) => ({ time, accent: isAccent(i), index: i }))
        .filter((tick) => tick.index % 2 === phase);
      return;
    }

    const ticks = [];
    for (let i = 0; i < beats.length; i += 1) {
      ticks.push({ time: beats[i], accent: isAccent(i) });
      if (this.subdivision === 2 && i + 1 < beats.length) {
        // Ara nokta hiçbir zaman vurgulu değil.
        ticks.push({ time: (beats[i] + beats[i + 1]) / 2, accent: false });
      }
    }
    this.ticks = ticks;
  }

  #ensureNodes() {
    const ctx = this.engine.ctx;
    if (!ctx || this.gain) return;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    // StereoPannerNode eski Safari'de yok; yoksa doğrudan bağlanıyoruz.
    if (ctx.createStereoPanner) {
      this.panner = ctx.createStereoPanner();
      this.panner.pan.value = this.pan;
      this.gain.connect(this.panner);
      this.panner.connect(ctx.destination);
    } else {
      this.panner = null;
      this.gain.connect(ctx.destination);
    }
    // Gürültü tamponu bir kez üretilip her tıkta yeniden kullanılıyor.
    const frames = Math.ceil(ctx.sampleRate * CLICK_LENGTH);
    this.noise = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      const decay = Math.exp(-28 * (i / frames));
      data[i] = (Math.random() * 2 - 1) * decay;
    }
  }

  setVolume(value) {
    this.volume = value;
    if (this.gain) {
      this.gain.gain.setTargetAtTime(value, this.engine.ctx.currentTime, 0.01);
    }
  }

  setPan(value) {
    this.pan = value;
    if (this.panner) {
      this.panner.pan.setTargetAtTime(value, this.engine.ctx.currentTime, 0.01);
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) {
      this.#ensureNodes();
      this.resync();
      this.start();
    } else {
      this.stop();
    }
  }

  // Seek/duraklat sonrası: şarkı zamanından sonraki ilk tıka atla.
  //
  // CANLI HIZ DEĞİŞİMİNDE ÇAĞIRMAK GEREKMİYOR: nextIndex şarkı zamanındaki
  // bir indeks ve motor konumu sürekli tutuyor; değişen tek şey songToCtx
  // eşlemesi. resync burada çağrılsa tam o anda düşen tık atlanabilir.
  resync() {
    this.lastAt = -Infinity;
    this.#align();
  }

  // Konumdan sonraki ilk tık + motorun tur numarası. lastAt'a DOKUNMAZ: döngü
  // canlı kurulunca ileriye zamanlanmış tıklar yeniden yazılmasın.
  #align() {
    const engine = this.engine;
    this.epoch = engine.epoch;
    this.turn = engine.loop ? engine.currentTurn : 0;
    this.nextIndex = this.#firstIndexAtOrAfter(engine.currentTime);
  }

  #firstIndexAtOrAfter(time) {
    let lo = 0;
    let hi = this.ticks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ticks[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  start() {
    if (this.timer || !this.enabled) return;
    this.#ensureNodes();
    this.timer = setInterval(() => this.#schedule(), SCHEDULE_EVERY);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  #schedule() {
    const engine = this.engine;
    if (!this.enabled || !engine.playing || !engine.ctx) return;
    const ctx = engine.ctx;

    // Şarkı zamanı -> ctx zamanı eşlemesi MOTORDAN geliyor (engine.songToCtx):
    // hız çarpanını ve esneticinin ölçülmüş çıkış gecikmesini içeriyor, yani
    // tıklar esnetilmiş zaman çizgisine oturuyor. Burada kendi hesabımızı
    // yapsak 0.8x'te metronom şarkıdan kopardı.
    //
    // ctx.outputLatency'yi EKLEMİYORUZ: tıklar da stem'lerle aynı çıkıştan
    // geçtiği için o gecikmeyi ikisi birlikte yiyor.
    const horizon = ctx.currentTime + LOOKAHEAD;
    if (this.epoch !== engine.epoch) this.#align();
    const loop = engine.loop;

    for (;;) {
      const tick = this.ticks[this.nextIndex];
      if (loop && (!tick || tick.time >= loop.b)) {
        // Döngü sonu: sonraki tur, döngünün ilk tıkından. Döngüde hiç tık
        // yoksa (çok kısa/ızgarasız) sonsuz dönmesin.
        const first = this.#firstIndexAtOrAfter(loop.a);
        const head = this.ticks[first];
        if (!head || head.time >= loop.b) break;
        this.turn += 1;
        this.nextIndex = first;
        continue;
      }
      if (!tick) break;
      const at = engine.songToCtx(tick.time, loop ? this.turn : 0);
      if (at > horizon) break;
      this.nextIndex += 1;
      if (at <= this.lastAt + 0.0015) continue;
      this.lastAt = at;
      if (at >= ctx.currentTime) this.#click(at, tick.accent);
    }
  }

  #click(when, accent) {
    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    // Downbeat daha tiz ve daha yüksek: kulakla ölçü başı ayırt edilsin.
    source.playbackRate.value = accent ? 1.6 : 1.0;

    const envelope = ctx.createGain();
    envelope.gain.value = accent ? 1.0 : 0.55;

    source.connect(envelope);
    envelope.connect(this.gain);
    source.start(when);
    source.stop(when + CLICK_LENGTH);
    source.onended = () => {
      source.disconnect();
      envelope.disconnect();
    };
  }

  dispose() {
    this.stop();
    this.gain = null;
    this.panner = null;
    this.noise = null;
  }
}
