// Klip yardımcıları: kapak karesi seçimi (clipframe.js), sahne klibi senkronu (stage.js clipSync), klip deposu ayarları (clipstore.js),
// "clip" kapak kaynağının önceliği (cover.js), kapak yedeği, ve uygulamadaki bağlantılar (kaynak taraması).   node tests\clipframe_test.mjs

import { readFileSync } from "node:fs";
import { frameTimes, squareCrop, frameStats, goodFrame, frameScore, DARK_LUMA } from "../frontend/js/clipframe.js";
import { clipSync, CLIP_DRIFT_S } from "../frontend/js/stage.js";
import { settingOn, summarizeClips, clipMode, nextClipMode, storedClipMode, CLIP_KEEP_KEY, STAGE_CLIP_KEY, PLAYER_CLIP_KEY } from "../frontend/js/clipstore.js";
import { CoverManager, SOURCES } from "../frontend/js/cover.js";
import { encodeBackup, parseBackup } from "../frontend/js/coverbackup.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").split(String.fromCharCode(13)).join("");

// ------------------------------------------------------------------ kapak karesi
{
  const times = frameTimes(200);
  check("kare zamanları: ortalardan başlar, intro/son atlanır", times[0] === 70 && times.every((t) => t >= 0.5 && t <= 199.5) && times.length === 4, times.join());
  check("kısa klip: tek orta kare", frameTimes(1.5).join() === "0.75");
  check("süresi bilinmeyen klip (webm): baştan birkaç saniye", frameTimes(Infinity).join() === "1,4" && frameTimes(NaN).join() === "1,4");
  const wide = squareCrop(1920, 1080);
  const tall = squareCrop(720, 1280);
  check("ortadan kare kırpma (yatay ve dikey video)", wide.size === 1080 && wide.sx === 420 && wide.sy === 0 && tall.size === 720 && tall.sx === 0 && tall.sy === 280);
  const rgba = (fn, n = 64) => Uint8ClampedArray.from({ length: n * 4 }, (_, i) => (i % 4 === 3 ? 255 : fn(Math.floor(i / 4))));
  const black = frameStats(rgba(() => 4));
  const flat = frameStats(rgba(() => 180));
  const busy = frameStats(rgba((i) => (i % 2 ? 230 : 40)));
  check("siyah kare 'iyi' sayılmaz", !goodFrame(black) && black.luma < DARK_LUMA);
  check("tek renk (düz) kare 'iyi' sayılmaz", !goodFrame(flat) && flat.spread < 0.01);
  check("ayrıntılı kare 'iyi' ve puanı en yüksek", goodFrame(busy) && frameScore(busy) > frameScore(flat) && frameScore(flat) > frameScore(black));
  check("boş örnek çökmez", frameStats(new Uint8ClampedArray(0)).luma === 0);
}

// ------------------------------------------------------------------ sahne klibi senkronu
{
  const base = { videoTime: 10, videoDuration: 200, paused: false, seeking: false, audioTime: 10.1, playing: true, rate: 1 };
  check("küçük kayma: dokunulmaz (her karede atlama yok)", clipSync(base).seekTo === null && !clipSync(base).play && !clipSync(base).pause);
  check(`büyük kayma (> ${CLIP_DRIFT_S} sn): sese atlar`, clipSync({ ...base, audioTime: 42 }).seekTo === 42);
  check("video zaten konumlanıyorsa yeniden atlamaz", clipSync({ ...base, audioTime: 42, seeking: true }).seekTo === null);
  check("ses çalıyor, video duruyor: oynat", clipSync({ ...base, paused: true }).play === true);
  check("ses durdu: videoyu durdur", clipSync({ ...base, playing: false }).pause === true && clipSync({ ...base, playing: false }).play === false);
  check("klip sesten kısa: sonunda durur, atlamaz", (() => { const a = clipSync({ ...base, audioTime: 250 }); return a.pause && a.seekTo === null; })());
  check("tempo videoya geçer (sınırlı)", clipSync({ ...base, rate: 0.8 }).rate === 0.8 && clipSync({ ...base, rate: 9 }).rate === 4 && clipSync({ ...base, rate: 0 }).rate === 1);
  check("süre bilinmeyen video da senkronlanır", clipSync({ ...base, videoDuration: NaN, audioTime: 30 }).seekTo === 30);
}

