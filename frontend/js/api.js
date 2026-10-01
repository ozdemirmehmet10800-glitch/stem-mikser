// API istemcisi. Hataları TÜRÜNE göre ayırıyor: token hatasıyla ağ hatasını
// karıştırmak klasik zaman kaybı, ikisi çok farklı şeyler.

export class ApiError extends Error {
  constructor(message, { kind = "http", status = 0, hint = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind; // auth | network | notfound | http | config
    this.status = status;
    this.hint = hint;
  }
}

const RETRY_DELAY_MS = 1500;

// Zaman aşımı YANIT BAŞLAYANA kadar geçerli, gövde okuma sınırsız: 10 MB'lık
// bir stem yavaş şebekede uzun sürebilir ve bu normaldir. Ölçmek istediğimiz
// şey "sunucu hiç cevap vermiyor mu". Zaman aşımı olmadan, bağlantı
// reddedilmek yerine ASILI KALIRSA (zayıf şebeke) bekleme sınırsız oluyordu -
// çevrimdışı "sonsuza kadar hazırlanıyor" kusurunun sebebi buydu.
//
// 8 SANİYEYDİ, 30'A ÇIKARILDI (ölçümle): API'nin min_containers'ı yok, yani
// boştayken konteyner kapalı ve ilk istek SOĞUK BAŞLANGICI bekliyor. Sahte
// sunucuyla 12 sn'lik soğuk başlangıç kurulup ölçüldü: 8 sn'de kesilen istek
// yeniden deneniyor ve her açılışa boşuna saniyeler biniyordu; gerçek Modal'da
// yeniden deneme hâlâ uyanmakta olan konteynere denk gelirse ikinci kez
// kesilip HATA veriyor. Soğuk başlangıç meşru bir bekleme, kesilmemeli.
const RESPONSE_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// navigator.onLine YALNIZCA NEGATİF yönde güvenilir: false ise gerçekten ağ
// yok. true olması internet olduğunu KANITLAMIYOR (internetsiz bir Wi-Fi da
// true der), o yüzden tek başına ona güvenilmiyor - asıl kapı zaman aşımı.
export function isDefinitelyOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function offlineError() {
  return new ApiError("İnternet yok.", {
    kind: "offline",
    hint: "Cihaz çevrimdışı. Telefonda kayıtlı şarkılar açılabilir.",
  });
}

// fetch YALNIZCA ağ/CORS hatasında TypeError atar; HTTP hata kodları buraya
// düşmez. Ama tarayıcı hangi sebep olduğunu JavaScript'e söylemiyor, bu yüzden
// tek bir sebebe bağlamak yanlış: net::ERR_CONNECTION_CLOSED bir antivirüsün
// (ör. AVG'nin tarayıcı trafiğine karışması), VPN'in ya da güvenlik duvarının
// eseri olabileceği gibi CORS reddi de olabilir. Olası sebepleri sayıyoruz.
function networkError(cause, apiUrl) {
  // UZUN TANI METNİ YALNIZCA İNTERNET VARKEN: cihaz çevrimdışıyken
  // "antivirüs / VPN / ALLOWED_ORIGINS" listesi hem yanlış hem korkutucu.
  if (isDefinitelyOffline()) return offlineError();
  const timedOut = cause && cause.name === "AbortError";
  return new ApiError(timedOut ? "Sunucu yanıt vermedi." : "Bağlantı kesildi.", {
    kind: "network",
    hint:
      (timedOut
        ? `Sunucu ${RESPONSE_TIMEOUT_MS / 1000} saniyede yanıt vermedi.\n`
        : "") +
      `Sunucuya ulaşılamadı. Olası sebepler:\n` +
      `• Antivirüs / VPN / güvenlik duvarı tarayıcı trafiğine karışıyor\n` +
      `  (aynı adres curl veya başka bir tarayıcıda çalışıyorsa sebep büyük\n` +
      `   olasılıkla budur)\n` +
      `• API'nin ALLOWED_ORIGINS ayarı bu sayfanın adresini içermiyor\n` +
      `• API adresi yanlış ya da sunucu yanıt vermiyor\n\n` +
      `Bu sayfanın adresi: ${location.origin}\n` +
      `API adresi: ${apiUrl || "(boş)"}\n` +
      `Tarayıcı ayrıntısı: ${cause && cause.message ? cause.message : cause}`,
  });
}

export class Api {
  constructor(settings) {
    this.url = (settings.url || "").replace(/\/+$/, "");
    this.token = settings.token || "";
  }

  get headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async #request(path, options = {}) {
    if (!this.url || !this.token) {
      throw new ApiError("API adresi veya token ayarlı değil.", { kind: "config" });
    }
    const request = async () => {
      if (isDefinitelyOffline()) throw offlineError();
      // AbortController yalnız YANITIN BAŞLAMASINI sınırlıyor; yanıt gelince
      // sayaç iptal ediliyor, gövde okuma sınırsız.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);
      // Dışarıdan iptal (arka plan indirmesi duraklatılınca): gövde okunurken
      // de geçerli, yoksa duraklatma bir sonraki stem'e kadar beklerdi -
      // telefonda bir stem 10-20 saniye sürebiliyor.
      const outside = options.signal;
      const forward = () => controller.abort();
      if (outside) {
        if (outside.aborted) controller.abort();
        else outside.addEventListener("abort", forward, { once: true });
      }
      try {
        return await fetch(this.url + path, {
          ...options,
          signal: controller.signal,
          headers: { ...this.headers, ...(options.headers || {}) },
        });
      } finally {
        clearTimeout(timer);
        if (outside) outside.removeEventListener("abort", forward);
      }
    };

