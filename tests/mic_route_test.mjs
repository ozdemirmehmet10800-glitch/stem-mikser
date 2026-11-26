// Mikrofon kapanınca ses çıkışı rotası (app.js settleOutputAfterMic): kaynak taraması. Çalarken ASKIYA ALINMAZ, mikrofon açıkken
// çalışmaz, yalnız mikrofon gerçekten açıkken kapatılınca devreye girer, çalmayı etkileyemeyecek şekilde try/catch içinde.
//   node tests\mic_route_test.mjs

import { readFileSync } from "node:fs";
import { appSource } from "./appsource.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const app = appSource();                 // app.js + js/ui/*.js (satır sonları LF)
const body = /function settleOutputAfterMic\(\) \{([\s\S]*?)\n\}\n/.exec(app);
check("settleOutputAfterMic var", Boolean(body));
const text = body ? body[1] : "";
check("çalarken (engine.playing) askıya almaz", /engine\.playing/.test(text) && /return;/.test(text));
check("mikrofon yeniden açıldıysa (trainerMic.active) dokunmaz", /trainerMic\.active/.test(text));
check("yalnız çalışan bağlamı askıya alır (suspend), kapatmaz (close yok)", /ctx\.suspend\(\)/.test(text) && !/ctx\.close\(/.test(text));
check("hata çalmayı etkilemez (try/catch)", /try \{[\s\S]*\} catch/.test(text));
const stop = /function stopTrainerMic\(reason = ""\) \{([\s\S]*?)\n\}\n/.exec(app)[1];
check("yalnız mikrofon açıkken kapatılınca çağrılır", /if \(trainerMic\.active\) \{\s*trainerMic\.stop\(\);\s*settleOutputAfterMic\(\);\s*\}/.test(stop));
const engine = readFileSync(new URL("../frontend/js/engine.js", import.meta.url), "utf8");
check("engine.ensureContext askıdaki bağlamı sürdürür (sonraki çalma çıkışı yeniden kurar)", /state === "suspended"\) \{\s*await this\.ctx\.resume\(\)/.test(engine));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