// ------------------------------------------------------------------ ayarlar ve özet
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  check("klip saklama ve sahne klibi varsayılan AÇIK", settingOn(storage, CLIP_KEEP_KEY) && settingOn(storage, STAGE_CLIP_KEY));
  storage.setItem(CLIP_KEEP_KEY, "0");
  check("'0' kapatır, diğer ayar etkilenmez", !settingOn(storage, CLIP_KEEP_KEY) && settingOn(storage, STAGE_CLIP_KEY));
  check("depolama yok/atıyor: açık say (çökmez)", settingOn(null, CLIP_KEEP_KEY) && settingOn({ getItem() { throw new Error("x"); } }, CLIP_KEEP_KEY));
  check("klip özeti", JSON.stringify(summarizeClips([{ size: 10 }, { size: 5 }, {}])) === JSON.stringify({ count: 3, bytes: 15 }) && summarizeClips(null).count === 0);
  const modes = new Map();
  const ms = { getItem: (k) => (modes.has(k) ? modes.get(k) : null), setItem: (k, v) => modes.set(k, String(v)) };
  check("sahne klibi varsayılan: karartılmış (eski '1' de)", clipMode(ms) === "dim" && (ms.setItem(STAGE_CLIP_KEY, "1"), clipMode(ms)) === "dim" && clipMode(null) === "dim");
  check("film düğmesi sırası: karartılmış -> tam -> gizli -> karartılmış", nextClipMode("dim") === "full" && nextClipMode("full") === "off" && nextClipMode("off") === "dim" && nextClipMode("x") === "dim");
  check("görünüm saklanır ve geri okunur (eski '0' = gizli korunur)", ["dim", "full", "off"].every((m) => (ms.setItem(STAGE_CLIP_KEY, storedClipMode(m)), clipMode(ms)) === m) && storedClipMode("off") === "0");
}

// ------------------------------------------------------------------ "clip" kapak kaynağı: önceliği
{
  check("'clip' geçerli kapak kaynağı", SOURCES.includes("clip"));
  const makeStore = (initial = {}) => {
    const data = new Map(Object.entries(initial));
    return {
      data,
      async getMany(ids) { return new Map(ids.filter((id) => data.has(id)).map((id) => [id, data.get(id)])); },
      async put(id, record) { data.set(id, record); },
      async delete(ids) { for (const id of ids) data.delete(id); },
    };
  };
  const blob = (text) => new Blob([text], { type: "image/jpeg" });
  const store = makeStore({ u: { source: "user", blob: blob("u") }, e: { source: "embedded", blob: blob("e") }, n: { source: "none" } });
  const manager = new CoverManager({ store, fetchEmbedded: async () => null, makeUrl: () => "blob:x", revokeUrl: () => {} });
  check("kullanıcının kapağının ÜSTÜNE yazmaz", (await manager.setClipFrame("u", blob("f"))) === false && manager.sourceOf("u") === "user");
  check("dosyanın gömülü kapağının ÜSTÜNE yazmaz", (await manager.setClipFrame("e", blob("f"))) === false && manager.sourceOf("e") === "embedded");
  check("'kapak yok' kaydında kare kaydedilir", (await manager.setClipFrame("n", blob("f"))) === true && manager.sourceOf("n") === "clip" && store.data.get("n").source === "clip");
  check("yeni şarkıda (kayıt yok) kare kaydedilir ve resim olarak görünür", (await manager.setClipFrame("yeni", blob("f"))) === true && manager.hasImage("yeni"));
  await manager.setImage("yeni", blob("k"), "user");
  check("sonra seçilen kullanıcı resmi klip karesini geçer", manager.sourceOf("yeni") === "user");
  await manager.load(["r"]);
  await manager.setImage("r", blob("x"), "clip");
  check("yedekten 'clip' geri yüklenebilir (kaynak korunur)", manager.sourceOf("r") === "clip");
  const id = "a".repeat(64);
  const parsed = parseBackup(encodeBackup([{ id, source: "clip", mime: "image/jpeg", data: "AAAA" }]));
  check("kapak yedeği 'clip' kapaklarını da taşır", parsed.ok && parsed.entries.length === 1 && parsed.entries[0].source === "clip");
}

