// Web Audio motoru.
//
// AudioBufferSourceNode tek kullanımlık: play/pause/seek her seferinde altı
// kaynağı yeniden kuruyor. Hepsi AYNI ctx zamanında ve AYNI playbackRate ile
// başlatıldığı için tek AudioContext içinde örnek hassasiyetinde hizalı
// kalıyorlar.
//
// Zincir, esnetici kapalıyken (varsayılan):
//   source -> gainNode -> master -> destination
// Esnetici açıkken TEK düğüm, toplama bus'ında (bkz. stretch.js):
//   source -> gainNode -> bus -> SoundTouchNode -> master -> destination
//
// ZAMAN EŞLEMESİ. Üç ayrı zaman var, karıştırılmamalı:
//   currentTime  esneticiden ÇIKMIŞ olanın şarkı konumu. Metronomun
//                zamanlaması, duraklatma çıpası ve bitiş kontrolü bunu
//                kullanıyor. latency = düğümün İÇERİK gecikmesi, yani
//                girişe t anında girenin çıkışa t + latency'de çıkması.
//   visualTime   KULAĞA GİDENİN konumu; currentTime eksi ctx.outputLatency.
//                Yalnızca görsel imleç (akor şeridi, süre çubuğu) için.
//                Metronoma eklenmiyor: tıklar da aynı çıkıştan geçtiği için
//                stem'lerle birlikte gecikiyorlar.
//   songToCtx()  şarkı zamanından ctx saatine; metronom ileriye bakan
//                zamanlayıcısında bunu kullanıyor.

import {
  MIN_RATE, MAX_RATE, MAX_SEMITONES, DEFAULT_STRETCHER, FALLBACK_STRETCHER,
  isBypass, registerModule, createNode, updateNode, startNode,
  supportsFormants, normalizeStretcher,
} from "./stretch.js";
import { AUDIO_SAVE, normalizeAudioMode } from "./settings.js";

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

// Mobilde bellek: 6 stem x 4 dk x 44,1 kHz x 2 kanal x 4 bayt = 508 MB.
// 32 kHz mono'da aynı şarkı 184 MB. Masaüstünde tam kalite kalıyor.
//
// BU HESAP ÖLÇÜMLE ÇÜRÜDÜ (2026-09-29): telefonda 9.1 dakikalık şarkı Yüksek
// kipte (48 kHz stereo, ~1.25 GB PCM) çökmeden, takılmadan çaldı. Varsayılan
// artık Yüksek; aşağıdaki hız yalnız Tasarruf kipinde kullanılıyor.
//
// Bu artık AYARA bağlı ("Mobil ses kalitesi", settings.js):
//   AUDIO_SAVE -> aşağıdaki hız + mono indirme (varsayılan, bugünkü davranış)
//   AUDIO_HIGH -> hiç zorlama yok, cihazın doğal hızı ve stereo
// 508 MB "fazla" hükmü hesapla verildi, ölçümle DEĞİL; hangi kipin gerçekte
// açıldığını telefonda ölçmek için anahtar gerekiyordu.
export const MOBILE_SAMPLE_RATE = 32000;

// Cihazın DOĞAL çıkış hızı. Zorlamasız bir context açıp okuyoruz; başka
// yoldan öğrenilemiyor. Context hemen kapatılıyor (tarayıcılar aynı anda
// açılabilecek context sayısını sınırlıyor) ve sonuç önbelleğe alınıyor.
let nativeRateCache = 0;

export async function nativeSampleRate() {
  if (nativeRateCache) return nativeRateCache;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return 0;
  let probe = null;
  try {
    probe = new Ctor();
    nativeRateCache = Math.round(probe.sampleRate) || 0;
  } catch {
    nativeRateCache = 0;
  } finally {
    if (probe) {
      try {
        await probe.close();
      } catch {
        /* yok say */
      }
    }
  }
  return nativeRateCache;
}

