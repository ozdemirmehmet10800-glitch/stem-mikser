// Mikrofon yaşam döngüsü (Mikrofon paketi 9; 10. maddede akort aleti de bunu kullanacak): izin, aygıt seçimi, kısıtlar, sızıntı hükmü.
// DOM yok; bağımlılıklar (mediaDevices, permissions, düğüm üretici) dışarıdan verilir, node'da sahte nesnelerle test ediliyor:
//   node tests\mic_flow_test.mjs
//
// KURALLAR (telefon fizibilite sonucundan, bench 0c):
//  - Android Chrome'da VARSAYILAN mikrofon açılınca Bluetooth kulaklık konuşma profiline (HFP) geçip müziği bozuyor ve kapatınca bile
//    düzelmeyebiliyor. Bu yüzden mikrofon HER ZAMAN Bluetooth OLMAYAN dahili aygıttır, `deviceId: {exact}` ile açılır; varsayılan aygıt
//    ASLA müzik için açılmaz. Dahili bulunamazsa mikrofon AÇILMAZ ve nedeni söylenir.
//  - İstisna tek: aygıt etiketleri izinsiz boş geldiği için İLK izin adımı (requestPermission) varsayılan aygıtı BİR KEZ, kısaca açıp hemen
//    kapatır; arayüz bunu önceden açıklar. İzin verildikten sonra etiketler görünür ve dahili aygıt seçilir.
//  - Kısıtlar: yankı engelleme, gürültü bastırma ve otomatik kazanç KAPALI (üçü de sürekli sesli ünlüleri bozar), tek kanal.
//
// GİZLİLİK: mikrofon örnekleri bu dosyada OKUNMAZ (AnalyserNode / getChannelData / ScriptProcessor / MediaRecorder yok); akış doğrudan
// AudioWorklet işlemcisine (pitch-processor.js) bağlanır ve ondan yalnız dört SAYI gelir. Hiçbir şey kaydedilmez, saklanmaz, gönderilmez, loga yazılmaz.

export const BLUETOOTH_LABEL = /bluetooth|\bbt\b|hands-?free|headset|buds|airpods|soundcore|space ?q|q45|earbud|headphone|kulakl/i;
export const BUILTIN_LABEL = /built-?in|internal|dahili|phone|telefon|microphone|mikrofon/i;
export const MIC_CONSTRAINTS = Object.freeze({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 });
export const WORKLET_URL = "js/pitch-processor.js";

export const isBluetoothLabel = (label) => BLUETOOTH_LABEL.test(String(label || ""));

/**
 * enumerateDevices çıktısından DAHİLİ, Bluetooth olmayan mikrofon. Dönen:
 *   {id, label}                               bulundu
 *   {id: null, reason: "no-labels"}           etiketler boş (izin yok): önce izin adımı
 *   {id: null, reason: "no-internal", candidates: [etiketler]}   etiketli mikrofonlar var ama dahili olan yok
 *   {id: null, reason: "no-devices"}          hiç mikrofon yok
 */
export function pickInternalMic(devices) {
  const inputs = (devices || []).filter((device) => device && device.kind === "audioinput");
  if (!inputs.length) return { id: null, reason: "no-devices", candidates: [] };
  if (inputs.every((device) => !device.label)) return { id: null, reason: "no-labels", candidates: [] };
  const usable = inputs.filter((device) => device.label && device.deviceId
    && device.deviceId !== "default" && device.deviceId !== "communications" && !isBluetoothLabel(device.label));
  const internal = usable.find((device) => BUILTIN_LABEL.test(device.label));
  if (internal) return { id: internal.deviceId, label: internal.label };
  return { id: null, reason: "no-internal", candidates: inputs.map((device) => device.label).filter(Boolean) };
}

export function constraintsFor(deviceId) {
  return { audio: { ...MIC_CONSTRAINTS, deviceId: { exact: deviceId } } };
}

/**
 * Sızıntı testi hükmü: sessizken (quietDb) ve müzik çalarken (musicDb) mikrofon seviyesi (dBFS, ortanca). Kullanıcı sessiz kalır.
 * Müzik mikrofona giriyorsa seviye müzikle belirgin yükselir.
 */
export function leakVerdict(quietDb, musicDb) {
  const delta = musicDb - quietDb;
  const leak = delta >= 8 && musicDb >= -62;
  let text;
  if (leak) text = `Müzik mikrofona giriyor (+${delta.toFixed(0)} dB). Kulaklık tak ya da müziğin sesini kıs; yoksa perde algılama müziği izler.`;
  else if (delta >= 4) text = `Hafif sızıntı olabilir (+${delta.toFixed(0)} dB). Sorun görürsen sesi kıs.`;
  else text = "Sızıntı yok: müzik mikrofona girmiyor.";
  return { leak, deltaDb: delta, text };
}

