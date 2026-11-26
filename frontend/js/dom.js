// Ortak DOM yardımcıları (app.js ve js/ui/* bölümleri). Saf; yalnız document'a bakar.

export const el = (id) => document.getElementById(id);

// Eksik bir öğeye olay bağlamak TÜM modül başlatmasını durduruyordu:
// bayat bir HTML (service worker cache'i) ile yeni JS eşleşmezse uygulama
// sessizce hiç açılmıyordu - boş liste, hata mesajı bile yok. Artık eksik
// öğe uyarı basıp geçiyor.
export function on(id, event, handler) {
  const node = document.getElementById(id);
  if (!node) {
    console.warn(`[ui] "${id}" öğesi yok, "${event}" bağlanmadı (bayat HTML?)`);
    return null;
  }
  node.addEventListener(event, handler);
  return node;
}