// ------------------------------------------------------------------ uygulamadaki bağlantılar (kaynak taraması)
{
  const app = read("../frontend/js/app.js");
  const fnBody = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) return "";
    const next = app.indexOf("\nfunction ", start + 10);
    const nextAsync = app.indexOf("\nasync function ", start + 10);
    const ends = [next, nextAsync].filter((i) => i > 0);
    return app.slice(start, ends.length ? Math.min(...ends) : undefined);
  };
  const upload = fnBody("handleUpload");
  const firstAwait = upload.indexOf("await ");
  const qualityAt = upload.indexOf('el("upload-quality")');
  check("handleUpload kaliteyi HİÇBİR await'ten önce okur (paylaşım kartının kalite seçimi korunur)", qualityAt > 0 && firstAwait > qualityAt, `${qualityAt} < ${firstAwait}`);
  check("handleUpload: klipte ses ayıklanır, kalite yüklemeye geçer", /extractClipAudio\(file, status\)/.test(upload) && /api\.uploadSong\(file, [\s\S]*?quality\)/.test(upload));
  check("ayıklanamayan KÜÇÜK klip eskisi gibi olduğu gibi yüklenir; büyükse uyarı", /else if \(file\.size > SHARE_MAX_BYTES\)/.test(upload) && /m\.REASON_TEXT\)\.catch\(\(\) => \(\{\}\)\)\)\[extracted\.reason\]/.test(upload));
  check("nadir modüller geç yüklenir (açılışta ayrıştırılmaz): klip ayıklayıcı, kapak karesi, Takeout okuyucu",
    !/^import .* from "\.\/(mp4audio|clipframe|zipread)\.js";/m.test(app) && /lazyModule\("\.\/mp4audio\.js"\)/.test(app)
    && /lazyModule\("\.\/clipframe\.js"\)/.test(app) && /lazyModule\("\.\/zipread\.js"\)/.test(app));
  check("geç yüklenen modüller yine çevrimdışı kabukta", ['"./js/mp4audio.js"', '"./js/clipframe.js"', '"./js/zipread.js"'].every((m) => read("../frontend/sw.js").includes(m)));
  check("ayıklama iptal edilebilir (AbortController + düğme)", /signal: clipAbort\.signal/.test(fnBody("extractClipAudio")) && /on\("upload-cancel", "click"/.test(app));
  check("kapak karesi + klip saklama yalnız klip yüklemesinde, saklama ayara bağlı", /if \(clip && lastUploadedId\) afterClipUpload/.test(upload) && /settingOn\(safeStorage\(\)\.storage, CLIP_KEEP_KEY\)/.test(fnBody("afterClipUpload")));
  check("klibin kendi kapağı varsa kare alınmaz", /if \(!\(meta && meta\.hasCover\)\)/.test(fnBody("afterClipUpload")));
  check("şarkı silinince sahne klibi de gider", /clipStore\.remove\(gone\)/.test(app));
  check("sahne kapanınca klip bırakılır (video durur, adres serbest)", /stageClipUnload\(\)/.test(fnBody("closeStageDom")) && /URL\.revokeObjectURL\(stageClip\.url\)/.test(fnBody("stageClipUnload")));
  check("senkron mevcut döngüden (stageTick) ve çal/duraklat anında; ek döngü yok", /stageClipTick\(time\)/.test(fnBody("stageTick")) && /stageClipTick\(engine\.visualTime, true\)/.test(fnBody("setPlayIcon")) && !/requestAnimationFrame/.test(fnBody("stageClipTick")));
  check("uygulama arka plandayken video oynamaz", /playing: engine\.playing && !document\.hidden/.test(fnBody("stageClipTick")));
  check("tüm klipleri silmek onay ister", /window\.confirm\(/.test(app.slice(app.indexOf('on("clip-clear"'), app.indexOf('on("clip-clear"') + 600)));
  const clipOpen = app.slice(app.indexOf('on("clip-open", "click"'), app.indexOf('on("clip-open", "click"') + 600);
  check("oynatıcıdaki 'Klip ekle' düğmesi: klip yoksa klip seçtirir, klip varsa gizlenir (yerine Klip | Mikser anahtarı)",
    /openStage\("full"\)/.test(clipOpen) && /el\("clip-file"\)\.click\(\)/.test(clipOpen) && /chip\.hidden = clipChipHas;/.test(fnBody("refreshClipChip")));
  check("şarkı açılınca klip oynatıcıda DOĞRUDAN yüklenir", /refreshClipChip\(\);\n\s*playerClipLoad\(\);/.test(app));
  check("oynatıcı klibi mevcut döngüden senkron (duraklatılmışken sarınca da), ek döngü yok",
    /stageTick\(time\);\n\s*playerClipTick\(time\);/.test(app) && /playerClipTick\(engine\.visualTime, true\)/.test(fnBody("setPlayIcon")) && !/requestAnimationFrame/.test(fnBody("playerClipTick")));
  check("oynatıcı ekranı ya da video görünmüyorken (kitaplık, sahne, antrenör, arka plan) video durur",
    /!document\.hidden && !el\("view-player"\)\.hidden && !stageOpen/.test(fnBody("playerClipTick")) && /video\.offsetWidth > 0/.test(fnBody("playerClipTick"))
    && /playing: engine\.playing && shown/.test(fnBody("playerClipTick")));
  check("ekran değişince (kitaplığa dönünce müzik sürer, döngü durur) video hemen durdurulur",
    /if \(afterViewChange\) afterViewChange\(\);/.test(fnBody("showView")) && /afterViewChange = \(\) => playerClipTick\(engine\.visualTime, true\);/.test(app));
  check("oynatıcı klibi bırakılır: şarkı silinince, klip kaldırılınca, hepsi silinince",
    /gone\.includes\(playerClip\.id\)\) playerClipUnload\(\)/.test(app) && /URL\.revokeObjectURL\(playerClip\.url\)/.test(fnBody("playerClipUnload")));
  check("Klip düğmesi şarkı açılınca güncellenir", /syncCoverUi\(\);\n\s*refreshArtwork\(\);\n\s*refreshClipChip\(\);/.test(app));
  check("Sahne düğmesi son seçilen görünümle açılır (olay nesnesi görünüm sanılmaz)", /on\("stage-open", "click", \(\) => openStage\(\)\)/.test(app) && /view === "full" \? "full" : clipMode\(/.test(fnBody("openStage")));
  const html = read("../frontend/index.html");
  check("oynatıcıda Klip düğmesi var", /id="clip-open"/.test(html));
  check("oynatıcı klibi sessiz ve satır içi", /<video class="player-clip-video" id="player-clip-video" muted playsinline/.test(html));
  const css = read("../frontend/css/styles.css");
  check("Klip | Mikser anahtarı: yalnız klibi olan şarkıda, iki düğme, seçim saklanır",
    /id="view-switch"[^>]*hidden/.test(html) && /id="view-switch-clip"/.test(html) && /id="view-switch-mixer"/.test(html)
    && /el\("view-switch"\)\.hidden = !has;/.test(fnBody("playerClipApply"))
    && /on\("view-switch-clip", "click", \(\) => setPlayerClipPref\(true\)\)/.test(app) && /on\("view-switch-mixer", "click", \(\) => setPlayerClipPref\(false\)\)/.test(app)
    && /PLAYER_CLIP_KEY, on \? "1" : "0"/.test(fnBody("setPlayerClipPref")));
  check("klip görünümü: video akışta ve NET (karartma/arka plan yok), kanallar/mikser/döngü gizlenir",
    /\.player-clip \{\s*position: relative; flex: 0 1 auto;/.test(css) && !/\.player-clip::after/.test(css)
    && /#view-player\.clip-on \.mix-bar, #view-player\.clip-on \.mix-notice, #view-player\.clip-on \.channels, #view-player\.clip-on \.loop-bar \{ display: none; \}/.test(css)
    && !/opacity: 0\.8/.test(css.slice(css.indexOf(".player-clip-video"), css.indexOf(".player-clip-video") + 200)));
  check("mikser görünümünde kanallar eskisi gibi (klip görünümü dışında kanal kuralı yok)", !/clip-on #channels|clip-on \.channels \{ position/.test(css));
  check("videoya ya da köşe düğmesine dokununca tam ekran",
    /on\("player-clip-video", "click", \(\) => openStage\("full"\)\)/.test(app) && /on\("player-clip-full", "click", \(\) => openStage\("full"\)\)/.test(app) && /id="player-clip-full"/.test(html));
  check("anahtar ve video akor şeridinin üstünde (Sahne satırının hemen altında)",
    html.indexOf('id="player-method-row"') < html.indexOf('id="view-switch"') && html.indexOf('id="player-clip"') < html.indexOf('id="chordstrip"'));
  check("antrenör açıkken anahtar ve video gizli", /#view-player\.trainer-on \.view-switch, #view-player\.trainer-on \.player-clip \{ display: none; \}/.test(css));
  check("Ayarlar: 'klip görünümünde açılsın' anahtarı (yeni anahtar; v79/v80 seçimi taşınmaz, eski anahtarlar silinmez)",
    /id="setting-clipview"/.test(html) && !/setting-mixerclip/.test(html + app) && PLAYER_CLIP_KEY === "stem-mikser.clipview"
    && !/removeItem\(\s*"stem-mikser\.(playerclip|mixerclip)"/.test(app));
  check("sahne videosu sessiz ve satır içi (ses yalnız mikserden)", /<video class="stage-clip" id="stage-clip" muted playsinline/.test(html));
  const sw = read("../frontend/sw.js");
  check("yeni modüller çevrimdışı kabukta", ['"./js/clipframe.js"', '"./js/clipstore.js"', '"./js/mp4audio.js"'].every((m) => sw.includes(m)));
  for (const mod of ["clipframe.js", "clipstore.js", "mp4audio.js"]) {
    const text = read(`../frontend/js/${mod}`);
    check(`${mod}: ağa bağlanmaz (klip/kapak telefonda kalır)`, !/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(text));
  }
}

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
