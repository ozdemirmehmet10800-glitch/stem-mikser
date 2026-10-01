// Hiza testi için dinleme düğümü (AudioWorkletProcessor).
//
// İki girişi ayrı ayrı izliyor ve eşiği aşan her darbenin ÖRNEK HASSASİYETLİ
// zamanını ana iş parçacığına bildiriyor. Zaman damgası render iş
// parçacığında üretiliyor (currentFrame + blok içi indeks); ana iş
// parçacığındaki gecikme ölçümü bozmuyor.
//
// Giriş 0: motorun master çıkışı (esneticiden geçmiş stem'ler)
// Giriş 1: metronom çıkışı (esneticinin dışında)
//
// Çıkışı sıfır üretiyor ama BAĞLANMASI gerekiyor: destination'a bağlı
// olmayan bir düğüm render grafiğinde çekilmiyor, yani process hiç
// çağrılmıyor.

const MAX_INPUTS = 2;

class TapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = (options && options.processorOptions) || {};
    this.threshold = config.threshold > 0 ? config.threshold : 0.2;
    // Aynı darbenin birden çok örneğini tek olay saymak için ölü zaman.
    this.holdoff = config.holdoffSec > 0 ? config.holdoffSec : 0.15;
    this.running = false;
    this.last = new Float64Array(MAX_INPUTS).fill(-1e9);
    // Dalga kaydı (dikiş çukuru ölçümü): giriş 0'ın ilk `frames` örneği.
    this.capture = null;
    this.captureAt = 0;
    this.captureStart = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "capture") {
        this.capture = new Float32Array(Math.max(1, message.frames | 0));
        this.captureAt = 0;
        this.captureStart = -1;
        return;
      }
      if (message.type === "start") {
        this.running = true;
        this.last.fill(-1e9);
      } else if (message.type === "stop") {
        this.running = false;
      }
    };
  }

  process(inputs, outputs) {
    // Çıkışı her zaman sıfırla (bağlı olduğu için sessiz kalmalı).
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }
    if (this.capture) {
      const input = inputs[0] && inputs[0][0];
      if (this.captureStart < 0) this.captureStart = currentFrame;
      const room = this.capture.length - this.captureAt;
      const count = Math.min(room, 128);
      for (let i = 0; i < count; i += 1) {
        this.capture[this.captureAt + i] = input ? input[i] : 0;
      }
      this.captureAt += count;
      if (this.captureAt >= this.capture.length) {
        const data = this.capture;
        this.capture = null;
        this.port.postMessage(
          { type: "capture", start: this.captureStart / sampleRate, data },
          [data.buffer]
        );
      }
    }

    if (!this.running) return true;

    for (let index = 0; index < MAX_INPUTS; index += 1) {
      const input = inputs[index];
      if (!input || !input.length) continue;
      const channel = input[0];
      if (!channel) continue;
      for (let i = 0; i < channel.length; i += 1) {
        if (Math.abs(channel[i]) < this.threshold) continue;
        const time = (currentFrame + i) / sampleRate;
        if (time - this.last[index] < this.holdoff) continue;
        this.last[index] = time;
        this.port.postMessage({ type: "onset", input: index, time });
      }
    }
    return true;
  }
}

registerProcessor("tap-processor", TapProcessor);
