// Kapaklar (js/cover.js): otomatik kapak (aynı ad = aynı renk), boyut, MusicBrainz arama/ayrıştırma (SENTETİK yanıt), hız sınırı ve
// CoverManager (öncelik: kullanıcı > gömülü > otomatik; "kapak yok" bir kez sorulur; sürüm geçişinde veri korunur).
//   node tests\cover_test.mjs

import {
  hash32, normTitle, coverLetter, autoCoverModel, autoCoverCss, drawAutoCover, fitSize, searchTerms, mbSearchUrl,
  parseCandidates, caaFrontUrl, Throttle, CoverManager, MB_MAX_CANDIDATES, MB_CLIENT, MB_MIN_INTERVAL_MS,
} from "../frontend/js/cover.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

// ---- otomatik kapak
check("hash32 deterministik ve 32 bit", hash32("abc") === hash32("abc") && hash32("abc") !== hash32("abd") && hash32("x") <= 0xffffffff);
check("normTitle: boşluk/büyük-küçük önemsiz", normTitle("  Deneme   ŞARKI ") === normTitle("deneme şarkı"));
const a1 = autoCoverModel("Deneme Şarkısı");
const a2 = autoCoverModel("  deneme şarkısı ");
check("aynı ad (biçim farkı dahil) HEP aynı renk", JSON.stringify({ ...a1, letter: 0 }) === JSON.stringify({ ...a2, letter: 0 }) && a1.c1 === a2.c1 && a1.c2 === a2.c2);
check("farklı adlar çoğunlukla farklı renk", new Set(["A", "B", "C", "D", "E", "F", "G", "H"].map((t) => autoCoverModel(`Şarkı ${t}`).c1)).size >= 6);
check("harf: ilk harf büyük, Türkçe i -> İ, ı -> I", coverLetter("izmir") === "İ" && coverLetter("ılık") === "I" && coverLetter("  şarkı") === "Ş");
check("harf: ilk karakter simgeyse ilk harf/rakam alınır, hiç yoksa ♪", coverLetter("(Live) Düet") === "L" && coverLetter("007") === "0" && coverLetter("---") === "♪" && coverLetter("") === "♪");
check("harf: Japonca ilk karakter", coverLetter("桜の花") === "桜");
const css = autoCoverCss(a1);
check("CSS: gradyan + ışık, geçerli renkler", /^radial-gradient\(.*\), linear-gradient\(\d+deg, hsl\(/.test(css), css.slice(0, 60));
const lightness = (hsl) => Number(/(\d+)%\)$/.exec(hsl)[1]);
let darkEnough = true;
for (let i = 0; i < 200; i += 1) { const m = autoCoverModel(`Şarkı ${i}`); darkEnough = darkEnough && lightness(m.c1) <= 34 && lightness(m.c2) <= 22; }
check("200 adın hepsinde renkler koyu (beyaz harf okunur)", darkEnough);

const ops = [];
const fakeCtx = {
  createLinearGradient: (...a) => { ops.push(["lin", a.length]); return { addColorStop: (o, c) => ops.push(["stop", c]) }; },
  createRadialGradient: (...a) => { ops.push(["rad", a.length]); return { addColorStop: () => {} }; },
  fillRect: () => ops.push(["rect"]), fillText: (t) => ops.push(["text", t]),
  set fillStyle(v) {}, set font(v) { ops.push(["font", v]); }, set textAlign(v) {}, set textBaseline(v) {},
};
drawAutoCover(fakeCtx, 512, a1);
check("canvas çizimi: gradyan + harf", ops.some((o) => o[0] === "text" && o[1] === a1.letter) && ops.filter((o) => o[0] === "rect").length === 2 && ops.some((o) => o[0] === "stop" && o[1] === a1.c1));

// ---- boyut
check("fitSize: büyük küçülür, oran korunur", JSON.stringify(fitSize(3000, 1500, 384)) === JSON.stringify({ w: 384, h: 192 }));
check("fitSize: küçük resim büyütülmez", JSON.stringify(fitSize(100, 80, 384)) === JSON.stringify({ w: 100, h: 80 }));
check("fitSize: bozuk girdi en az 1x1", fitSize(0, NaN).w === 1 && fitSize(-5, 3).h >= 1);

// ---- MusicBrainz arama
const terms = searchTerms("Sanatçı Adı - Şarkı Adı (Official Video) [HD]");
check("searchTerms: 'Sanatçı - Şarkı' ve parantezli notlar atılır", terms.artist === "Sanatçı Adı" && terms.title === "Şarkı Adı", JSON.stringify(terms));
check("searchTerms: tire yoksa yalnız ad", JSON.stringify(searchTerms("Yalnız Ad")) === JSON.stringify({ artist: "", title: "Yalnız Ad" }));
check("searchTerms: feat. atılır, birden çok tire", searchTerms("A - B - C feat. D").title === "B - C");
check("searchTerms: boş/null güvenli", searchTerms(null).title === "" && searchTerms("").artist === "");
const url = mbSearchUrl({ artist: "Sanatçı", title: "Şarkı" });
check("mbSearchUrl: HTTPS musicbrainz.org + kayıt araması + json", url.startsWith("https://musicbrainz.org/ws/2/recording/?query=") && url.includes("fmt=json"));
check("mbSearchUrl: tırnak/ters bölü sorguyu bozmaz (kaçırılır)", !decodeURIComponent(mbSearchUrl({ artist: "A\"B", title: "C\\D" })).includes("\\") && !/"[^"]*"[^"]*"[^"]*"[^"]*"[^"]*"/.test(decodeURIComponent(mbSearchUrl({ artist: "A\"B", title: "C" }))));
check("mbSearchUrl: ad boşsa null", mbSearchUrl({ artist: "x", title: "  " }) === null);
check("mbSearchUrl: sanatçısız sorgu", !decodeURIComponent(mbSearchUrl({ title: "Şarkı" })).includes("artist:"));
check("istemci adı genel (kişisel bilgi yok)", MB_CLIENT === "StemMikser/1.0" && !/@|http|ozdemir|axton|stem-mikser\./i.test(MB_CLIENT));

