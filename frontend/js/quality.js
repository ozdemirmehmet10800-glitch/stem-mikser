// Şarkının hangi yöntemle ayrıştırıldığı: kitaplık rozeti, şarkı bilgisi satırı, "yükselt" düğmesi. SAF mantık (DOM yok), node ile
// test ediliyor: node tests\quality_test.mjs
//
// Sunucu her ayrıştırmada status.json'a yazar: quality ("hifi" | "standard"), pipeline ("hifi_v2" | "standard"), stems_version
// (ayrıştırmanın epoch saniyesi). Eski şarkılarda alan yok:
//   quality=hifi + pipeline yok   -> hifi_v1 (29 Eylül - 1 Ekim 2026: vokal SW'den, kalanı demucs'tan)
//   quality=standard + pipeline yok, ya da ikisi de yok (Aşama 9 öncesi) -> Standart (yalnız demucs)

export const KIND_V2 = "v2";
export const KIND_V1 = "v1";
export const KIND_STANDARD = "standard";

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/**
 * info: {state?, quality, pipeline}. Dönen: {kind, version} ya da null (rozet yok).
 * Ayrıştırma sürerken ya da hata varsa null: yeni yüklemede `quality` hemen yazılır ama `pipeline` bitince gelir, o ara "v1" sanılmasın.
 */
export function methodOf(info) {
  if (!info || (info.state !== undefined && info.state !== "done")) return null;
  const pipeline = String(info.pipeline || "").toLowerCase();
  const match = /^hifi_v(\d{1,2})$/.exec(pipeline);
  if (match) {
    const version = Number(match[1]);
    return version >= 2 ? { kind: KIND_V2, version } : { kind: KIND_V1, version: 1 };
  }
  if (pipeline === "standard") return { kind: KIND_STANDARD, version: 0 };
  if (pipeline) return null;                               // tanınmayan boru hattı: yanlış etiket vermektense gösterme
  return info.quality === "hifi" ? { kind: KIND_V1, version: 1 } : { kind: KIND_STANDARD, version: 0 };
}

/** Kitaplık rozeti: {text, cls} ya da null. cls: CSS sınıfları (quality-tag'e eklenir). */
export function badgeOf(info) {
  const method = methodOf(info);
  if (!method) return null;
  if (method.kind === KIND_V2) return { text: method.version === 2 ? "Hi-Fi v2" : `Hi-Fi v${method.version}`, cls: "hifi" };
  if (method.kind === KIND_V1) return { text: "Hi-Fi", cls: "hifi v1" };
  return { text: "Standart", cls: "standard" };
}

/** Oynatıcıdaki yükseltme düğmesi: {label, kind} ya da null (yükseltilecek bir şey yok). */
export function upgradeOf(info) {
  const method = methodOf(info);
  if (!method) return null;
  if (method.kind === KIND_STANDARD) return { label: "Hi-Fi'a yükselt", kind: "hifi" };
  if (method.kind === KIND_V1) return { label: "v2'ye yükselt", kind: "v2" };
  return null;
}

export function formatDate(epochSeconds) {
  const seconds = Number(epochSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const date = new Date(seconds * 1000);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Şarkı bilgisi satırı: hangi model, ne zaman. status = status.json (stems_version, quality, pipeline). */
export function describeMethod(status) {
  const method = methodOf(status);
  if (!method) return "";
  const when = formatDate(status.stems_version);
  let model;
  if (method.kind === KIND_V2) model = "Hi-Fi v2 · vokal, piyano, davul: BS-RoFormer SW · bas, gitar, diğer: htdemucs_6s";
  else if (method.kind === KIND_V1) model = "Hi-Fi (v1) · vokal: BS-RoFormer SW · kalanı: htdemucs_6s";
  else model = "Standart · htdemucs_6s";
  return when ? `${model} · ${when}` : model;
}

/** Yükseltme onayı. v2'ye yükseltmede alt parçaların SİLİNECEĞİ açıkça yazılır. */
export function upgradeConfirmText(upgrade, { hasSubs = false } = {}) {
  if (!upgrade) return "";
  const target = upgrade.kind === "v2" ? "Hi-Fi v2" : "Hi-Fi";
  const lines = [
    `Bu şarkı ${target} ile yeniden ayrıştırılacak (şarkı süresine göre birkaç dakika, küçük bir bulut maliyeti). Akor, vuruş, mikser ayarı ve A-B noktaları korunur.`,
    "Alt parçalar (ana/arka vokal, davul parçaları) SİLİNİR; istersen sonra yeniden ayırırsın."
      + (hasSubs ? " Bu şarkıda ayrılmış alt parça var." : ""),
    "Sözler \"eski ayrıştırmadan\" uyarısı verebilir; gerekirse yeniden hizala.",
    "Devam edilsin mi?",
  ];
  return lines.join("\n\n");
}
