// Katman yığını: geri tuşu ne kapatacak?
//
// Uygulamanın açık "katmanları" (menü, panel, seçim modu, ekran) bir yığın.
// Geri tuşu en üsttekini kapatıyor; yığın boşken hiçbir şey yapmıyor, yani
// tarayıcı uygulamayı normal şekilde kapatıyor.
//
// Bu dosya DOM de history de BİLMİYOR. Bağlamayı app.js yapıyor:
//   katman açıldı  -> push + history.pushState
//   geri geldi     -> back() ne diyorsa o katmanı kapat
//   UI'dan kapatma -> history.back(), yani yol yine buradan geçiyor
// Kapatmanın tek yolunun history olması ŞART: iki ayrı kapatma yolu olsaydı
// history yığını ile katman yığını ayrışır ve geri tuşu "zaten kapalı"
// katmanı kapatmaya çalışıp uygulamadan çıkardı.
//
// Saf olması test edilebilir olmasını da sağlıyor: tests/navstack_test.mjs.

export const CLOSE = "close";
export const BLOCKED = "blocked";
export const EXIT = "exit";

export class NavStack {
  constructor() {
    this.layers = [];
    // Geri'nin yutulacağı durumlar (yükleme örtüsü, hiza testi). Birden fazla
    // olabildiği için küme: biri bırakınca öteki hâlâ tutuyorsa engel sürüyor.
    this.blockers = new Set();
  }

  get depth() {
    return this.layers.length;
  }

  get blocked() {
    return this.blockers.size > 0;
  }

  peek() {
    return this.layers.length ? this.layers[this.layers.length - 1] : null;
  }

  has(name) {
    return this.layers.includes(name);
  }

  /**
   * Katmanı yığına koyar. Aynı ad ikinci kez KOYULMUYOR ve false dönüyor:
   * bir panel açıkken öteki panele geçmek yeni bir katman değil, hâlâ tek
   * bir "panel" katmanı - iki kez yığsaydık geri tuşuna iki kez basmak
   * gerekirdi.
   */
  push(name) {
    if (!name || this.has(name)) return false;
    this.layers.push(name);
    return true;
  }

  block(reason) {
    this.blockers.add(reason);
  }

  unblock(reason) {
    this.blockers.delete(reason);
  }

  /**
   * Geri tuşunun kararı:
   *   {action: BLOCKED} -> hiçbir şey yapma (history girdisi geri konmalı)
   *   {action: CLOSE, layer} -> o katmanı kapat
   *   {action: EXIT} -> yapacak iş yok, uygulama kapanabilir
   * BLOCKED'ta yığın DEĞİŞMİYOR.
   */
  back() {
    if (this.blocked) return { action: BLOCKED, layer: null };
    if (!this.layers.length) return { action: EXIT, layer: null };
    return { action: CLOSE, layer: this.layers.pop() };
  }

  reset() {
    this.layers.length = 0;
    this.blockers.clear();
  }
}
