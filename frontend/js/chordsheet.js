// Akorlu söz sayfası: akorları (chords.json, zamanlı) söz satırlarının kelimeleriyle (lyrics.json `w`) birleştirir. SAF mantık + küçük
// DOM yardımcısı (createEl dışarıdan verilir); node ile test ediliyor: node tests\chordsheet_test.mjs
//
// Akıl yürütme (canlı veriyle ölçüldü, PLAN.md):
//  - Akorlar yarım ölçü ızgarasında ve üçlü akor; kelimeye değil ızgaraya oturur. Gösterim "yaklaşık": akor, söylenen kelimenin üstüne
//    yapışır (kelime başına en yakın), kelime içi hece konumu denenmez.
//  - Ham veriye dokunulmaz; sadeleştirme (evrik bas düşer, tek yarım ölçülük A-B-A titreşimi A'ya katılır) YALNIZ gösterimde.
//  - Akor etiketi hep ORİJİNAL tonda tutulur, ekrandaki metin displayLabel'dan gelir (ton değişince yeniden yazılır, sayfa yeniden kurulmaz).

import { transposeLabel, namesForKey, NO_CHORD } from "./tonality.js";

export const GAP_MIN_SECONDS = 3;         // satırlar arası bu kadar ya da daha uzun boşluk = sözsüz bölüm (giriş / ara / çıkış)
export const LINE_LEAD_SECONDS = 0.4;     // satırın başlamasından bu kadar önce başlayan akor da o satırın (söyleyen akoru önceden duyar)
export const LINE_TAIL_SECONDS = 0.3;     // satır bittikten bu kadar sonrasına kadar akor hâlâ o satırın
export const WORD_SPLIT = 0.6;            // akor kelimenin ilk %60'ında başlıyorsa o kelimenin, sonrasında sıradaki kelimenin üstünde
export const WORD_LEAD_SECONDS = 0.15;    // kelime başlamadan bu kadar önceki akor o kelimenin
export const FLICKER_HALF_BARS = 1.05;    // A-B-A'da B bu kadar yarım ölçüden kısaysa titreşim sayılır
export const GRID_BARS_PER_ROW = 4;
export const GAP_CHIPS_SHOWN = 24;        // sözsüz bölümde ilk görünen akor sayısı (fazlası "+N" ile açılır)

const normalizeText = (text) => String(text ?? "").replace(/\s+/g, "").toLowerCase();

/** "Ab/C" -> "Ab" (showBass kapalıyken); "N" ve bas yoksa aynen. */
export function stripBass(label) {
  const text = String(label ?? "");
  const at = text.indexOf("/");
  return at > 0 ? text.slice(0, at) : text;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Yarım ölçü süresi (sn): downbeat aralıklarının medyanı / 2; downbeat yoksa 0,7. */
export function halfBarSeconds(chordData) {
  const downs = (chordData && chordData.downbeats) || [];
  const diffs = [];
  for (let i = 0; i + 1 < downs.length; i += 1) {
    const d = downs[i + 1] - downs[i];
    if (d > 0.05) diffs.push(d);
  }
  return diffs.length ? median(diffs) / 2 : 0.7;
}

/**
 * chords.json -> gösterim akorları [{i, start, end, label}] (label orijinal tonda, bassız).
 * Adımlar: (1) bas notası düşer, (2) ardışık aynı akor birleşir, (3) A-B-A'da B tek yarım ölçülükse (ve A-B-A-B gibi gerçek bir değişim
 * kalıbı DEĞİLSE) üçü A olur, (4) tekrar birleşir. "N" (akor yok) listede kalır (ızgarada "·"), ama sözlere akor olarak konmaz.
 */
export function prepareChords(chordData, { showBass = false, flicker = FLICKER_HALF_BARS } = {}) {
  const source = chordData && Array.isArray(chordData.chords) ? chordData.chords : [];
  const valid = source
    .filter((c) => c && typeof c.label === "string" && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)) && Number(c.end) > Number(c.start))
    .map((c) => ({ start: Number(c.start), end: Number(c.end), label: showBass ? c.label : stripBass(c.label) }))
    .sort((a, b) => a.start - b.start);
  const merge = (list) => {
    const out = [];
    for (const c of list) {
      const last = out[out.length - 1];
      if (last && last.label === c.label) last.end = Math.max(last.end, c.end);
      else out.push({ ...c });
    }
    return out;
  };
  const merged = merge(valid);
  const limit = halfBarSeconds(chordData) * flicker;
  const isBlip = (i) => {
    const prev = merged[i - 1];
    const next = merged[i + 1];
    return Boolean(prev && next && prev.label === next.label && merged[i].label !== prev.label
      && merged[i].end - merged[i].start <= limit
      && !(merged[i + 2] && merged[i + 2].label === merged[i].label)       // A B A B: gerçek ikili değişim, korunur
      && !(merged[i - 2] && merged[i - 2].label === merged[i].label));
  };
  const kept = [];
  for (let i = 0; i < merged.length; i += 1) {
    if (isBlip(i) && kept.length) kept[kept.length - 1].end = merged[i].end;   // B'nin süresi A'ya geçer
    else kept.push({ ...merged[i] });
  }
  const out = merge(kept);
  return out.map((c, i) => ({ i, start: c.start, end: c.end, label: c.label }));
}

