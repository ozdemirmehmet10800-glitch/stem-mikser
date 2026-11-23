// Uyku zamanlayıcısı: SAF mantık (zaman dışarıdan verilir; ses, DOM, depolama YOK). node tests\sleeptimer_test.mjs
//
// Kipler: dakika (15/30/60...) ya da "şarkı sonu". Dakika kipinde son FADE_MS boyunca ses doğrusal kısılır, süre dolunca durdurulur.
// "Şarkı sonu"nda kısma yok: şarkı doğal bitince çalma durur (listede/sırada sonrakine GEÇİLMEZ).

export const SLEEP_MINUTES = [15, 30, 60];
export const FADE_MS = 20000;
export const MAX_MINUTES = 240;

export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000) || 0);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export class SleepTimer {
  constructor() {
    this.mode = null;          // "minutes" | "end" | null
    this.endsAt = 0;
    this.minutes = 0;
  }

  get active() {
    return this.mode !== null;
  }

  get atEnd() {
    return this.mode === "end";
  }

  /** Dakika kipi: geçersiz/aşırı değer kabul edilmez (false). */
  startMinutes(minutes, now) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value < 1 || value > MAX_MINUTES) return false;
    this.mode = "minutes";
    this.minutes = Math.round(value);
    this.endsAt = now + this.minutes * 60000;
    return true;
  }

  startAtEnd() {
    this.mode = "end";
    this.minutes = 0;
    this.endsAt = 0;
  }

  cancel() {
    this.mode = null;
    this.endsAt = 0;
    this.minutes = 0;
  }

  /**
   * Anlık durum: {active, atEnd, remainingMs (şarkı sonunda null), gain (0..1 çarpan), expired}.
   * Süre dolunca expired=true ve zamanlayıcı KAPANIR (bir kez bildirilir).
   */
  tick(now) {
    if (this.mode === null) return { active: false, atEnd: false, remainingMs: null, gain: 1, expired: false };
    if (this.mode === "end") return { active: true, atEnd: true, remainingMs: null, gain: 1, expired: false };
    const remaining = this.endsAt - now;
    if (remaining <= 0) {
      this.cancel();
      return { active: false, atEnd: false, remainingMs: 0, gain: 0, expired: true };
    }
    const gain = remaining >= FADE_MS ? 1 : Math.max(0, remaining / FADE_MS);
    return { active: true, atEnd: false, remainingMs: remaining, gain, expired: false };
  }
}
