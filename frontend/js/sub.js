// Alt parçalar (Aşama 10): arayüz durumu ve metinler. SAF mantık (DOM, ağ, ses
// yok); node ile test ediliyor: node tests\sub_test.mjs
//
// İki grup: vocals (lead, backing) ve drums (kick, snare, toms, hihat, cymbals).
// Her grubun KENDİ durumu var: vokal `status.sub`, davul `status.sub_drums`.
// Durum: running | done | unreliable | no_vocals | no_drums | error (yoksa: hiç
// istenmemiş). `done` iken `reliability`: ok | warn.

export const SUB_GROUPS = {
  vocals: ["lead", "backing"],
  drums: ["kick", "snare", "toms", "hihat", "cymbals"],
};
export const GROUP_ORDER = ["vocals", "drums"];
export const SUB_KEYS = { vocals: "sub", drums: "sub_drums" };
export const SUB_LABELS = {
  lead: "Ana vokal", backing: "Arka vokal",
  kick: "Kick", snare: "Snare", toms: "Tom", hihat: "Hi-hat", cymbals: "Zil",
};
const GROUP_TEXT = {
  vocals: "Ana / arka vokal",
  drums: "Kick / Snare / Tom / Hi-hat / Zil",
};
export const WARN_BADGES = {
  vocals: "Ayrım güvenilmez olabilir",
  drums: "Tom kanalına başka enstrüman sızmış olabilir",
};
const SILENT_TEXT = {
  vocals: { state: "no_vocals", text: "Bu şarkıda vokal yok" },
  drums: { state: "no_drums", text: "Bu şarkıda davul yok" },
};
const FAILED_TEXT = {
  vocals: "Bu şarkıda ana vokal ayrılamadı",
  drums: "Bu şarkıda davul ayrılamadı",
};

export function subNames(group) {
  return SUB_GROUPS[group] || [];
}

export function subOf(status, group) {
  return status ? status[SUB_KEYS[group]] : undefined;
}

// Ölçülen (PLAN.md Aşama 10): vokal: çıkarım ~0.45 x süre + ~40 sn yükleme,
// Zeus 158 sn -> 89 sn, $0.015. Davul: çıkarım ~0.2 x süre (5.5x gerçek zaman) +
// ~45 sn (soğuk başlangıç), 158 sn -> 77 sn, $0.0125. T4 saniyesi $0.000164.
const USD_PER_SECOND = 0.000164;
const COST_MODEL = { vocals: { slope: 0.45, base: 40 }, drums: { slope: 0.2, base: 45 } };

export function estimateSub(durationSec, group = "vocals") {
  const duration = Math.max(0, Number(durationSec) || 0);
  const model = COST_MODEL[group] || COST_MODEL.vocals;
  const seconds = Math.round(model.slope * duration + model.base);
  const usd = Math.round(seconds * USD_PER_SECOND * 1000) / 1000;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return { seconds, minutes, usd, text: `~${minutes} dk, ~$${usd.toFixed(3).replace(/0$/, "")}` };
}

/**
 * Uzun şarkı eşiği GRUP BAŞINA. longSongThresholdSec() 6 kanal içindir; bir grubu
 * açmak bellekte geçici olarak daha fazla tampon demek:
 *   tepe = 6 + (açık grubun alt kanalları, başka bir grup açıksa) + (hedef grubun alt kanalları)
 * (alt kanallar çözülürken ana tampon, geçişte de kapanacak grubun ana tamponu
 * çözülürken alt kanallar hâlâ bellekte). Eşik 6/tepe ile ölçeklenir:
 * vokal (2) 6/8, davul (5) 6/11, vokaldan davula geçiş 6/13. Sonsuz eşik (8 GB+
 * telefon) sonsuz kalır.
 */
export function groupThresholdSec(baseSec, nOpen, nTarget) {
  if (!Number.isFinite(baseSec)) return baseSec;
  return baseSec * 6 / (6 + Math.max(0, nOpen) + Math.max(0, nTarget));
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
 * Bir grubun denetiminin durumu (ana kanalın hemen altında).
 *
 * girdi:
 *   group        "vocals" | "drums"
 *   sub          o grubun status'u ya da undefined
 *   duration     şarkı süresi (sn)
 *   mobile       telefon mu
 *   thresholdSec bu grup için uzun şarkı eşiği (Infinity olabilir)
 *   offline      sunucuya ulaşılamıyor
 *   cached       grubun alt parçaları cihazda mı
 *   expanded     grup şu an açık mı
 *   busy         açma/kapama sürüyor
 *   starting     "ayır" isteği gidiyor
 * çıktı: { kind, text, button, arrow, badge, disabled, hint, canExpand }
 *   kind none | running | no_vocals | no_drums | unreliable | error | ready | expanded
 */
export function subView({
  group = "vocals", sub, duration = 0, mobile = false, thresholdSec = Infinity,
  offline = false, cached = false, expanded = false, busy = false, starting = false,
  nowSec = Date.now() / 1000,
}) {
  const state = sub && sub.state;
  const base = { kind: "none", text: "", button: null, arrow: null, badge: null,
                 disabled: false, hint: "", canExpand: false };

  if (starting || isRunning(sub, nowSec)) {
    return { ...base, kind: "running", text: "Alt parçalar ayrılıyor… (bu ekranda kalabilirsin)",
             disabled: true };
  }
  const silent = SILENT_TEXT[group];
  if (silent && state === silent.state) {
    return { ...base, kind: silent.state, text: silent.text };
  }
  if (state === "unreliable") {
    return { ...base, kind: "unreliable", text: FAILED_TEXT[group] || FAILED_TEXT.vocals };
  }
  if (state === "done") {
    const long = mobile && Number.isFinite(thresholdSec) && Number(duration) > thresholdSec;
    let hint = "";
    if (!expanded && long) hint = "Uzun şarkıda bu alt parçalar telefonda açılamaz (bellek)";
    else if (!expanded && offline && !cached) hint = "Alt parçalar cihazda yok, internet gerekli";
    const disabled = busy || Boolean(hint);
    return {
      ...base,
      kind: expanded ? "expanded" : "ready",
      text: GROUP_TEXT[group] || GROUP_TEXT.vocals,
      arrow: expanded ? "open" : "closed",
      badge: sub.reliability === "warn" ? (WARN_BADGES[group] || WARN_BADGES.vocals) : null,
      disabled,
      hint,
      canExpand: !hint,
    };
  }
  // yok ya da error: ayır düğmesi
  const estimate = estimateSub(duration, group);
  const failed = state === "error";
  return {
    ...base,
    button: failed ? "Tekrar dene" : "Alt parçaları ayır",
    text: failed ? "Alt ayrım başarısız oldu" : estimate.text,
    disabled: offline || busy,
    hint: offline ? "İnternet yok" : "",
  };
}

// Alt parça önbellek etiketi için sürüm (sunucu status.sub*.version).
export function subVersion(sub) {
  return sub && sub.state === "done" ? Number(sub.version) || 0 : 0;
}