/** Ekrandaki metin: orijinal etiket + yarım ses kayması + (şarkı tonuna göre diyez/bemol). */
export function displayLabel(label, semitones = 0, songKey = null) {
  if (label === NO_CHORD) return "·";
  const shift = Math.round(Number(semitones) || 0);
  if (!shift) return label;
  return transposeLabel(label, shift, namesForKey(songKey, shift));
}

/** t anında çalan akorun indeksi ("N" ve boşluk = -1). */
export function soundingAt(chords, t) {
  for (const c of chords) {
    if (c.start <= t + 1e-6 && t < c.end) return c.label === NO_CHORD ? -1 : c.i;
  }
  return -1;
}

/** Akor t anında hangi kelimenin üstüne düşer? line.w = [[bas, bit, kelime], ...]; kelime yoksa 0. */
export function wordIndexFor(line, t) {
  const words = (line && line.w) || [];
  const m = words.length;
  if (!m) return 0;
  for (let k = 0; k < m; k += 1) {
    const a = Number(words[k][0]);
    const b = Number(words[k][1]);
    if (t < a - WORD_LEAD_SECONDS) return k;                       // kelimeler arası / satır başı: sıradaki kelime
    if (t < b) return (t - a) <= WORD_SPLIT * (b - a) ? k : Math.min(k + 1, m - 1);
  }
  return m - 1;
}

/**
 * Söz satırları x akorlar. Dönen: { lines: [{ anchors: [{wi, ci, carry}], pre, post }] }
 *   anchors  satır içi akorlar (wi = line.w indeksi; carry = satır başında zaten çalmakta olan akor, soluk gösterilir)
 *   pre/post {kind: "intro"|"ara"|"outro", chips: [{ci, carry}]} sözsüz bölüm satırı (pre: bu satırdan ÖNCE, post: son satırdan sonra)
 */
