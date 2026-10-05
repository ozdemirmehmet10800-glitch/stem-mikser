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

// Bir seçicinin SON bileşeni (ör. ".a .b:hover" -> ".b:hover") ve [hidden] mi içeriyor
const lastCompound = (selector) => selector.split(/[\s>+~]+/).filter(Boolean).pop() || "";

function visibleDisplayRules(token) {       // token: ".sinif" ya da "#id"; display'i GÖRÜNÜR bırakan (none olmayan) kurallar
  return rules.filter((rule) => rule.selectors.some((selector) => {
    const last = lastCompound(selector);
    return last === token || last.startsWith(token + ":");
  }) && displayOf(rule.body) !== null && displayOf(rule.body) !== "none");
}

function hasHiddenRule(token) {
  return rules.some((rule) => rule.selectors.some((selector) => {
    const last = lastCompound(selector);
    return last.startsWith(token) && last.includes("[hidden]") && displayOf(rule.body) === "none";
  }));
}

const globalHidden = rules.some((rule) => rule.selectors.includes("[hidden]") && displayOf(rule.body) === "none");

// --- index.html: hidden öznitelikli öğeler
const tags = [...html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)].filter((m) => /\shidden(\s|=|>|$)/.test(m[2] + ">"));
const subjects = [];
for (const [, tag, attrs] of tags) {
  const id = /\sid="([^"]+)"/.exec(attrs);
  const cls = /\sclass="([^"]+)"/.exec(attrs);
  const element = id ? `#${id[1]}` : `<${tag} class="${cls ? cls[1] : ""}">`;
  if (id) subjects.push({ tag, element, token: `#${id[1]}`, label: `#${id[1]}` });
  if (cls) for (const c of cls[1].split(/\s+/).filter(Boolean)) subjects.push({ tag, element, token: `.${c}`, label: `.${c} (${id ? "#" + id[1] : tag})` });
}
check("index.html'de hidden öznitelikli öğe bulundu (ayrıştırıcı çalışıyor)", subjects.length > 20, String(subjects.length));

// Öğe başına: öğenin herhangi bir belirteci (id/sınıf) display'i görünür bırakıyorsa, öğenin herhangi bir belirteci için
// bir [hidden] kuralı olmalı (ör. .icon-btn { display: grid } + .library-search-clear[hidden] { display: none }).
const byElement = new Map();
for (const subject of subjects) {
  const key = subject.element;
  if (!byElement.has(key)) byElement.set(key, []);
  byElement.get(key).push(subject);
}
const offenders = [];
for (const [element, tokens] of byElement) {
  const shown = tokens.flatMap((t) => visibleDisplayRules(t.token).map((r) => `${t.token}: ${displayOf(r.body)}`));
  const covered = tokens.some((t) => hasHiddenRule(t.token));
  if (shown.length && !covered && !globalHidden) offenders.push(`${element}: display kuralı (${shown.join(", ")}) var ama [hidden] kuralı YOK`);
}
check("hidden öğelerin hiçbirinin display kuralı [hidden]'ı ezmiyor", offenders.length === 0, offenders.join(" | "));

// --- paylaşım kartı (hata: boş kart görünüyordu)
check("paylaşım kartı HTML'de hidden başlıyor", /<section class="share-card" id="share-card" hidden/.test(html));
check("paylaşım kartı: .share-card display kuralı VAR ve .share-card[hidden] { display: none } da var",
  visibleDisplayRules(".share-card").length > 0 && hasHiddenRule(".share-card"));

// Sınama aracının kendisi: ezilen bir örneği yakalıyor mu?
const fakeRules = [{ selectors: [".x"], body: "display: flex;" }];
const caught = fakeRules.some((r) => r.selectors.includes(".x") && displayOf(r.body) === "flex")
  && !rules.some((r) => r.selectors.includes(".x[hidden]"));
check("araç doğrulaması: [hidden] kuralsız display bildiren sınıf ezici sayılır", caught && displayOf("a:b; display:flex") === "flex"
  && displayOf("display: none") === "none" && displayOf("color:red") === null);

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
