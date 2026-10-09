// ÇEKİRDEK ÇALMA antrenörden BAĞIMSIZ olmalı (SW v64): telefonda "ses yok" şikâyeti sonrası, normal çalma yolunun (antrenör kapalı / hiç
// açılmamış) hiçbir antrenör koduna bağlı olmadığı ve kanca hatalarından etkilenmediği sabitlenir. app.js'teki GERÇEK kaynak çıkarılıp sahte
// motor / medya ile çalıştırılır.
//
//     node tests\playback_core_test.mjs

import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");
const slice = (from, to) => {
  const a = app.indexOf(from);
  const b = app.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`kaynak bulunamadı: ${from}`);
  return app.slice(a, b);
};
const hooksSrc = slice("const playHooks = {", "function setPlayIcon(");
const coreSrc = slice("let playStarting = null;", "// Çıkış denetimi");
const toggleSrc = slice("async function togglePlayback() {", 'on("play", "click", togglePlayback);');
const noComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// --- kaynak kuralları: çekirdek çalma antrenör adı geçirmez (yalnız playHooks / safeHook)
for (const [name, src] of [["startPlayback + runStartPlayback + stopPlayback", coreSrc], ["togglePlayback", toggleSrc]]) {
  check(`${name}: 'trainer' / 'Trainer' / 'tr-' geçmez (antrenöre doğrudan bağ yok)`, !/trainer|Trainer|\btr-/.test(noComments(src)));
}
check("çekirdek yalnız safeHook ile kanca çağırır (begin / end / stop)", ["begin", "end", "stop"].every((hook) => coreSrc.includes(`safeHook("${hook}")`)));
check("setPlayIcon antrenöre yalnız safeHook('icon') ile bağlı", /function setPlayIcon\([\s\S]*?safeHook\("icon", playing\)/.test(app) && !/function setPlayIcon\([\s\S]{0,400}paintTrainerPlay/.test(app));
check("antrenör varsayılan KAPALI: bayrak '1' değilse söyle düğmesi görünmez (trainerSupported -> trainerEnabled)", /function trainerEnabled\(\)[\s\S]*?=== "1"/.test(app) && /function trainerSupported\(\)[\s\S]*?return trainerEnabled\(\) &&/.test(app));
check("bayrak yoksa / okunamazsa KAPALI (catch -> false)", /function trainerEnabled\(\)[\s\S]*?catch \{\s*return false;/.test(app));

// --- gerçek kaynağı sahte motorla çalıştır
function build({ playImpl, hooks = {}, hookThrows = false } = {}) {
  const calls = [];
  const state = { playing: false, rejectNext: false };
  const engine = {
    get playing() { return state.playing; },
    async play() {
      calls.push("engine.play");
      if (playImpl) return playImpl(state, calls);
      await Promise.resolve();
      state.playing = true;
      return undefined;
    },
    pause() { calls.push("engine.pause"); state.playing = false; },
  };
  const media = {
    startKeeper() { calls.push("keeper.start"); }, stopKeeper() { calls.push("keeper.stop"); },
    setPlaybackState(on) { calls.push(`media.state:${on}`); }, updatePosition() { calls.push("media.pos"); },
  };
  const metronome = { resync() { calls.push("metro.resync"); }, start() { calls.push("metro.start"); }, stop() { calls.push("metro.stop"); } };
  const wakeLock = { request() { calls.push("wake.request"); } };
  const diag = { note(kind, text) { calls.push(`diag:${kind}:${text}`); } };
  const setPlayIcon = (on) => calls.push(`icon:${on}`);
  const releasePlaybackWake = () => calls.push("wake.release");
  const verifyOutputSoon = () => calls.push("verify");
  const factory = new Function("engine", "media", "metronome", "wakeLock", "diag", "setPlayIcon", "releasePlaybackWake", "verifyOutputSoon", "stubHooks",
    `${hooksSrc}\n${coreSrc}\n${toggleSrc}\nif (stubHooks) Object.assign(playHooks, stubHooks);\nreturn { playHooks, startPlayback, stopPlayback, togglePlayback };`);
  const wrapped = {};
  if (hookThrows) for (const name of ["begin", "end", "stop", "icon"]) wrapped[name] = () => { throw new Error(`kanca ${name} patladı`); };
  return { calls, state, api: factory(engine, media, metronome, wakeLock, diag, setPlayIcon, releasePlaybackWake, verifyOutputSoon, hookThrows ? wrapped : hooks) };
}

{
  const t = build();
  const promise = t.api.startPlayback();
  const syncCalls = [...t.calls];
  await promise;
  check("antrenör YOKKEN normal çalma: motor çalar, simge 'çalıyor', kilit ekranı durumu, ekran kilidi, denetim", t.state.playing && t.calls.includes("engine.play") && t.calls.includes("icon:true") && t.calls.includes("media.state:true") && t.calls.includes("wake.request") && t.calls.includes("verify"), t.calls.join(","));
  check("sessiz eleman (keeper) kullanıcı hareketi içinde, motor beklenmeden SENKRON başlar", syncCalls[0] === "keeper.start" && syncCalls.includes("engine.play"), syncCalls.join(","));
  check("sıra: keeper -> medya durumu -> engine.play -> metronom -> simge", t.calls.indexOf("keeper.start") < t.calls.indexOf("engine.play") && t.calls.indexOf("engine.play") < t.calls.indexOf("metro.start") && t.calls.indexOf("metro.start") < t.calls.indexOf("icon:true"));
}
{
  const t = build({ hookThrows: true });
  await t.api.startPlayback();
  check("TÜM kancalar hata verse bile çalma başlar (simge + motor)", t.state.playing && t.calls.includes("icon:true"), t.calls.join(","));
  check("kanca hatası tanı günlüğüne yazılır, çalmayı bozmaz", t.calls.some((c) => c.startsWith("diag:error:kanca begin")));
  t.api.stopPlayback();
  check("duraklatma da kanca hatasından etkilenmez (motor durur, ekran kilidi bırakılır)", !t.state.playing && t.calls.includes("engine.pause") && t.calls.includes("wake.release"));
}
{
  const t = build();
  const a = t.api.startPlayback();
  const b = t.api.startPlayback();
  await Promise.all([a, b]);
  check("çift dokunuş: engine.play TEK kez (çift kaynak kurulmaz), ikinci çağrı aynı sözü bekler", t.calls.filter((c) => c === "engine.play").length === 1);
  await t.api.startPlayback();                                   // zaten çalıyor: motor kendi korumasıyla geçer
  check("söz bitince bayrak kendiliğinden temizlenir (yeni çağrı yeniden motoru çağırır)", t.calls.filter((c) => c === "engine.play").length === 2);
}
{
  let fail = true;
  const t = build({ playImpl: async (state) => { if (fail) throw new Error("çözme hatası"); state.playing = true; } });
  let rejected = false;
  try { await t.api.startPlayback(); } catch { rejected = true; }
  fail = false;
  await t.api.startPlayback();
  check("motor hata verirse (reddedilen söz) bayrak TAKILI KALMAZ: sonraki dokunuş çalmayı başlatır", rejected && t.state.playing && t.calls.includes("icon:true"), t.calls.join(","));
}
{
  const t = build({ playImpl: async () => undefined });           // motor çalmayı başlatmadı (kanal yok / bağlam kesildi)
  await t.api.startPlayback();
  check("motor çalmadıysa simge 'çalıyor' DEMEZ, keeper kapatılır", !t.calls.includes("icon:true") && t.calls.includes("icon:false") && t.calls.includes("keeper.stop"), t.calls.join(","));
}
{
  const t = build({ hooks: { begin() {}, end() {}, stop() {}, icon() {} } });
  await t.api.togglePlayback();
  check("togglePlayback: durmuşken başlatır", t.state.playing);
  await t.api.togglePlayback();
  check("togglePlayback: çalarken duraklatır", !t.state.playing && t.calls.includes("engine.pause"));
}

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