export function mapSheet({ lines, chords, duration = 0 }) {
  const out = lines.map(() => ({ anchors: [], pre: null, post: null }));
  if (!lines.length || !chords.length) return { lines: out };
  const n = lines.length;
  const buckets = new Map();                                       // j (sıradaki satır; n = çıkış) -> [ci...]
  for (const c of chords) {
    if (c.label === NO_CHORD) continue;
    const t = c.start;
    let i = -1;
    for (let k = 0; k < n; k += 1) if (lines[k].t - LINE_LEAD_SECONDS <= t) i = k; else break;
    if (i >= 0 && t <= lines[i].e + LINE_TAIL_SECONDS) {
      out[i].anchors.push({ wi: wordIndexFor(lines[i], t), ci: c.i, carry: false });
      continue;
    }
    const j = i + 1;
    const gapStart = i >= 0 ? lines[i].e : 0;
    const gapEnd = j < n ? lines[j].t : Math.max(duration, c.end);
    if (gapEnd - gapStart >= GAP_MIN_SECONDS) {
      if (!buckets.has(j)) buckets.set(j, []);
      buckets.get(j).push(c.i);
    } else if (j < n) {
      out[j].anchors.push({ wi: 0, ci: c.i, carry: false });
    } else {
      const words = lines[i].w || [];
      out[i].anchors.push({ wi: Math.max(words.length - 1, 0), ci: c.i, carry: false });
    }
  }
  for (const [j, cis] of buckets) {
    const gapStart = j > 0 ? lines[j - 1].e : 0;
    const first = chords[cis[0]];
    const chips = [];
    const playing = soundingAt(chords, gapStart + LINE_TAIL_SECONDS);
    if (playing >= 0 && chords[playing].start < first.start && playing !== cis[0]) chips.push({ ci: playing, carry: true });
    for (const ci of cis) chips.push({ ci, carry: false });
    const kind = j === 0 ? "intro" : (j === n ? "outro" : "ara");
    if (j === n) out[n - 1].post = { kind, chips };
    else out[j].pre = { kind, chips };
  }
  // satır başında çalmakta olan akor (başka akor kelime 0'a konmadıysa): her satır tek başına okunabilsin diye soluk gösterilir
  lines.forEach((line, i) => {
    const words = line.w || [];
    const start = words.length ? Number(words[0][0]) : line.t;
    const ci = soundingAt(chords, start);
    if (ci >= 0 && !out[i].anchors.some((a) => a.wi === 0)) out[i].anchors.push({ wi: 0, ci, carry: true });
    out[i].anchors.sort((a, b) => a.wi - b.wi || chords[a.ci].start - chords[b.ci].start);
    const seen = new Set();
    out[i].anchors = out[i].anchors.filter((a) => {
      const key = `${a.wi}:${a.ci}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  return { lines: out };
}

/**
 * Sözü olmayan şarkı: ölçü ızgarası. Dönen: [{start, bars: [{start, end, chips: [{ci, carry}]}]}], satır başına GRID_BARS_PER_ROW ölçü.
 * Her ölçüde o an çalan akor görünür (ölçüde başlamıyorsa carry). downbeat yoksa her akor kendi hücresi.
 */
export function buildGrid({ chords, downbeats = [], duration = 0 }) {
  if (!chords.length) return [];
  const end = Math.max(duration, chords[chords.length - 1].end);
  let bounds;
  if (downbeats.length >= 2) {
    bounds = [...downbeats];
    const spans = [];
    for (let i = 0; i + 1 < bounds.length; i += 1) if (bounds[i + 1] - bounds[i] > 0.05) spans.push(bounds[i + 1] - bounds[i]);
    const bar = median(spans) || 2;
    if (bounds[0] > 0.05) {
      if (bounds[0] < bar * 0.6) bounds[0] = 0;
      else bounds.unshift(0);
    }
    bounds.push(end);
  } else {
    bounds = chords.map((c) => c.start);
    bounds.push(end);
  }
  const bars = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const bs = bounds[i];
    const be = bounds[i + 1];
    if (be <= bs) continue;
    const chips = [];
    const atStart = chords.find((c) => c.start <= bs + 0.05 && bs + 0.05 < c.end);
    if (atStart) chips.push({ ci: atStart.i, carry: atStart.start < bs - 0.05 });
    for (const c of chords) {
      if (c.start > bs + 0.05 && c.start < be - 0.05) chips.push({ ci: c.i, carry: false });
    }
    bars.push({ start: bs, end: be, chips });
  }
  const rows = [];
  for (let i = 0; i < bars.length; i += GRID_BARS_PER_ROW) {
    rows.push({ start: bars[i].start, bars: bars.slice(i, i + GRID_BARS_PER_ROW) });
  }
  return rows;
}

// ------------------------------------------------------------------- DOM

/** Satırın kelime parçaları: ["kelime", ...] ve ekleyici (" " ya da Japoncada ""). Parçalar `text` ile uyuşmuyorsa null. */
export function tokensOf(line, language) {
  const words = line && line.w;
  if (!Array.isArray(words) || !words.length) return null;
  const tokens = words.map((w) => String(w && w[2] != null ? w[2] : ""));
  if (tokens.some((t) => !t.trim())) return null;
  const joiner = language === "ja" ? "" : " ";
  if (normalizeText(tokens.join("")) !== normalizeText(line.text)) return null;
  return { tokens, joiner };
}

function chipEl(create, chip, label) {
  const node = create("span");
  node.className = "cc" + (chip.carry ? " carry" : "");
  node.dataset.ci = String(chip.ci);
  node.textContent = label(chip.ci);
  return node;
}

/**
 * Bir satırın `main` düğümünü akorlu kurar. create(tag) -> düğüm. label(ci) -> ekrandaki metin.
 * Dönen: yerleştirilen akor düğümleri [{el, ci}]. Kelime parçaları uyuşmazsa akorlar satırın üstünde ayrı bir akor satırı olur.
 */
export function renderMain({ create, main, line, anchors, language, label }) {
  main.textContent = "";
  const placed = [];
  const parts = anchors && anchors.length ? tokensOf(line, language) : null;
  if (!anchors || !anchors.length) {
    main.textContent = line.text;
    return placed;
  }
  if (!parts) {
    const row = create("span");
    row.className = "chord-line";
    for (const anchor of anchors) {
      const node = chipEl(create, anchor, label);
      row.append(node);
      placed.push({ el: node, ci: anchor.ci });
    }
    const text = create("span");
    text.textContent = line.text;
    main.append(row, text);
    return placed;
  }
  const { tokens, joiner } = parts;
  const byWord = new Map();
  for (const anchor of anchors) {
    const k = Math.min(Math.max(anchor.wi, 0), tokens.length - 1);
    if (!byWord.has(k)) byWord.set(k, []);
    byWord.get(k).push(anchor);
  }
  let run = [];
  let pieces = 0;
  const space = () => {
    if (joiner && pieces) {
      const sp = create("span");
      sp.className = "sp";
      sp.textContent = joiner;
      main.append(sp);
    }
  };
  const flush = () => {
    if (!run.length) return;
    space();
    const text = create("span");
    text.textContent = run.join(joiner);
    main.append(text);
    pieces += 1;
    run = [];
  };
  tokens.forEach((token, k) => {
    const list = byWord.get(k);
    if (!list) {
      run.push(token);
      return;
    }
    flush();
    space();
    const unit = create("span");
    unit.className = "cw";
    const chips = create("span");
    chips.className = "ccs";
    for (const anchor of list) {
      const node = chipEl(create, anchor, label);
      chips.append(node);
      placed.push({ el: node, ci: anchor.ci });
    }
    const word = create("span");
    word.className = "wd";
    word.textContent = token;
    unit.append(chips, word);
    main.append(unit);
    pieces += 1;
  });
  flush();
  return placed;
}

/** Sözsüz bölüm satırı ("Giriş", "Ara", "Çıkış" + akorlar). expanded=false iken GAP_CHIPS_SHOWN'dan fazlası "+N" düğmesinin arkasında. */
export const GAP_TITLES = { intro: "Giriş", ara: "Ara", outro: "Çıkış" };

export function renderGap({ create, gap, chords, label, expanded = false, onExpand = null }) {
  const row = create("div");
  row.className = `chord-gap ${gap.kind}`;
  const title = create("span");
  title.className = "chord-gap-title";
  title.textContent = GAP_TITLES[gap.kind] || "";
  row.append(title);
  const placed = [];
  const shown = expanded ? gap.chips : gap.chips.slice(0, GAP_CHIPS_SHOWN);
  for (const chip of shown) {
    const node = chipEl(create, chip, label);
    node.dataset.t = String(chords[chip.ci].start);
    row.append(node);
    placed.push({ el: node, ci: chip.ci });
  }
  const more = gap.chips.length - shown.length;
  if (more > 0) {
    const button = create("button");
    button.className = "cc more";
    button.textContent = `+${more}`;
    if (onExpand) button.addEventListener("click", (event) => { event.stopPropagation(); onExpand(); });
    row.append(button);
  }
  return { row, placed };
}

/** Ölçü ızgarası satırlarını kurar. Dönen: { el: kök, placed: [{el, ci}] }. */
export function renderGrid({ create, rows, chords, label }) {
  const root = create("div");
  root.className = "chord-grid-rows";
  const placed = [];
  for (const row of rows) {
    const rowEl = create("div");
    rowEl.className = "grid-row";
    rowEl.dataset.t = String(row.start);
    for (const bar of row.bars) {
      const cell = create("div");
      cell.className = "grid-bar";
      cell.dataset.t = String(bar.start);
      for (const chip of bar.chips) {
        const node = chipEl(create, chip, label);
        node.dataset.t = String(chords[chip.ci].start);
        cell.append(node);
        placed.push({ el: node, ci: chip.ci });
      }
      rowEl.append(cell);
    }
    root.append(rowEl);
  }
  return { el: root, placed };
}
