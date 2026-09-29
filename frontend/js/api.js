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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch YALNIZCA ağ/CORS hatasında TypeError atar; HTTP hata kodları buraya
// düşmez. Ama tarayıcı hangi sebep olduğunu JavaScript'e söylemiyor, bu yüzden
// tek bir sebebe bağlamak yanlış: net::ERR_CONNECTION_CLOSED bir antivirüsün
// (ör. AVG'nin tarayıcı trafiğine karışması), VPN'in ya da güvenlik duvarının
// eseri olabileceği gibi CORS reddi de olabilir. Olası sebepleri sayıyoruz.
function networkError(cause, apiUrl) {
  return new ApiError("Bağlantı kesildi.", {
    kind: "network",
    hint:
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
    const request = () =>
      fetch(this.url + path, {
        ...options,
        headers: { ...this.headers, ...(options.headers || {}) },
      });

    // GET'ler bir kez otomatik yeniden denenir: API boştayken ilk istek soğuk
    // başlangıçta düşebiliyor. Yalnızca GET, çünkü POST/DELETE'i tekrarlamak
    // yan etki doğurur (ikinci kez analiz tetiklemek gibi).
    const retriable = !options.method || options.method.toUpperCase() === "GET";

    let response;
    try {
      response = await request();
    } catch (firstCause) {
      if (retriable) {
        await sleep(RETRY_DELAY_MS);
        try {
          response = await request();
        } catch (secondCause) {
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

  async stemBuffer(id, name, onProgress) {
    const response = await this.#request(`/songs/${id}/stems/${name}.m4a`);
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
