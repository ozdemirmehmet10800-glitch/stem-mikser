// Klipten kapak karesi: videonun ortalarından karanlık/düz olmayan bir kare seçilir, kare (1:1) kırpılıp küçültülür (JPEG). Kapak yalnız bu
// telefonda saklanır (coverstore, kaynak "clip"); sunucuya gitmez. Klibin kendi kapağı varsa (dosya içinde) bu yapılmaz.
// SAF yardımcılar + tarayıcı işlevi captureFrame (DOM, <video> + <canvas>).   node tests\clipframe_test.mjs

export const FRAME_FRACTIONS = [0.35, 0.5, 0.22, 0.65];   // denenecek konumlar (sürenin oranı); intro/son jenerik kaçınılır
export const DARK_LUMA = 0.09;                              // ortalama parlaklık bunun altı: karanlık kare
export const FLAT_SPREAD = 0.035;                           // parlaklık yayılımı bunun altı: düz (tek renk / yazı kartı) kare
const PROBE_PX = 24;

/** Denenecek zamanlar (saniye). Süre bilinmiyorsa (bazı webm) baştan birkaç saniye. */
export function frameTimes(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [1, 4];
  if (duration < 2) return [duration / 2];
  return FRAME_FRACTIONS.map((fraction) => Math.min(Math.max(duration * fraction, 0.5), duration - 0.5));
}

/** Ortadan kare kırpma. */
export function squareCrop(width, height) {
  const size = Math.max(0, Math.min(width, height));
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size };
}

/** RGBA örneğinden ortalama parlaklık ve yayılım (0..1). */
export function frameStats(data) {
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    sum += y;
    squares += y * y;
    count += 1;
  }
  if (!count) return { luma: 0, spread: 0 };
  const luma = sum / count;
  return { luma, spread: Math.sqrt(Math.max(squares / count - luma * luma, 0)) };
}

export const goodFrame = ({ luma, spread }) => luma >= DARK_LUMA && spread >= FLAT_SPREAD;

/** Hiçbir kare "iyi" değilse en iyisi: ayrıntı (yayılım) ve biraz parlaklık. */
export const frameScore = (stats) => (goodFrame(stats) ? 1 : 0) + stats.spread + stats.luma * 0.25;

function waitFor(target, events, ms) {
  return new Promise((resolve) => {
    const handlers = [];
    const finish = (value) => {
      clearTimeout(timer);
      for (const [type, handler] of handlers) target.removeEventListener(type, handler);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    for (const type of events) {
      const handler = (event) => finish(event.type);
      handlers.push([type, handler]);
      target.addEventListener(type, handler);
    }
  });
}

/** Klipten kapak JPEG'i (Blob) ya da null (çözülemedi / görüntü yok / zaman aşımı). Hata atmaz. */
export async function captureFrame(file, { px = 384, loadMs = 12000, seekMs = 5000 } = {}) {
  let url = "";
  const video = document.createElement("video");
  try {
    url = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const loaded = waitFor(video, ["loadeddata", "error"], loadMs);
    video.src = url;
    if (await loaded !== "loadeddata" || !video.videoWidth || !video.videoHeight) return null;
    const crop = squareCrop(video.videoWidth, video.videoHeight);
    const size = Math.max(16, Math.min(px, crop.size));
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const paint = canvas.getContext("2d");
    const probe = document.createElement("canvas");
    probe.width = PROBE_PX;
    probe.height = PROBE_PX;
    const probeCtx = probe.getContext("2d", { willReadFrequently: true });
    let best = -1;
    for (const time of frameTimes(video.duration)) {
      const seeked = waitFor(video, ["seeked", "error"], seekMs);
      video.currentTime = time;
      if (await seeked !== "seeked") continue;
      probeCtx.drawImage(video, crop.sx, crop.sy, crop.size, crop.size, 0, 0, PROBE_PX, PROBE_PX);
      const stats = frameStats(probeCtx.getImageData(0, 0, PROBE_PX, PROBE_PX).data);
      const score = frameScore(stats);
      if (score > best) {
        best = score;
        paint.drawImage(video, crop.sx, crop.sy, crop.size, crop.size, 0, 0, size, size);
      }
      if (goodFrame(stats)) break;
    }
    if (best < 0) return null;
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    try { video.load(); } catch { /* yok say */ }
    if (url) URL.revokeObjectURL(url);
  }
}
