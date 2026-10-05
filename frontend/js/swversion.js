// Çalışan service worker'ın sürümü (Ayarlar'da "Sürüm: SW vNN"). SAF mantık, node ile test ediliyor: node tests\swversion_test.mjs
//
// Asıl kaynak: sayfayı denetleyen worker'a "surum" mesajı (sw.js VERSION'ı MessageChannel ile yanıtlar). Worker eski bir sürümse (mesajı
// bilmiyorsa) ya da yanıt gelmezse kabuk cache'inin adından (stem-mikser-vNN) okunur; o durumda "(önbellekten)" yazılır.

const VERSION_RE = /^v\d{1,6}$/;
const SHELL_RE = /^stem-mikser-(v\d{1,6})$/;

/** Cache adlarından en yüksek kabuk sürümü ("v54") ya da null. stems-v1 / share-v1 gibi uygulama cache'leri sayılmaz. */
export function shellVersionFromKeys(keys) {
  let best = null;
  for (const key of keys || []) {
    const match = SHELL_RE.exec(String(key));
    if (match && (best === null || Number(match[1].slice(1)) > Number(best.slice(1)))) best = match[1];
  }
  return best;
}

/** Worker'a sorar; yanıt gelmezse (timeout) ya da geçersizse null. */
export function askWorker(worker, { timeoutMs = 1500, makeChannel = () => new MessageChannel() } = {}) {
  return new Promise((resolve) => {
    if (!worker || typeof worker.postMessage !== "function") {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(typeof value === "string" && VERSION_RE.test(value) ? value : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const channel = makeChannel();
      channel.port1.onmessage = (event) => finish(event.data);
      worker.postMessage("surum", [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/** Ayarlar satırı. controller: navigator.serviceWorker.controller; cacheKeys: () => Promise<string[]>. */
export async function versionLabel({ controller, cacheKeys, timeoutMs, makeChannel } = {}) {
  const live = await askWorker(controller, { timeoutMs, makeChannel });
  if (live) return `Sürüm: SW ${live}`;
  let keys = [];
  try {
    keys = cacheKeys ? await cacheKeys() : [];
  } catch {
    keys = [];
  }
  const cached = shellVersionFromKeys(keys);
  if (cached) return `Sürüm: SW ${cached} (önbellekten)`;
  return "Sürüm: SW bilinmiyor (service worker çalışmıyor)";
}