const R1 = "607ff596-f98c-4de2-b745-9430be720643";
const R2 = "3c043f5a-78f4-4d5c-a88b-293bbdfc5032";
const sample = {
  recordings: [
    { id: "r1", title: "Sentetik Şarkı", "artist-credit": [{ name: "Sentetik Sanatçı" }, { name: "Konuk" }], releases: [
      { id: R1, title: "Bootluk Albüm", status: "Bootleg", date: "2020-01" },
      { id: R2, title: "Resmi Albüm", status: "Official", date: "" }] },
    { id: "r2", title: "Sentetik Şarkı", "artist-credit": [{ name: "Sentetik Sanatçı" }], releases: [{ id: R2, title: "Resmi Albüm (tekrar)", status: "Official" }, { id: "bozuk", title: "x" }] },
  ],
};
const cands = parseCandidates(sample);
check("parseCandidates: yinelenen/geçersiz sürüm elenir, Official önce", cands.length === 2 && cands[0].releaseId === R2 && cands[1].releaseId === R1, JSON.stringify(cands.map((c) => c.releaseId)));
check("parseCandidates: sanatçı birleşir, yıl dört hane", cands[1].artist === "Sentetik Sanatçı, Konuk" && cands[1].date === "2020");
check("parseCandidates: bozuk gövde güvenli", parseCandidates(null).length === 0 && parseCandidates({}).length === 0 && parseCandidates({ recordings: [{ releases: null }] }).length === 0);
const many = { recordings: [{ title: "x", releases: Array.from({ length: 30 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`, title: `S${i}` })) }] };
check(`parseCandidates: en çok ${MB_MAX_CANDIDATES}`, parseCandidates(many).length === MB_MAX_CANDIDATES);
check("caaFrontUrl: yalnız geçerli sürüm kimliği, boyut sınırlı", caaFrontUrl(R1) === `https://coverartarchive.org/release/${R1}/front-500` && caaFrontUrl(R1, 250).endsWith("front-250")
  && caaFrontUrl(R1, 999).endsWith("front-500") && caaFrontUrl("../../etc") === null && caaFrontUrl("") === null);

// ---- hız sınırı
let clock = 1000;
const slept = [];
const throttle = new Throttle(1100, { now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
await throttle.wait();
check("ilk istek beklemez", slept.length === 0);
clock += 300;
await throttle.wait();
check("ikinci istek aralığı tamamlar (1100-300)", slept.length === 1 && slept[0] === 800, JSON.stringify(slept));
clock += 5000;
await throttle.wait();
check("yeterince geçmişse beklemez", slept.length === 1);
check("MusicBrainz aralığı >= 1 sn", MB_MIN_INTERVAL_MS >= 1000);

// ---- yönetici (sahte depo / ağ)
function memStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data, puts: [], dels: [],
    async getMany(ids) { const m = new Map(); for (const id of ids) if (data.has(id)) m.set(id, data.get(id)); return m; },
    async put(id, record) { data.set(id, record); this.puts.push(id); return true; },
    async delete(ids) { for (const id of ids) data.delete(id); this.dels.push(...ids); return true; },
  };
}
const blob = (name) => ({ name, size: 10 });
let urlCount = 0;
const revoked = [];
function manager(opts = {}) {
  const changes = [];
  const m = new CoverManager({
    store: opts.store || memStore(),
    fetchEmbedded: opts.fetchEmbedded || (async () => undefined),
    canFetch: opts.canFetch || (() => true),
    onChange: (ids) => changes.push([...ids]),
    makeUrl: (b) => `blob:${b.name}-${(urlCount += 1)}`, revokeUrl: (u) => revoked.push(u),
    sleep: async () => {}, gapMs: 0,
  });
  return { m, changes };
}
const done = (id) => ({ id, state: "done" });

// depodan yükleme
{
  const store = memStore({ s1: { source: "embedded", blob: blob("e1") }, s2: { source: "none" }, s3: { source: "bilinmeyen" } });
  const { m, changes } = manager({ store });
  await m.load(["s1", "s2", "s3", "s4"]);
  check("load: resimli kayıt URL alır, 'none' kaydı URL'siz", m.hasImage("s1") && m.sourceOf("s1") === "embedded" && !m.hasImage("s2") && m.sourceOf("s2") === "none");
  check("load: bilinmeyen kaynaklı kayıt yok sayılır", m.sourceOf("s3") === null);
  check("load: onChange yalnız resim gelenler için", JSON.stringify(changes) === JSON.stringify([["s1"]]));
  await m.load(["s1"]);
  check("load: ikinci kez depoya gitmez (aynı kimlik)", changes.length === 1);
}
// depo okunamazsa otomatik kapakla sürer
{
  const { m } = manager({ store: { async getMany() { throw new Error("IndexedDB yok"); }, async put() { return false; }, async delete() { return false; } } });
  await m.load(["x"]);
  check("depo hatası: çökmez, kapak yok (otomatik)", !m.hasImage("x") && m.sourceOf("x") === null);
}
// gömülü kapak: var / yok / bilinmiyor
{
  const calls = [];
  const answers = { has: blob("kapak"), none: null, unknown: undefined };
  const store = memStore();
  const { m, changes } = manager({ store, fetchEmbedded: async (id) => { calls.push(id); return answers[id]; } });
  const songs = [done("has"), done("none"), done("unknown"), { id: "busy", state: "separating" }];
  await m.load(songs.map((s) => s.id));
  m.want(songs);
  await m.idle();
  check("kapağı olan şarkı: embedded kaydı + URL + onChange", m.sourceOf("has") === "embedded" && m.hasImage("has") && changes.some((c) => c.includes("has")));
  check("kapağı olmayan (204): 'none' kaydı kalıcı", m.sourceOf("none") === "none" && store.data.get("none").source === "none");
  check("bilinmeyen sonuç (ağ/eski sunucu): KAYIT YOK (yanlışlıkla 'kapak yok' yazılmaz)", m.sourceOf("unknown") === null && !store.data.has("unknown"));
  check("işlenmekte olan şarkı sorulmaz", !calls.includes("busy"));
  m.want(songs);
  await m.idle();
  check("ikinci want: 'none' ve 'has' bir daha sorulmaz, başarısız olan oturumda yeniden denenmez", calls.filter((c) => c === "has").length === 1 && calls.filter((c) => c === "none").length === 1 && calls.filter((c) => c === "unknown").length === 1);
}
// çevrimdışı: sorgu bekler, resume ile sürer
{
  let online = false;
  const calls = [];
  const { m } = manager({ canFetch: () => online, fetchEmbedded: async (id) => { calls.push(id); return null; } });
  await m.load(["a"]);
  m.want([done("a")]);
  await m.idle();
  check("çevrimdışı: istek atılmaz", calls.length === 0);
  online = true;
  m.resume();
  await m.idle();
  check("çevrimiçi olunca bekleyen sorgu gider", calls.length === 1 && m.sourceOf("a") === "none");
}
// eşzamanlılık sınırı
{
  let active = 0;
  let peak = 0;
  const { m } = manager({ fetchEmbedded: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return null; } });
  const songs = Array.from({ length: 8 }, (_, i) => done(`c${i}`));
  await m.load(songs.map((s) => s.id));
  m.want(songs);
  await m.idle();
  check("en çok 2 eşzamanlı sorgu (sunucuya yük bindirilmez)", peak <= 2 && songs.every((s) => m.sourceOf(s.id) === "none"), `tepe ${peak}`);
}
// öncelik: kullanıcı resmi gömülüyü ezer; sorgu sürerken seçilirse gömülü yazmaz
{
  const store = memStore();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { m, changes } = manager({ store, fetchEmbedded: async () => { await gate; return blob("gomulu"); } });
  await m.load(["p"]);
  m.want([done("p")]);
  await m.setImage("p", blob("benim"), "user");
  release();
  await m.idle();
  check("sorgu sürerken kullanıcı resmi seçildi: gömülü ÜSTÜNE YAZMAZ", m.sourceOf("p") === "user" && store.data.get("p").source === "user");
  check("kullanıcı kaydı depoda kalıcı + URL var", store.data.get("p").blob.name === "benim" && m.hasImage("p") && changes.some((c) => c.includes("p")));
  await m.setImage("p", blob("bulunan"), "found");
  check("bulunan kapak ('found') kaydedilir, eski URL bırakılır", m.sourceOf("p") === "found" && revoked.some((u) => u.includes("benim")));
  await m.setImage("p", blob("x"), "gecersiz");
  check("geçersiz kaynak 'user'a düşer", m.sourceOf("p") === "user");
}
{
  const store = memStore({ q: { source: "embedded", blob: blob("gomulu") } });
  const { m } = manager({ store });
  await m.load(["q"]);
  await m.setImage("q", blob("benim"), "user");
  check("gömülü kapağı olan şarkıda da kullanıcı seçimi önceliklidir", m.sourceOf("q") === "user" && store.data.get("q").source === "user");
}
// kaldırma: gömülü yeniden istenir
{
  const store = memStore();
  const calls = [];
  const { m } = manager({ store, fetchEmbedded: async (id) => { calls.push(id); return blob("gomulu"); } });
  await m.load(["r"]);
  await m.setImage("r", blob("benim"), "user");
  await m.clear("r");
  await m.idle();
  check("clear: kullanıcı kaydı silinir, gömülü kapak sunucudan yeniden istenir", calls.length === 1 && m.sourceOf("r") === "embedded" && store.dels.includes("r"));
}
// silinen şarkı
{
  const store = memStore({ d: { source: "embedded", blob: blob("e") } });
  const { m } = manager({ store });
  await m.load(["d"]);
  await m.drop(["d"]);
  check("drop: kayıt, bellek ve URL temizlenir", !m.hasImage("d") && m.sourceOf("d") === null && !store.data.has("d"));
}
// depo yazma hatası uygulamayı bozmaz
{
  const store = { async getMany() { return new Map(); }, async put() { throw new Error("kota"); }, async delete() {} };
  const { m } = manager({ store, fetchEmbedded: async () => blob("k") });
  await m.load(["w"]);
  m.want([done("w")]);
  await m.idle();
  check("depo dolu (put atıyor): kapak oturum boyunca bellekte, çökme yok", m.hasImage("w"));
}

// ---- kaynak taraması: gizlilik ve veri güvenliği
import { readFileSync } from "node:fs";
const store = readFileSync(new URL("../frontend/js/coverstore.js", import.meta.url), "utf8");
const cover = readFileSync(new URL("../frontend/js/cover.js", import.meta.url), "utf8");
check("coverstore: kendi veritabanı, localStorage.clear / indexedDB.deleteDatabase yok",
  /stem-mikser-covers/.test(store) && !/deleteDatabase/.test(store) && !/localStorage\s*\./.test(store));
check("cover.js: YouTube'a hiçbir istek/adres yok", !/youtube|youtu\.be|ytimg/i.test(cover) && !/youtube|ytimg/i.test(store));

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