    // GET'ler bir kez otomatik yeniden denenir: API boştayken ilk istek soğuk
    // başlangıçta düşebiliyor. Yalnızca GET, çünkü POST/DELETE'i tekrarlamak
    // yan etki doğurur (ikinci kez analiz tetiklemek gibi).
    const retriable = !options.method || options.method.toUpperCase() === "GET";

    let response;
    try {
      response = await request();
    } catch (firstCause) {
      // Çevrimdışıyken yeniden denemenin anlamı yok, bekleme boşuna uzar.
      if (firstCause instanceof ApiError) throw firstCause;
      // ZAMAN AŞIMINDA DA YENİDEN DENENMİYOR: sunucu 30 saniyede cevap
      // vermediyse aynı isteği tekrarlamak beklemeyi ikiye katlamaktan başka
      // bir şey yapmıyor. Yeniden deneme, ANINDA düşen bağlantı için (soğuk
      // başlangıçta kapı hiç açılmamış olabiliyor).
      if (firstCause && firstCause.name === "AbortError") {
        throw networkError(firstCause, this.url);
      }
      if (retriable) {
        await sleep(RETRY_DELAY_MS);
        try {
          response = await request();
        } catch (secondCause) {
          if (secondCause instanceof ApiError) throw secondCause;
          throw networkError(secondCause, this.url);
        }
      } else {
        throw networkError(firstCause, this.url);
      }
    }

    if (response.status === 401) {
      throw new ApiError("Token kabul edilmedi.", {
        kind: "auth",
        status: 401,
        hint: "Ayarlar ekranından token'ı kontrol et.",
      });
    }
    if (response.status === 404) {
      throw new ApiError("Bulunamadı.", { kind: "notfound", status: 404 });
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body && body.detail ? String(body.detail) : "";
      } catch {
        /* gövde JSON değilse önemli değil */
      }
      throw new ApiError(detail || `Sunucu hatası (HTTP ${response.status})`, {
        kind: "http",
        status: response.status,
      });
    }
    return response;
  }

  async health() {
    return (await this.#request("/health")).json();
  }

  async listSongs() {
    const data = await (await this.#request("/songs")).json();
    return data.songs || [];
  }

  async getSong(id) {
    return (await this.#request(`/songs/${id}`)).json();
  }

  async stemBuffer(id, name, onProgress, signal = null) {
    return this.#fetchAudio(`/songs/${id}/stems/${name}.m4a`, onProgress, signal);
  }

  // Alt parça (Aşama 10): `lead` | `backing`. Ana stem'lerle aynı indirme yolu.
  async subStemBuffer(id, name, onProgress, signal = null) {
    return this.#fetchAudio(`/songs/${id}/substems/${name}.m4a`, onProgress, signal);
  }

  // Bir ana kanalı alt parçalara ayırır (istek üzerine, GPU): group = "vocals" | "drums".
  // Dönen `state`: "running" | "no_vocals" | "no_drums" | "done" | "unreliable" (+ existing: true).
  async startSub(id, group = "vocals") {
    return (await this.#request(
      `/songs/${encodeURIComponent(id)}/sub?group=${encodeURIComponent(group)}`,
      { method: "POST" })).json();
  }

  async #fetchAudio(path, onProgress, signal) {
    const response = await this.#request(path, signal ? { signal } : {});
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body || !total || !onProgress) {
      return response.arrayBuffer();
    }
    // İlerleme gösterebilmek için parça parça okuyoruz.
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received / total);
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged.buffer;
  }

  async downloadLink(id, name, format) {
    const path = `/songs/${id}/download-link?name=${encodeURIComponent(name)}` +
      `&format=${encodeURIComponent(format)}`;
    return (await this.#request(path, { method: "POST" })).json();
  }

  /** Tek şarkıyı siler. Olmayan kimlik hata değil: {deleted:false} döner. */
  async deleteSong(id) {
    const path = `/songs/${encodeURIComponent(id)}`;
    return (await this.#request(path, { method: "DELETE" })).json();
  }

  /** Çoklu silme. Kısmi başarı normal: her kimlik için ayrı `outcome`. */
  async deleteSongs(ids) {
    const response = await this.#request("/songs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    return response.json();
  }

  /** Ayrıştırmayı yeniden koşturur; akor ve vuruşa dokunmaz. */
  async reprocess(id, quality = "hifi") {
    const path = `/songs/${encodeURIComponent(id)}/reprocess` +
      `?quality=${encodeURIComponent(quality)}`;
    return (await this.#request(path, { method: "POST" })).json();
  }

  // Yükleme: fetch yükleme ilerlemesi vermediği için XHR.
  uploadSong(file, onProgress, quality = "hifi") {
    return new Promise((resolve, reject) => {
      if (!this.url || !this.token) {
        reject(new ApiError("API adresi veya token ayarlı değil.", { kind: "config" }));
        return;
      }
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("quality", quality);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.url + "/songs");
      xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);

      xhr.upload.onprogress = (event) => {
        if (onProgress && event.lengthComputable) {
          onProgress(event.loaded / event.total);
        }
      };
      xhr.onerror = () =>
        reject(networkError(new Error("XHR baglanti hatasi"), this.url));
      xhr.onload = () => {
        if (xhr.status === 401) {
          reject(new ApiError("Token kabul edilmedi.", { kind: "auth", status: 401 }));
          return;
        }
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* yok say */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
        } else {
          reject(new ApiError(
            (body && body.detail) || `Yükleme başarısız (HTTP ${xhr.status})`,
            { kind: "http", status: xhr.status }
          ));
        }
      };
      xhr.send(form);
    });
  }
}
