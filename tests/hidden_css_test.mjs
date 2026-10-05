// `hidden` özniteliği CSS'teki `display` kuralıyla EZİLMESİN. Tarayıcının [hidden] { display: none } kuralı kullanıcı
// ajanı düzeyinde; yazar CSS'indeki `.x { display: flex }` onu ezer ve `hidden` öğe görünür kalır. Bu projede bunun
// çözümü sınıf başına `.x[hidden] { display: none }` kuralı. Bu test index.html'deki `hidden` öznitelikli HER öğe için
// (sınıf ve id), `display` bildiren bir kuralı varsa bir de `[hidden]` kuralı olduğunu sınar.
// (Hata: paylaşım kartı `.share-card { display: flex }` ile hiçbir paylaşım yokken görünüyordu.)
//
//     node tests\hidden_css_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/css/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// --- CSS kuralları: [{selectors: [...], body}]
const rules = [];
for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
  rules.push({ selectors: match[1].split(",").map((s) => s.trim()).filter(Boolean), body: match[2] });
}
const displayOf = (body) => {
  const found = [...body.matchAll(/(?:^|;)\s*display\s*:\s*([^;!]+)/g)];
  return found.length ? found[found.length - 1][1].trim() : null;
};

// Seçiciyi bileşenlere ayır: [{tokens: [".a", "#b"], text}] (son bileşen = öğenin kendisi, öncekiler ATA bileşenleri).
const compounds = (selector) => selector.split(/[\s>+~]+/).filter(Boolean);
const lastCompound = (selector) => compounds(selector).pop() || "";
const simpleTokens = (compound) => compound.match(/[.#][\w-]+/g) || [];

// Ata bileşenleri bu öğenin gerçek ataları arasında mı? (kapsamlı kural yalnız o kapsamdaki öğeye uygulanır)
function scopeMatches(selector, ancestors) {
  return compounds(selector).slice(0, -1).every((compound) => simpleTokens(compound).every((token) => ancestors.has(token)));
}

function visibleDisplayRules(token, ancestors) {   // token: ".sinif" ya da "#id"; display'i GÖRÜNÜR bırakan (none olmayan) kurallar
  return rules.filter((rule) => rule.selectors.some((selector) => {
    const last = lastCompound(selector);
    return (last === token || last.startsWith(token + ":")) && scopeMatches(selector, ancestors);
  }) && displayOf(rule.body) !== null && displayOf(rule.body) !== "none");
}

function hasHiddenRule(token, ancestors) {
  return rules.some((rule) => rule.selectors.some((selector) => {
    const last = lastCompound(selector);
    return last.startsWith(token + "[hidden]") && scopeMatches(selector, ancestors) && displayOf(rule.body) === "none";
  }));
}

const globalHidden = rules.some((rule) => rule.selectors.includes("[hidden]") && displayOf(rule.body) === "none");

// --- index.html: hidden öznitelikli öğeler (ATALARIYLA: açık etiket yığını)
const VOID = new Set(["input", "br", "img", "link", "meta", "hr", "source", "area", "col", "embed", "wbr"]);
const subjects = [];
const stack = [];
for (const m of html.matchAll(/<(\/?)([a-z0-9]+)\b([^>]*)>/gi)) {
  const [, closing, tag, attrs] = m;
  if (closing) {
    // en yakın eşleşen açık etiketi kapat
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].tag === tag) { stack.length = i; break; }
    }
    continue;
  }
  const id = /\sid="([^"]+)"/.exec(attrs);
  const cls = /\sclass="([^"]+)"/.exec(attrs);
  const own = [...(id ? [`#${id[1]}`] : []), ...(cls ? cls[1].split(/\s+/).filter(Boolean).map((c) => `.${c}`) : [])];
  if (/\shidden(\s|=|>|$)/.test(`${attrs}>`)) {
    const ancestors = new Set(stack.flatMap((entry) => entry.tokens));
    const element = id ? `#${id[1]}` : `<${tag} class="${cls ? cls[1] : ""}">`;
    for (const token of own) subjects.push({ tag, element, token, ancestors });
  }
  if (!VOID.has(tag.toLowerCase()) && !/\/\s*$/.test(attrs)) stack.push({ tag, tokens: own });
}
check("index.html'de hidden öznitelikli öğe bulundu (ayrıştırıcı çalışıyor)", subjects.length > 20, String(subjects.length));

// Öğe başına: öğenin herhangi bir belirteci (id/sınıf) display'i görünür bırakıyorsa, öğenin herhangi bir belirteci için
// ona UYGULANAN bir [hidden] kuralı olmalı (ör. .icon-btn { display: grid } + .library-search-clear[hidden] { display: none }).
// Kapsamlı kural (".export-actions .btn[hidden]") yalnız o kapsamdaki öğeleri kurtarır.
const byElement = new Map();
for (const subject of subjects) {
  if (!byElement.has(subject.element)) byElement.set(subject.element, []);
  byElement.get(subject.element).push(subject);
}
const offenders = [];
for (const [element, tokens] of byElement) {
  const shown = tokens.flatMap((t) => visibleDisplayRules(t.token, t.ancestors).map((r) => `${t.token}: ${displayOf(r.body)}`));
  const covered = tokens.some((t) => hasHiddenRule(t.token, t.ancestors));
  if (shown.length && !covered && !globalHidden) offenders.push(`${element}: display kuralı (${shown.join(", ")}) var ama [hidden] kuralı YOK`);
}
check("hidden öğelerin hiçbirinin display kuralı [hidden]'ı ezmiyor", offenders.length === 0, offenders.join(" | "));

// --- paylaşım kartı (hata: boş kart görünüyordu)
check("paylaşım kartı HTML'de hidden başlıyor", /<section class="share-card" id="share-card" hidden/.test(html));
check("paylaşım kartı: .share-card display kuralı VAR ve .share-card[hidden] { display: none } da var",
  visibleDisplayRules(".share-card", new Set()).length > 0 && hasHiddenRule(".share-card", new Set()));

// Sınama aracının kendisi: ezilen bir örneği yakalıyor mu?
const fakeRules = [{ selectors: [".x"], body: "display: flex;" }];
const caught = fakeRules.some((r) => r.selectors.includes(".x") && displayOf(r.body) === "flex")
  && !rules.some((r) => r.selectors.includes(".x[hidden]"));
check("araç doğrulaması: [hidden] kuralsız display bildiren sınıf ezici sayılır", caught && displayOf("a:b; display:flex") === "flex"
  && displayOf("display: none") === "none" && displayOf("color:red") === null);

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
