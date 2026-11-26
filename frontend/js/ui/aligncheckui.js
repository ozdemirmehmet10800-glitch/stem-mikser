// hiza testi
// app.js'ten ayrıldı (2026-11-26 sadeleştirme, davranış aynı). Ana dosyadan gelenler `bind` ile verilir;
// değişen değerler (şarkı, ayarlar...) her kullanımda güncel okunur (getter).

import { el, on } from "../dom.js";

let engine, nav, stopPlayback, settings;   // app.js'ten (bind)

// aligncheck.js YALNIZCA test çalıştırılınca yükleniyor: normal açılışta
// ne modül ne de worklet indiriliyor.
function renderAlignment(rows, legend) {
  const host = el("align-results");
  if (!host) return;
  host.innerHTML = "";
  const table = document.createElement("table");
  table.className = "align-table";
  table.innerHTML =
    "<thead><tr><th>Ölçüm</th><th>Değer</th><th></th><th>Not</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const item of rows) {
    const tr = document.createElement("tr");
    const verdict =
      item.passed === null
        ? '<span class="align-verdict info">bilgi</span>'
        : item.passed
        ? '<span class="align-verdict ok">geçti</span>'
        : '<span class="align-verdict fail">kaldı</span>';
    tr.innerHTML =
      `<td>${item.name}</td>` +
      `<td class="value">${item.measurement}</td>` +
      `<td>${verdict}</td>` +
      `<td class="note">${item.note || ""}</td>`;
    body.append(tr);
  }
  table.append(body);
  host.append(table);
  // Açıklama testten geliyor: saçılma cümlesi kullanılan esneticiye göre
  // değişiyor (WSOLA'nın doğası Signalsmith için geçerli değil).
  const note = document.createElement("small");
  note.className = "align-legend";
  note.textContent = legend;
  host.append(note);
}

export function bind(deps) {
  ({ engine, nav, stopPlayback, settings } = deps);

  on("align-run", "click", async () => {
    const button = el("align-run");
    const state = el("align-state");
    const results = el("align-results");
    button.disabled = true;
    results.innerHTML = "";
    state.hidden = false;
    state.textContent = "Hazırlanıyor…";
    // Ölçüm sürerken geri yutuluyor: yarıda kesilen bir ölçüm yanlış sayı
    // verir, yanlış sayı da yanlış karar.
    nav.block("align");
    try {
      // Oynatıcı çalıyorsa durdur: iki AudioContext aynı anda ses vermesin.
      if (engine.playing) stopPlayback();
      const { runAlignmentCheck, PASS_MS } = await import("../aligncheck.js");
      const { rows, legend } = await runAlignmentCheck(
        (text) => { state.textContent = text; },
        {
          stretcher: settings().stretcher,
          formants: settings().formants,
          // Hiza testi SEÇİLİ kalitede koşuyor: kendi Engine'ini kurduğu için
          // kipi ona ayrıca söylemek gerekiyor, yoksa "Yüksek" seçiliyken
          // 32 kHz mono ölçer ve sonuç uygulamayı anlatmaz.
          audioMode: settings().mobileAudio,
        }
      );
      renderAlignment(rows, legend);
      const failed = rows.filter((item) => item.passed === false).length;
      state.textContent = failed
        ? `${failed} ölçüm kaldı (eşik ±${PASS_MS} ms).`
        : `Hepsi geçti (eşik ±${PASS_MS} ms).`;
    } catch (error) {
      state.textContent = `Test çalıştırılamadı: ${error && error.message ? error.message : error}`;
    } finally {
      nav.unblock("align");
      button.disabled = false;
    }
  });
}
