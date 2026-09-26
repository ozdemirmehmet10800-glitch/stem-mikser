// Ekran kilidini çalarken engeller.
//
// Sekme arkaplana gidince tarayıcı kilidi KENDİLİĞİNDEN bırakıyor, geri
// dönünce yeniden almak gerekiyor - bu yüzden visibilitychange dinleniyor.
// Desteklenmeyen tarayıcıda (iOS Safari'nin eski sürümleri) sessizce atlanır.

export class WakeLock {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
    this.lastError = null;
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  get supported() {
    // "wakeLock" in navigator yetmiyor: özellik var ama değeri undefined
    // olabiliyor. Gerçekten çağrılabilir bir request var mı, ona bakıyoruz.
    return Boolean(navigator.wakeLock && navigator.wakeLock.request);
  }

  get active() {
    return Boolean(this.sentinel) && !this.sentinel.released;
  }

  #onVisibility = () => {
    if (this.wanted && document.visibilityState === "visible" && !this.active) {
      this.request();
    }
  };

  async request() {
    this.wanted = true;
    if (!this.supported || this.active) return this.active;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => {
        // Tarayıcı bıraktı; geri dönüldüğünde yeniden alınacak.
        this.sentinel = null;
      });
      this.lastError = null;
    } catch (error) {
      // Pil tasarrufu açıkken ya da sayfa görünür değilken reddedilebilir.
      this.lastError = error.message;
      this.sentinel = null;
    }
    return this.active;
  }

  async release() {
    this.wanted = false;
    if (!this.sentinel) return;
    try {
      await this.sentinel.release();
    } catch {
      /* zaten bırakılmış olabilir */
    }
    this.sentinel = null;
  }
}
