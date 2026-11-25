// 8D ses: kanallar sağ-sol arasında yavaşça döner (başın etrafında dönüyormuş gibi; kulaklıkla). SAF mantık; ses motoruna
// engine.setAutoPan(planFn) ile bağlanır: her kanalın StereoPanner'ına bir LFO (ses kartında, kare döngüsü yok). Sunucu yok.
//   "all"    klasik 8D: bütün şarkı birlikte, aynı hız ve evrede döner.
//   "stems"  kanal kanal: vokal ortada sabit, bas ortaya yakın, diğerleri farklı hız/yönde (bu uygulamaya özgü: şarkı kanallara ayrılmış).
// node tests\eightd_test.mjs

export const EIGHTD_KEY = "stem-mikser.eightd";            // {mode, speed, space} (bu telefonda)
export const EIGHTD_MODES = ["off", "all", "stems"];
export const EIGHTD_SPEEDS = { slow: 1 / 12, medium: 1 / 8, fast: 1 / 4.5 };   // Hz: tam tur 12 / 8 / 4,5 sn
export const EIGHTD_WIDTH = 0.9;                             // dönüş genişliği (1 = tamamen sağa/sola)
export const EIGHTD_TEXT = {
  off: "8D kapalı.",
  all: "8D açık: bütün şarkı başının etrafında dönüyor (3D açıksa önünden arkana da). Kulaklıkla dinle.",
  stems: "8D kanal kanal: vokal ortada, enstrümanlar farklı hız ve yönde dönüyor. Kulaklıkla dinle.",
};

// kanal kanal kipinde kanal başına: hız çarpanı, genişlik çarpanı, evre (tur oranı). Vokal sabit; bas ortaya yakın (alçak sesler ortada daha dolgun).
const STEM_MOTION = {
  vocals: null,
  bass: { rate: 0.5, width: 0.25, phase: 0 },
  drums: { rate: 0.8, width: 0.85, phase: 0.5 },
  guitar: { rate: 1, width: 1, phase: 0.25 },
  piano: { rate: 1.25, width: 1, phase: 0.75 },
  other: { rate: 0.9, width: 0.9, phase: 0.125 },
};

function hashTurn(name) {
  let h = 2166136261;
  for (const ch of String(name)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h % 1000) / 1000;
}

/** Saklanan durum: {mode: "off"|"all"|"stems", speed: "slow"|"medium"|"fast", space: 3D (HRTF) mi}. Bozuk/eksik -> kapalı, orta, 3D açık. */
export function readEightD(storage) {
  let raw = null;
  try {
    raw = storage ? JSON.parse(storage.getItem(EIGHTD_KEY) || "null") : null;
  } catch {
    raw = null;
  }
  const mode = raw && EIGHTD_MODES.includes(raw.mode) ? raw.mode : "off";
  const speed = raw && Object.prototype.hasOwnProperty.call(EIGHTD_SPEEDS, raw.speed) ? raw.speed : "medium";
  const space = !(raw && raw.space === false);
  return { mode, speed, space };
}

export function storeEightD(storage, state) {
  try {
    storage.setItem(EIGHTD_KEY, JSON.stringify({ mode: state.mode, speed: state.speed, space: state.space !== false }));
    return true;
  } catch {
    return false;
  }
}

/** 8D düğmesi: kapalı -> klasik -> kanal kanal -> kapalı. */
export function nextEightDMode(mode) {
  const index = EIGHTD_MODES.indexOf(mode);
  return EIGHTD_MODES[(index + 1) % EIGHTD_MODES.length];
}

/**
 * Motor için plan işlevi: (kanal adı, ana kanal adı?) -> {rate (Hz), depth (0..1), phase (radyan)} ya da null (kanal dönmez).
 * Alt parçalar (ör. davulun alt kanalları) ana kanalın hareketini izler. Kapalıysa null döner (motor 8D'yi kaldırır).
 */
export function eightDPlan({ mode = "off", speed = "medium" } = {}) {
  if (mode !== "all" && mode !== "stems") return null;
  const base = EIGHTD_SPEEDS[speed] || EIGHTD_SPEEDS.medium;
  return (name, parent = "") => {
    if (mode === "all") return { rate: base, depth: EIGHTD_WIDTH, phase: 0 };
    const key = String(parent || name || "");
    const motion = Object.prototype.hasOwnProperty.call(STEM_MOTION, key) ? STEM_MOTION[key] : { rate: 1, width: 0.9, phase: hashTurn(key) };
    if (!motion) return null;
    return { rate: base * motion.rate, depth: EIGHTD_WIDTH * motion.width, phase: 2 * Math.PI * motion.phase };
  };
}

/** Bir anda pan değeri (test ve görselleştirme için; motor aynı formülü LFO ile ses kartında uygular). */
export function panAt(entry, seconds) {
  if (!entry) return 0;
  return entry.depth * Math.sin(2 * Math.PI * entry.rate * seconds + entry.phase);
}
