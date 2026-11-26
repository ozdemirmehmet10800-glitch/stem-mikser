// uyku zamanlayıcısı (mantık js/sleeptimer.js)
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { SLEEP_MINUTES, SleepTimer, formatRemaining } from "../sleeptimer.js";
import { el, on } from "../dom.js";

let engine, notePlayer, stopPlayback, syncMini;   // app.js'ten (bind)

// Dakika kipinde son 20 sn'de ana ses doğrusal kısılır (kullanıcının kaydırıcı değeri çarpanla ezilir, KAYDEDİLMEZ), süre dolunca çalma durur
// ve ana ses kaydırıcının değerine döner. "Şarkı sonu"nda şarkı doğal bitince durur.

export const sleepTimer = new SleepTimer();
let sleepInterval = 0;

function sleepUserGain() {
  return Number(el("master").value) / 100;
}

export function sleepCancel() {
  sleepTimer.cancel();
  clearInterval(sleepInterval);
  sleepInterval = 0;
  engine.setMaster(sleepUserGain());
  refreshSleepUi();
}

function sleepTick() {
  const state = sleepTimer.tick(Date.now());
  if (state.expired) {
    stopPlayback();
    clearInterval(sleepInterval);
    sleepInterval = 0;
    engine.setMaster(sleepUserGain());
    notePlayer("Uyku zamanlayıcısı bitti, müzik durdu.", "ok", 10000);
  } else if (state.active && !state.atEnd) {
    engine.setMaster(sleepUserGain() * state.gain);
  }
  refreshSleepUi();
  syncMini();
}

export function sleepLabel() {
  if (!sleepTimer.active) return "";
  if (sleepTimer.atEnd) return "şarkı sonu";
  return formatRemaining(sleepTimer.tick(Date.now()).remainingMs);
}

function sleepStart(minutes) {
  if (minutes === "end") sleepTimer.startAtEnd();
  else if (!sleepTimer.startMinutes(minutes, Date.now())) return;
  clearInterval(sleepInterval);
  sleepInterval = setInterval(sleepTick, 1000);
  refreshSleepUi();
}

function refreshSleepUi() {
  const button = el("sleep-open");
  const row = el("sleep-row");
  if (!button || !row) return;
  const on = sleepTimer.active;
  button.classList.toggle("on", on);
  button.title = on ? `Uyku: ${sleepLabel()}` : "Uyku zamanlayıcısı";
  if (row.hidden) return;
  row.replaceChildren();
  const options = [...SLEEP_MINUTES.map((m) => [m, `${m} dk`]), ["end", "Şarkı sonu"]];
  for (const [value, text] of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    const pressed = on && (value === "end" ? sleepTimer.atEnd : !sleepTimer.atEnd && sleepTimer.minutes === value);
    chip.setAttribute("aria-pressed", String(pressed));
    chip.textContent = text;
    chip.addEventListener("click", () => {
      sleepStart(value);
      row.hidden = true;
      el("sleep-open").setAttribute("aria-expanded", "false");
      notePlayer(value === "end" ? "Uyku: şarkı bitince duracak." : `Uyku: ${value} dk sonra duracak.`, "ok", 4000);
    });
    row.append(chip);
  }
  const info = document.createElement("span");
  info.className = "sleep-left";
  info.textContent = on ? `Kalan: ${sleepLabel()}` : "";
  row.append(info);
  if (on) {
    const off = document.createElement("button");
    off.type = "button";
    off.className = "chip";
    off.textContent = "İptal";
    off.addEventListener("click", () => {
      sleepCancel();
      row.hidden = true;
      el("sleep-open").setAttribute("aria-expanded", "false");
    });
    row.append(off);
  }
}

export function bind(deps) {
  ({ engine, notePlayer, stopPlayback, syncMini } = deps);

  on("sleep-open", "click", () => {
    const row = el("sleep-row");
    row.hidden = !row.hidden;
    el("sleep-open").setAttribute("aria-expanded", String(!row.hidden));
    refreshSleepUi();
  });
}