export class Mic {
  /**
   * deps: {mediaDevices, permissions, makeNode(ctx) -> {node, sink?}, workletUrl}. Varsayılanlar tarayıcı nesneleri; testte sahte.
   */
  constructor(deps = {}) {
    this.mediaDevices = deps.mediaDevices !== undefined ? deps.mediaDevices : (typeof navigator !== "undefined" ? navigator.mediaDevices : null);
    this.permissions = deps.permissions !== undefined ? deps.permissions : (typeof navigator !== "undefined" ? navigator.permissions : null);
    this.makeNode = deps.makeNode || ((ctx) => new AudioWorkletNode(ctx, "pitch-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    }));
    this.workletUrl = deps.workletUrl || WORKLET_URL;
    this.loaded = new WeakSet();
    this.reset();
  }

  reset() {
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.ctx = null;
    this.info = null;
  }

  get active() {
    return Boolean(this.stream);
  }

  get supported() {
    return Boolean(this.mediaDevices && this.mediaDevices.getUserMedia && this.mediaDevices.enumerateDevices);
  }

  /** "granted" | "prompt" | "denied" | null (Permissions API yok / mikrofonu desteklemiyor). */
  async permissionState() {
    if (!this.permissions || !this.permissions.query) return null;
    try {
      return (await this.permissions.query({ name: "microphone" })).state;
    } catch {
      return null;
    }
  }

  async listInputs() {
    if (!this.mediaDevices || !this.mediaDevices.enumerateDevices) return [];
    try {
      return (await this.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    } catch {
      return [];
    }
  }

  /**
   * Başlamadan önce durum. status: "unsupported" | "denied" | "needs-permission" | "no-internal" | "ready".
   * Bu çağrı HİÇBİR mikrofonu AÇMAZ (yalnız izin durumu + aygıt listesi).
   */
  async prepare() {
    if (!this.supported) return { status: "unsupported" };
    const permission = await this.permissionState();
    if (permission === "denied") return { status: "denied", permission };
    const devices = await this.listInputs();
    const pick = pickInternalMic(devices);
    if (pick.id) return { status: "ready", permission, device: pick, devices };
    if (pick.reason === "no-labels" || pick.reason === "no-devices") {
      return { status: "needs-permission", permission, devices };
    }
    return { status: "no-internal", permission, devices, candidates: pick.candidates };
  }

  /**
   * İLK İZİN ADIMI (tek istisna): varsayılan aygıtı kısaca açıp HEMEN kapatır; amaç yalnızca tarayıcı iznini almak ve etiketleri
   * görünür kılmak. Arayüz bunu ÖNCEDEN açıklar. Dönen: {ok, error?}.
   */
  async requestPermission() {
    if (!this.supported) return { ok: false, error: "unsupported" };
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      return { ok: false, error: (error && error.name) || "error" };
    }
    for (const track of stream.getTracks()) track.stop();
    return { ok: true };
  }

  /**
   * Dahili mikrofonu açıp perde işlemcisine bağlar. device: pickInternalMic sonucu ({id, label}). onFrame({t, hz, clarity, rmsDb}).
   * Açılan aygıt Bluetooth çıkarsa ya da beklenen aygıt değilse HEMEN kapatılır ve hata atılır.
   */
  async start(ctx, onFrame, device) {
    if (this.active) throw new Error("mic-already-open");
    if (!device || !device.id || device.id === "default" || device.id === "communications") throw new Error("mic-no-device");
    if (isBluetoothLabel(device.label)) throw new Error("mic-bluetooth");
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia(constraintsFor(device.id));
    } catch (error) {
      const wrapped = new Error(`mic-open-failed:${(error && error.name) || "error"}`);
      wrapped.cause = error;
      throw wrapped;
    }
    const track = stream.getAudioTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    const label = (track && track.label) || "";
    const sameDevice = !settings.deviceId || settings.deviceId === device.id;
    if (!track || isBluetoothLabel(label) || !sameDevice) {
      for (const each of stream.getTracks()) each.stop();               // beklenmeyen / Bluetooth aygıt: hemen kapat
      throw new Error(isBluetoothLabel(label) ? "mic-bluetooth" : "mic-unexpected-device");
    }
    try {
      if (!this.loaded.has(ctx)) {
        await ctx.audioWorklet.addModule(this.workletUrl);
        this.loaded.add(ctx);
      }
      const made = this.makeNode(ctx);
      const node = made.node || made;
      node.port.onmessage = (event) => {
        const data = event && event.data;
        if (!data || typeof data.t !== "number") return;
        onFrame({
          t: data.t,
          hz: typeof data.hz === "number" && data.hz > 0 ? data.hz : null,
          clarity: typeof data.clarity === "number" ? data.clarity : 0,
          rmsDb: typeof data.rmsDb === "number" ? data.rmsDb : -120,
        });
      };
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      // İşlemci çıkışsız ama Chrome yalnız hedefe bağlı düğümleri işler: sessiz (kazanç 0) yoldan hedefe bağla.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
      this.stream = stream;
      this.source = source;
      this.node = node;
      this.sink = sink;
      this.ctx = ctx;
    } catch (error) {
      for (const each of stream.getTracks()) each.stop();
      throw error;
    }
    this.info = {
      label,
      deviceId: String(settings.deviceId || device.id).slice(0, 8),
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
      latencyMs: typeof settings.latency === "number" ? Math.round(settings.latency * 1000) : null,
    };
    return this.info;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.node) {
      try { this.node.port.onmessage = null; } catch { /* yok say */ }
      try { this.node.disconnect(); } catch { /* bağlı değildi */ }
    }
    try { if (this.source) this.source.disconnect(); } catch { /* bağlı değildi */ }
    try { if (this.sink) this.sink.disconnect(); } catch { /* bağlı değildi */ }
    this.reset();
  }
}
