// Kaynak taraması yapan testler için: oynatıcının arayüz kodu = js/app.js + js/ui/*.js (2026-11-26 sadeleştirmede bölümler
// app.js'ten js/ui/ altına taşındı; davranış aynı). Satır sonları \n.
import { readFileSync, readdirSync } from "node:fs";

const js = new URL("../frontend/js/", import.meta.url);
const read = (url) => readFileSync(url, "utf8").split(String.fromCharCode(13)).join("");

export function appSource() {
  const parts = [read(new URL("app.js", js))];
  for (const name of readdirSync(new URL("ui/", js)).filter((f) => f.endsWith(".js")).sort()) {
    parts.push(read(new URL(`ui/${name}`, js)));
  }
  return parts.join("\n");
}