export function isMobile() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
    return navigator.userAgentData.mobile;
  }
  return window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 1024;
}

// Uyarı eşiği cihaz belleğine göre. deviceMemory yalnızca Chromium'da var;
// yoksa en temkinli değeri alıyoruz.
export function longSongThresholdSec() {
  const memory = navigator.deviceMemory;
  if (memory >= 8) return Infinity;  // 10 dk yükleme sınırına kadar uyarı yok
  if (memory >= 4) return 8 * 60;
  return 6 * 60;
}

export function gainToDb(gain) {
  if (gain <= 0.0001) return "-∞";
  return (20 * Math.log10(gain)).toFixed(1);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
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
    this.mobile = isMobile();
    // Ayar motora app.js'ten geliyor; ilk değer settings.js'teki varsayılan
    // (Yüksek), yoksa kip hiç verilmeyen bir Engine eski davranışa düşerdi.
    this.audioMode = normalizeAudioMode();
    this.monoDownmix = this.mobile && this.audioMode === AUDIO_SAVE;

    // --- esnetme durumu ---
    this.rate = 1;          // 1 = orijinal hız
    this.semitones = 0;     // 0 = orijinal ton
    this.latency = 0;       // esneticinin ölçülmüş çıkış gecikmesi (sn)
    this.bus = null;        // stem'lerin toplandığı gain (yalnız esnetmede)
    this.stretchNode = null;
    this.channelLayout = 2; // bus'ın kanal sayısı; mobilde mono olabilir
    this.stretcher = DEFAULT_STRETCHER;        // istenen
    this.activeStretcher = DEFAULT_STRETCHER;  // gerçekten kurulan
    this.onStretcherFallback = null;           // yedeğe düşünce haber ver
    this.formants = false;  // yalnız destekleyen arka uçta anlamlı
  }

  #forceMobileRate() {
    return this.mobile && this.audioMode === AUDIO_SAVE;
  }

  /** Ayar değişimi. Değiştiyse true döner: context YENİDEN KURULMALI. */
  setAudioMode(mode) {
    const next = normalizeAudioMode(mode);
    if (next === this.audioMode) return false;
    this.audioMode = next;
    this.monoDownmix = this.mobile && next === AUDIO_SAVE;
    return true;
  }

  /**
   * Context'i kapatıp düşürür; bir sonraki ensureContext yenisini kurar.
   *
   * AudioBuffer'lar ait oldukları context'in ÖRNEKLEME HIZINA bağlı, başka
   * bir context'e taşınamıyorlar - bu yüzden kanallar da gidiyor ve şarkı
   * yeniden açılmak zorunda. Sayfa yenilemeye gerek yok.
   */
  async rebuildContext() {
    this.stop();
    this.#disposeChannels();
    this.duration = 0;
    this.offset = 0;
    this.bus = null;
    this.stretchNode = null;
    this.channelLayout = 1;
    const old = this.ctx;
    this.ctx = null;
    this.master = null;
    if (old) {
      try {
        await old.close();
      } catch {
        /* zaten kapalı olabilir */
      }
    }
  }

  /**
   * Çözülmüş tamponları bırakır, context'e dokunmaz.
   *
   * Yeni şarkı açılırken ÖNCE bu çağrılıyor: eskinin PCM'i indirme boyunca
   * bellekte durmasın. setStems zaten kanalları temizliyor ama o ancak altı
   * dosya indikten SONRA çalışıyordu; tepe bellek orada iki şarkıyı birden
   * görüyordu.
   */
  releaseStems() {
    this.stop();
    this.#disposeChannels();
    this.duration = 0;
    this.offset = 0;
    this.channelLayout = 1;
  }

  /**
   * Kanalları bırakır VE gain düğümlerini graftan söker.
   *
   * `channels.clear()` yetmiyordu: context uygulama ömrü boyunca açık kalıyor
   * ve eski şarkının altı gain düğümü master'a bağlı kalıyordu. JS yığını
   * küçük kaldığı için çöp toplayıcının onları topladığı görülmedi (40 açılış,
   * 240 düğüm, 0 toplanma). Hiç beslenmemiş - yani şarkı açılıp ÇALINMADAN
   * çıkılmış - bir gain düğümü her render bloğunda işlenmeye devam ediyor:
   * OfflineAudioContext'te düğüm başına ~85 µs / ses saniyesi ölçüldü
   * (masaüstü; 1000 düğümde %8.5 çekirdek). Telefondaki çarpan ölçülmedi.
   * Çalınmış düğümler kaynakları sökülünce devre dışı kalıyor ve bedelsiz.
   */
  #disposeChannels() {
    for (const channel of this.channels.values()) {
      if (channel.source) {
        try {
          channel.source.onended = null;
          channel.source.stop();
        } catch {
          /* zaten durmuş olabilir */
        }
        try {
          channel.source.disconnect();
        } catch {
          /* bağlı değildi */
        }
        channel.source = null;
      }
      if (channel.gainNode) {
        try {
          channel.gainNode.disconnect();
        } catch {
          /* bağlı değildi */
        }
        channel.gainNode = null;
      }
    }
    this.channels.clear();
  }

  /** Ayarlar ekranı için: şu an gerçekten ne kullanılıyor? */
  audioInfo() {
    let channels = 0;
    for (const channel of this.channels.values()) {
      channels = Math.max(channels, channel.buffer ? channel.buffer.numberOfChannels : 0);
    }
    return {
      mode: this.audioMode,
      mobile: this.mobile,
      forcedRate: this.#forceMobileRate() ? MOBILE_SAMPLE_RATE : 0,
      monoDownmix: this.monoDownmix,
      sampleRate: this.ctx ? this.ctx.sampleRate : 0,
      channels,
      stems: this.channels.size,
    };
  }

  // decodeAudioData mono'ya kendiliğinden indirmiyor, stereo tamponu yine de
  // ayırıyor. Stem'leri TEK TEK çözüp hemen mono'ya indirip stereo tamponu
  // bırakıyoruz: tepe bellek 6 stereo yerine 1 stereo + 6 mono oluyor.
  #toMono(buffer) {
    if (buffer.numberOfChannels === 1) return buffer;
    const mono = this.ctx.createBuffer(1, buffer.length, buffer.sampleRate);
    const target = mono.getChannelData(0);
    const channels = buffer.numberOfChannels;
    for (let channel = 0; channel < channels; channel += 1) {
      const source = buffer.getChannelData(channel);
      for (let i = 0; i < source.length; i += 1) target[i] += source[i] / channels;
    }
    return mono;
  }

  // Autoplay politikası: AudioContext ilk KULLANICI hareketiyle oluşturulmalı
  // ya da resume edilmeli. Masaüstü Chrome'da da geçerli.
  async ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      // sampleRate desteklenmezse (eski Safari) varsayılanla devam et.
      try {
        // Yalnız mobilde ve yalnız tasarruf kipinde hız ZORLANIYOR. "Yüksek"
        // kipte ve masaüstünde parametresiz açılıyor, yani cihazın doğal hızı
        // geliyor ve zincirde fazladan bir yeniden örnekleme olmuyor.
        this.ctx = this.#forceMobileRate()
          ? new Ctor({ sampleRate: MOBILE_SAMPLE_RATE })
          : new Ctor();
      } catch {
        this.ctx = new Ctor();
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(this.ctx.destination);
      // Motor kurulmadan önce yüklenen kanallar varsa şimdi bağla.
      for (const channel of this.channels.values()) {
        if (!channel.gainNode) channel.gainNode = this.ctx.createGain();
      }
      this.#routeChannels();
      this.#applyAllGains(true);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  // --------------------------------------------------------------- zamanlar

  // Çıkış gecikmesi (donanım + karıştırıcı). outputLatency Chrome/Firefox'ta
  // var, Safari'de yok; baseLatency'ye düşüyoruz. Bluetooth kulaklıkta
  // 200 ms'yi bulabiliyor, o yüzden görsel imleçten düşülüyor.
  get outputLatency() {
    if (!this.ctx) return 0;
    const value = Number.isFinite(this.ctx.outputLatency)
      ? this.ctx.outputLatency
      : this.ctx.baseLatency;
    return Number.isFinite(value) ? value : 0;
  }

  get currentTime() {
    if (!this.playing || !this.ctx) return this.offset;
    // Esneticiden çıkan, girişe göre this.latency saniye geride; şarkı
    // zamanı da gerçek zamana göre rate katı hızla akıyor.
    const elapsed = this.ctx.currentTime - this.startedAt - this.latency;
    return clamp(this.offset + elapsed * this.rate, 0, this.duration);
  }

  get visualTime() {
    if (!this.playing || !this.ctx) return this.offset;
    return clamp(this.currentTime - this.outputLatency * this.rate, 0, this.duration);
  }

  // Şarkı zamanı -> ctx saati. currentTime'ın tersi; metronom bunu kullanıyor.
  songToCtx(songTime) {
    if (!this.ctx) return 0;
    return this.startedAt + this.latency + (songTime - this.offset) / this.rate;
  }

  // -------------------------------------------------------- esnetici zinciri

  get stretchActive() {
    return !isBypass(this.rate, this.semitones);
  }

  #stretchOptions() {
    return {
      rate: this.rate,
      semitones: this.semitones,
      // Desteklemeyen arka uçta bayrak hiç gönderilmiyor. GERÇEKTEN kurulan
      // arka uca bakılıyor: yedeğe düşülmüşse formant seçeneği de düşmeli.
      formants: this.formants && supportsFormants(this.activeStretcher),
    };
  }

  /**
   * Esnetici kütüphanesini değiştirir. Düğüm tipi değiştiği için zincir
   * yeniden kurulmak zorunda: çalıyorsa mevcut konuma seek ediliyor.
   */
  async setStretcher(id) {
    const next = normalizeStretcher(id || DEFAULT_STRETCHER);
    if (next === this.stretcher) return;
    this.stretcher = next;
    // Çalmıyorsa bir sonraki play() zaten yeni düğümü kuruyor; activeStretcher
    // orada güncelleniyor. Burada peşin yazmıyoruz ki yedeğe düşme durumunda
    // yanlış bir değer görünmesin.
    if (this.playing && this.stretchActive) await this.seek(this.currentTime);
  }

  /**
   * Formant telafisi. Signalsmith'te canlı uygulanabiliyor (schedule),
   * SoundTouch'ta karşılığı yok - orada ayar sessizce yok sayılıyor.
   */
  async setFormants(on) {
    const next = Boolean(on);
    if (next === this.formants) return;
    this.formants = next;
    if (!this.playing || !this.stretchActive) return;
    if (supportsFormants(this.activeStretcher)) {
      updateNode(this.stretchNode, this.#stretchOptions(), this.activeStretcher,
                 this.ctx.currentTime);
    }
  }

  #routeChannels() {
    if (!this.ctx) return;
    // Esnetici kapalıysa gain'ler DOĞRUDAN master'a gidiyor: varsayılan
    // çalmada zincirde fazladan tek bir düğüm bile yok.
    const target = this.stretchNode || this.master;
    for (const channel of this.channels.values()) {
      if (!channel.gainNode) continue;
      try {
        channel.gainNode.disconnect();
      } catch {
        /* bağlı değildi */
      }
      channel.gainNode.connect(target);
    }
  }

  #teardownStretch() {
    if (this.stretchNode) {
      try {
        this.stretchNode.disconnect();
      } catch {
        /* zaten kopmuş */
      }
      this.stretchNode = null;
    }
    if (this.bus) {
      try {
        this.bus.disconnect();
      } catch {
        /* zaten kopmuş */
      }
    }
  }

  // Düğüm HER çalmada yeniden kuruluyor. Kalıcı tutulsa boru hattında kalan
  // ~150 ms henüz duyulmamış ses, duraklat/seek sonrası yeni konumun başında
  // çalardı; düğümün kendini boşaltan bir mesajı yok.
  async #rebuildStretch() {
    this.#teardownStretch();
    if (!this.stretchActive) {
      this.#routeChannels();
      return;
    }
    if (!this.bus) {
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 1;
    }
    this.stretchNode = await this.#createWithFallback();
    this.bus.connect(this.stretchNode);
    this.stretchNode.connect(this.master);
    this.#routeChannels();
  }

  /**
   * Düğümü kurar; istenen kütüphane yüklenemezse YEDEĞE düşer.
   *
   * Statik kontrol (WebAssembly var mı) normalizeStretcher'da yapılıyor ama
   * yetmiyor: WASM derlemesi, ağ hatası ya da worklet kaydı çalışma anında
   * da patlayabilir. O durumda sessizce susmaktansa SoundTouch'la çalmak
   * iyi. activeStretcher gerçekten kurulan arka ucu tutuyor; update, start
   * ve gecikme ölçümü hep ona bakıyor.
   */
  async #createWithFallback() {
    const wanted = normalizeStretcher(this.stretcher);
    try {
      await registerModule(this.ctx, wanted);
      const node = await createNode(
        this.ctx, this.channelLayout, this.#stretchOptions(), wanted
      );
      this.activeStretcher = wanted;
      return node;
    } catch (error) {
      if (wanted === FALLBACK_STRETCHER) throw error;
      console.warn(
        `[stretch] ${wanted} kurulamadı, ${FALLBACK_STRETCHER} kullanılıyor:`,
        error
      );
      this.activeStretcher = FALLBACK_STRETCHER;
      // #stretchOptions artık activeStretcher'a baktığı için formant
      // bayrağı da kendiliğinden düşüyor.
      await registerModule(this.ctx, FALLBACK_STRETCHER);
      const node = await createNode(
        this.ctx, this.channelLayout, this.#stretchOptions(), FALLBACK_STRETCHER
      );
      if (this.onStretcherFallback) this.onStretcherFallback(wanted, FALLBACK_STRETCHER);
      return node;
    }
  }

  /**
   * Hız ve tonu birlikte uygular.
   *
   * latency: bu ayar için ÖLÇÜLMÜŞ gecikme (stretch.js). Sürükleme sırasında
   * son bilinen değer, kaydırıcı bırakılınca taze ölçüm veriliyor.
   *
   * Bypass sınırı geçilmiyorsa yeniden başlatma YOK: kaynakların
   * playbackRate'i ve düğümün parametreleri canlı değişiyor, ardından duyulan
   * konum sürekli kalacak şekilde yeniden çıpalanıyor.
   */
  async setTempoAndPitch(rate, semitones, latency) {
    const nextRate = clamp(Number(rate) || 1, MIN_RATE, MAX_RATE);
    const nextSemis = clamp(
      Math.round(Number(semitones) || 0), -MAX_SEMITONES, MAX_SEMITONES
    );
    const nowActive = !isBypass(nextRate, nextSemis);
    const nextLatency = nowActive
      ? (Number.isFinite(latency) ? latency : this.latency)
      : 0;

    if (!this.playing) {
      this.rate = nextRate;
      this.semitones = nextSemis;
      this.latency = nextLatency;
      return;
    }

    if (this.stretchActive !== nowActive) {
      // Bypass sınırı geçiliyor: zincir yeniden kurulmak zorunda. Tek
      // yeniden başlatma (ve tek duyulur boşluk) buradan çıkıyor.
      const position = this.currentTime;
      this.stop();
      this.rate = nextRate;
      this.semitones = nextSemis;
      this.latency = nextLatency;
      this.offset = position;
      await this.play();
      return;
    }

    // Yeniden çıpalama, DÜĞÜMÜN İÇİNDEKİ sesi hesaba katarak.
    //
    // Değişim anında düğümden ÇIKAN şarkı konumu ile düğüme GİREN konum
    // aynı değil: aralarında latency saniyelik gerçek zaman, yani
    // latency * rate kadar şarkı zamanı var. Kaynağın hızı anında
    // değişiyor ama düğümdeki bu dolgu eski hızla birikmişti.
    //
    // Kararlı rejimde çıkış(t) = giriş(t - D_yeni) olduğundan doğru çıpa
    // GİRİŞ tarafı: offset = o anda giren konum, startedAt = şimdi.
    //   giren(T) = çıkan(T) + D_eski * hız_eski
    // Bu düzeltilmeden önce offset'e çıkan konum yazılıyordu; fark
    // D_eski*hız_eski - D_yeni*hız_yeni kadar oluyordu ve hiza testi
    // 0.8x -> 1.1x geçişinde tam bunu gösterdi: 0.11*(1.1-0.8) = 33 ms,
    // ölçülen -34 ms.
    const entering = this.currentTime + this.latency * this.rate;

    this.rate = nextRate;
    this.semitones = nextSemis;
    this.latency = nextLatency;
    if (nowActive) {
      updateNode(this.stretchNode, this.#stretchOptions(), this.activeStretcher,
                 this.ctx.currentTime);
      for (const channel of this.channels.values()) {
        if (channel.source) channel.source.playbackRate.value = nextRate;
      }
    }
    this.offset = entering;
    this.startedAt = this.ctx.currentTime;
  }

  resetTempoAndPitch() {
    return this.setTempoAndPitch(1, 0, 0);
  }

  // --------------------------------------------------------------- kanallar

  async setStems(entries) {
    // entries: [{name, arrayBuffer}]
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return this.loadStems(
      entries.map((entry) => entry.name),
      (name) => {
        const entry = byName.get(name);
        const buffer = entry ? entry.arrayBuffer : null;
        if (entry) entry.arrayBuffer = null;   // referansı bırak
        return buffer;
      },
      { concurrency: 1 }
    );
  }

  /**
   * Stem'leri getirip çözer. `provide(name)` ArrayBuffer (ya da onu veren
   * Promise) döndürüyor - getirmenin nereden olduğunu motor bilmiyor.
   *
   * `concurrency`: aynı anda kaç stem getirilip çözülecek. ÖLÇÜLEN pay:
   * açılışın %90'ından fazlası decodeAudioData'da geçiyor (110 sn'lik şarkı,
   * masaüstü: 2593 ms çözme / 253 ms indirme). İkişerli gitmek indirmeyi de
   * çözmenin altına saklıyor.
   *
   * BELLEK - ÖNCEKİ NOT YANLIŞTI, düzeltildi: "Yüksek kipte ara tampon yok"
   * demiştim. Chrome decodeAudioData'yı worker havuzunda koşturuyor
   * (base_audio_context.cc) ve çözme arka planda bir AudioBus üretip ana iş
   * parçacığında AudioBuffer'a KOPYALIYOR - kopya bitene kadar ikisi de
   * bellekte. Yani her eşzamanlı çözme, o stem'in PCM'i kadar GEÇİCİ bellek
   * demek (9 dk / 48 kHz stereo: stem başına ~207 MB). Sınır bu yüzden var;
   * ayarlardan 2/3/6 seçilebiliyor ve hesap orada yazılı.
   *
   * `onStats` verilirse indirme ve çözme süreleri AYRI AYRI toplanıp
   * bildiriliyor: boru hattı ikisini üst üste bindirdiği için duvar saati
   * hangisinin uzadığını söylemiyor, telefonda da tek ölçüm aracımız bu.
   */
  async loadStems(names, provide, options = {}) {
    await this.ensureContext();
    this.stop();
    this.#disposeChannels();
    this.duration = 0;
    this.channelLayout = 1;

    const wanted = [...names];
    const queue = [...names];
    const loaded = new Map();
    const limit = Math.max(1, Math.min(Number(options.concurrency) || 1, queue.length));

    // İndirme ve çözme AYRI toplanıyor (bkz. docstring). Toplamlar duvar
    // saatinden büyük olabilir: işler üst üste biniyor.
    const stats = { fetchMs: 0, decodeMs: 0, bytes: 0 };

    const worker = async () => {
      while (queue.length) {
        const name = queue.shift();
        const fetchStarted = performance.now();
        const arrayBuffer = await provide(name);
        stats.fetchMs += performance.now() - fetchStarted;
        if (!arrayBuffer) continue;
        stats.bytes += arrayBuffer.byteLength || 0;
        const decodeStarted = performance.now();
        let buffer = await this.ctx.decodeAudioData(arrayBuffer);
        stats.decodeMs += performance.now() - decodeStarted;
        if (this.monoDownmix) {
          const stereo = buffer;
          buffer = this.#toMono(stereo);
          void stereo;   // ara tampon burada bırakılıyor
        }
        loaded.set(name, buffer);
        this.duration = Math.max(this.duration, buffer.duration);
        // Esnetici bus'ı stem'lerle aynı kanal sayısında olsun: mobilde mono
        // indirme yapıldığında düğüm boşuna stereo işlemesin.
        this.channelLayout = Math.max(this.channelLayout, buffer.numberOfChannels);
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));

    // Kanal sırası İSTENEN sırada kuruluyor: paralel yüklemede bitiş sırası
    // karışık oluyor, Map'in ekleme sırası da öyle kalırdı.
    for (const name of wanted) {
      const buffer = loaded.get(name);
      if (!buffer) continue;
      this.channels.set(name, {
        buffer,
        gainNode: this.ctx.createGain(),
        fader: 1,
        solo: false,
        mute: false,
        source: null,
      });
    }

    if (options.onStats) {
      options.onStats({
        fetchMs: Math.round(stats.fetchMs),
        decodeMs: Math.round(stats.decodeMs),
        bytes: stats.bytes,
      });
    }

    this.offset = 0;
    this.#routeChannels();
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

  // Master esneticinin ARDINDA: ana ses değişimi gecikmeden duyuluyor.
  // Fader/solo/mute ise ÖNÜNDE, yani esnetici açıkken ~150 ms geç duyuluyor.
  setMaster(value) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(value, this.ctx.currentTime, GAIN_GLIDE);
  }

  // -------------------------------------------------------------- transport

  async play() {
    if (this.playing || !this.channels.size) return;
    await this.ensureContext();

    if (this.offset >= this.duration - 0.01) this.offset = 0;

    await this.#rebuildStretch();

    const startAt = this.ctx.currentTime + START_LEAD;
    // Signalsmith schedule({active:true}) olmadan hiç ses üretmiyor ve
    // kaynaklarla AYNI ana yazılması gerekiyor; SoundTouch'ta bu no-op.
    startNode(this.stretchNode, startAt, this.#stretchOptions(), this.activeStretcher);
    for (const channel of this.channels.values()) {
      const source = this.ctx.createBufferSource();
      source.buffer = channel.buffer;
      // Tempo KAYNAKTAN geliyor, altısı da aynı oranda; esnetici düğümü
      // perdeyi telafi ediyor.
      source.playbackRate.value = this.rate;
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
    // Düğümü de düşürüyoruz: içindeki ~150 ms henüz DUYULMAMIŞ ses, bir
    // sonraki çalmada yanlış konumdan sızardı.
    this.#teardownStretch();
    this.playing = false;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.stop();
  }

  async seek(time) {
    const target = clamp(time, 0, this.duration);
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
    this.#disposeChannels();
    this.bus = null;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.master = null;
    }
  }
}
