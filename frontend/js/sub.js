// Alt parçalar (Aşama 10): arayüz durumu ve metinler. SAF mantık (DOM, ağ, ses
// yok); node ile test ediliyor: node tests\sub_test.mjs
//
// Sunucu `status.sub.state`: running | done | unreliable | no_vocals | error
// (yoksa: hiç istenmemiş). `done` iken `reliability`: ok | warn.

export const SUB_NAMES = ["lead", "backing"];
// Ana kanal -> alt kanallar. Bugün yalnız vokal; davul (oturum 4) buraya eklenecek.
export const SUB_GROUPS = { vocals: ["lead", "backing"] };
export const SUB_LABELS = { lead: "Ana vokal", backing: "Arka vokal" };

// Ölçülen: çıkarım süre x ~0.45 + model yükleme/soğuk başlangıç ~40 sn; maliyet
// T4 saniyesi x $0.000164 (PLAN.md Aşama 10, Zeus: 158 sn, 89 sn, $0.015).
const USD_PER_SECOND = 0.000164;

export function estimateSub(durationSec) {
  const duration = Math.max(0, Number(durationSec) || 0);
  const seconds = Math.round(0.45 * duration + 40);
  const usd = Math.round(seconds * USD_PER_SECOND * 1000) / 1000;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return { seconds, minutes, usd, text: `~${minutes} dk, ~$${usd.toFixed(3).replace(/0$/, "")}` };
}

// Alt ayrım sürüyor mu ve ne kadar süredir? (sunucudaki 40 dk takılma kuralı
// ile aynı: o süreden uzunsa yeniden denenebilir)
export const SUB_STALE_SECONDS = 2400;

export function isRunning(sub, nowSec = Date.now() / 1000) {
  if (!sub || sub.state !== "running") return false;
  const started = Number(sub.started) || 0;
  return nowSec - started < SUB_STALE_SECONDS;
}

/**
 * Vokal kanalının yanındaki denetimin durumu.
 *
 * girdi:
 *   sub          status.sub ya da undefined
 *   duration     şarkı süresi (sn)
 *   mobile       telefon mu
 *   thresholdSec longSongThresholdSec() (Infinity olabilir)
 *   offline      sunucuya ulaşılamıyor
 *   cached       lead ve backing cihazda mı
 *   expanded     alt kanallar şu an açık mı
 *   busy         açma/kapama sürüyor
 *   starting     "ayır" isteği gidiyor
 * çıktı: { kind, text, button, arrow, badge, canExpand, hint }
 *   kind     none | running | no_vocals | unreliable | error | ready | expanded
 *   button   "Alt parçaları ayır" gibi eylem düğmesi etiketi ya da null
 *   arrow    null | "closed" | "open"
 *   disabled eylem/ok pasif mi; `hint` nedeni söyler
 */
export function subView({
  sub, duration = 0, mobile = false, thresholdSec = Infinity, offline = false,
  cached = false, expanded = false, busy = false, starting = false,
  nowSec = Date.now() / 1000,
}) {
  const state = sub && sub.state;
  const base = { kind: "none", text: "", button: null, arrow: null, badge: null,
                 disabled: false, hint: "", canExpand: false };

  if (starting || isRunning(sub, nowSec)) {
    return { ...base, kind: "running", text: "Alt parçalar ayrılıyor… (bu ekranda kalabilirsin)",
             disabled: true };
  }
  if (state === "no_vocals") {
    return { ...base, kind: "no_vocals", text: "Bu şarkıda vokal yok" };
  }
  if (state === "unreliable") {
    return { ...base, kind: "unreliable", text: "Bu şarkıda ana vokal ayrılamadı" };
  }
  if (state === "done") {
    const long = mobile && Number.isFinite(thresholdSec) && Number(duration) > thresholdSec;
    let hint = "";
    if (!expanded && long) hint = "Uzun şarkıda alt parçalar telefonda açılamaz (bellek)";
    else if (!expanded && offline && !cached) hint = "Alt parçalar cihazda yok, internet gerekli";
    const disabled = busy || Boolean(hint);
    return {
      ...base,
      kind: expanded ? "expanded" : "ready",
      text: "Ana / arka vokal",
      arrow: expanded ? "open" : "closed",
      badge: sub.reliability === "warn" ? "Ayrım güvenilmez olabilir" : null,
      disabled,
      hint,
      canExpand: !hint,
    };
  }
  // yok ya da error: ayır düğmesi
  const estimate = estimateSub(duration);
  const failed = state === "error";
  return {
    ...base,
    button: failed ? "Tekrar dene" : "Alt parçaları ayır",
    text: failed ? "Alt ayrım başarısız oldu" : estimate.text,
    disabled: offline || busy,
    hint: offline ? "İnternet yok" : "",
  };
}

// Alt parça önbellek etiketi için sürüm (sunucu status.sub.version).
export function subVersion(sub) {
  return sub && sub.state === "done" ? Number(sub.version) || 0 : 0;
}
