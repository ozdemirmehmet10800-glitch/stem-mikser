// Mikrofon perde işlemcisi (AudioWorkletProcessor). Mantık pitch.js'te (saf, testli); burada yalnız ses iş parçacığına bağlantı var.
//
// GİZLİLİK: gelen örnekler YALNIZ PitchTracker.push()'a verilir. Ana iş parçacığına giden tek şey dört SAYIDIR:
//   {t: bağlam saniyesi (pencere ortası), hz: perde ya da null, clarity: 0..1, rmsDb: seviye}
// Örnek dizisi, tampon, dalga biçimi hiçbir yere gönderilmez / saklanmaz / yazılmaz. Çıkış yok (sessiz): mikrofon hoparlöre gitmez.

import { PitchTracker } from "./pitch.js";

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracker = new PitchTracker(sampleRate);
    this.startFrame = -1;                      // akışın ilk örneğinin bağlam çerçeve sırası
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;
    if (this.startFrame < 0) this.startFrame = currentFrame;
    for (const frame of this.tracker.push(channel)) {
      this.port.postMessage({
        t: (this.startFrame + frame.centerSample) / sampleRate,
        hz: frame.hz,
        clarity: frame.clarity,
        rmsDb: frame.rmsDb,
      });
    }
    return true;
  }
}

registerProcessor("pitch-processor", PitchProcessor);
