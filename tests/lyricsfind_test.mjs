// "Sözleri bul" (LRCLIB) saf mantığı. SENTETİK kayıtlar ve uydurma metinler; gerçek söz yok, ağa bağlanmaz.
//
//     node tests\lyricsfind_test.mjs

import {
  lyricsSearchTerms, searchUrls, rankResults, guessLanguage, stripSynced, plainOf, searchLyrics, formatDuration, LRCLIB_SEARCH, FIND_MAX,
} from "../frontend/js/lyricsfind.js";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const same = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

// --- başlık temizleme
same("sanatçı - şarkı (Official Video)", lyricsSearchTerms("Sanatci A - Gece Yolu (Official Video)"), { artist: "Sanatci A", title: "Gece Yolu" });
same("slowed + reverb ve uzantı", lyricsSearchTerms("Band B - Cold Lake slowed + reverb.mp3"), { artist: "Band B", title: "Cold Lake" });
same("nightcore köşeli parantez", lyricsSearchTerms("Nightcore - Star Song [Lyrics]"), { artist: "", title: "Star Song" });
same("Türkçe çeviri eki ve alt çizgi", lyricsSearchTerms("Grup_C - Uzak Sehir - Turkish"), { artist: "Grup C", title: "Uzak Sehir" });
same("altyazılı (Türkçe harf sonu)", lyricsSearchTerms("Ses D - Deniz altyazılı"), { artist: "Ses D", title: "Deniz" });
same("feat. atılır", lyricsSearchTerms("E - Night Drive feat. F"), { artist: "E", title: "Night Drive" });
same("remix KORUNUR", lyricsSearchTerms("G - Rain (Remix)").title + "|" + lyricsSearchTerms("G - Rain Remix").title, "Rain|Rain Remix");
same("yalnız ad", lyricsSearchTerms("Песня Ночи"), { artist: "", title: "Песня Ночи" });

// --- adresler
const urls = searchUrls({ artist: "Band B", title: "Cold Lake" });
check("üç deneme sırası: ad+sanatçı, serbest, yalnız ad", urls.length === 3 && urls[0] === `${LRCLIB_SEARCH}?track_name=Cold%20Lake&artist_name=Band%20B`
  && urls[1] === `${LRCLIB_SEARCH}?q=Band%20B%20Cold%20Lake` && urls[2] === `${LRCLIB_SEARCH}?track_name=Cold%20Lake`, urls.join(" "));
check("sanatçı yoksa tek deneme, ad yoksa hiç", searchUrls({ title: "X" }).length === 1 && searchUrls({ artist: "Y", title: " " }).length === 0);
check("adreste yalnız lrclib ve yalnız ad/sanatçı", urls.every((u) => u.startsWith("https://lrclib.net/api/search?") && !/token|id=|email/i.test(u)));

// --- senkronlu metin
same("stripSynced", stripSynced("[ar:Biri]\n[00:01.50] satir bir\n[00:03.00][00:20.00] nakarat\n\n[01:02.345] son"), "\nsatir bir\nnakarat\n\nson");
same("plainOf: boş satırlar atılır, senkronluya düşer", plainOf({ plainLyrics: "", syncedLyrics: "[00:01.00] a  b\n\n[00:02.00] c" }), "a b\nc");

// --- sıralama
const records = [
  { id: 1, trackName: "Cold Lake (Live)", artistName: "Band B", duration: 260, plainLyrics: "canli bir\ncanli iki", syncedLyrics: null },
  { id: 2, trackName: "Cold Lake", artistName: "Band B", duration: 201, plainLyrics: "satir bir\nsatir iki\nsatir uc", syncedLyrics: "[00:01.00] satir bir" },
  { id: 3, trackName: "Cold Lake", artistName: "Baska Grup", duration: 200, plainLyrics: "baska bir", syncedLyrics: null },
  { id: 4, trackName: "Cold Lake", artistName: "Band B", duration: 200, plainLyrics: "satir bir\nsatir iki\nsatir uc" },
  { id: 5, trackName: "Cold Lake", artistName: "Band B", duration: 200, instrumental: true, plainLyrics: "" },
  { id: 6, trackName: "Cold Lake", artistName: "Band B", duration: 200, plainLyrics: null, syncedLyrics: null },
];
const ranked = rankResults(records, { artist: "Band B", title: "Cold Lake", duration: 200 });
check("enstrümantal, sözsüz ve aynı metin atılır", ranked.length === 3 && !ranked.some((r) => r.id === 5 || r.id === 6 || r.id === 4), ranked.map((r) => r.id).join());
check("en iyi: ad + sanatçı + süre + senkronlu", ranked[0].id === 2 && ranked[0].lines === 3 && ranked[0].synced === true);
check("yanlış sanatçı ve canlı kayıt geride", ranked.findIndex((r) => r.id === 3) > 0 && ranked.findIndex((r) => r.id === 1) > 0);
check("slowed sürüm (süre %30 uzun) da adla bulunur", rankResults(records, { artist: "Band B", title: "Cold Lake", duration: 290 })[0].id === 2);
check("en çok FIND_MAX aday", rankResults(Array.from({ length: 20 }, (_, i) => ({ id: i, trackName: "T", artistName: "A", plainLyrics: `metin ${i}` })), { title: "T" }).length === FIND_MAX);
check("bozuk yanıt -> boş", rankResults(null).length === 0 && rankResults({}).length === 0);

// --- dil tahmini (uydurma cümleler)
same("rusça", guessLanguage("Привет мой друг\nночью я иду"), "ru");
same("japonca", guessLanguage("夜の街を歩いて\nきみを探してる"), "ja");
same("türkçe", guessLanguage("Bu gece sen ve ben\nçok uzak değiliz artık"), "tr");
same("ingilizce", guessLanguage("You and me tonight\nI know the way is long"), "en");
same("kısa/belirsiz -> auto", guessLanguage("la la"), "auto");

// --- ağ akışı (sahte fetch)
const calls = [];
const fakeFetch = (responses) => async (url, options) => {
  calls.push({ url, options });
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return { ok: next.status === 200, status: next.status, json: async () => next.body };
};
calls.length = 0;
let found = await searchLyrics({ artist: "Band B", title: "Cold Lake" }, { fetchImpl: fakeFetch([{ status: 200, body: [] }, { status: 200, body: records }]), duration: 200 });
check("ilk deneme boşsa ikinciye geçer", found.length === 3 && calls.length === 2 && found[0].id === 2);
check("istek: çerez yok, referrer yok", calls[0].options.credentials === "omit" && calls[0].options.referrerPolicy === "no-referrer");
calls.length = 0;
found = await searchLyrics({ artist: "", title: "Yok" }, { fetchImpl: fakeFetch([{ status: 200, body: [] }]) });
check("hiçbiri yoksa boş liste", Array.isArray(found) && found.length === 0 && calls.length === 1);
let kind = "";
try { await searchLyrics({ title: "X" }, { fetchImpl: fakeFetch([{ status: 429, body: null }]) }); } catch (error) { kind = error.kind; }
check("429 -> meşgul", kind === "busy");
kind = "";
try { await searchLyrics({ artist: "A", title: "X" }, { fetchImpl: fakeFetch([new Error("x"), new Error("y"), new Error("z")]) }); } catch (error) { kind = error.kind; }
check("hepsi ağ hatası -> network", kind === "network");
found = await searchLyrics({ artist: "A", title: "X" }, { fetchImpl: fakeFetch([new Error("x"), { status: 200, body: records }]) });
check("bir deneme hata verse de sonraki bulursa sonuç döner", found.length === 3);
same("süre biçimi", [formatDuration(201), formatDuration(0), formatDuration(59.6)], ["3:21", "", "1:00"]);

// --- arayüz bağlantısı (kaynak metin denetimi)
const html = readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/js/app.js", import.meta.url), "utf8");
const sw = readFileSync(new URL("../frontend/sw.js", import.meta.url), "utf8");
check("'Sözleri bul' düğmesi ve arama kutusu var", /id="lyrics-find"/.test(html) && /id="lyrics-find-box"[^>]*hidden/.test(html)
  && /id="lyrics-q-title"/.test(html) && /id="lyrics-q-artist"/.test(html) && /id="lyrics-find-results"/.test(html));
check("gizlilik notu kutuda", /LRCLIB/.test(html) && /Başka hiçbir bilgi gitmez/.test(html.slice(html.indexOf('id="lyrics-find-box"'), html.indexOf('id="lyrics-find-box"') + 800)));
const pickStart = app.indexOf("function pickFoundLyrics");
const pickBody = pickStart < 0 ? "" : app.slice(pickStart, app.indexOf("\n}", pickStart));
check("seçilen metin düzenleyiciye gelir, hizalama kullanıcı onayıyla (otomatik gönderim yok)",
  /el\("lyrics-text"\)\.value = candidate\.text/.test(pickBody) && !/startLyricsJob|apiPost|fetch\(/.test(pickBody));
check("modül çevrimdışı kabukta", sw.includes('"./js/lyricsfind.js"'));
// app.js'te içe aktarılan ad, üst düzeyde tanımlı bir adla çakışırsa modül hiç yüklenmez (SyntaxError, uygulama boş açılır).
const declared = [...app.matchAll(/^(?:async )?function\*? (\w+)|^(?:const|let|var|class) (\w+)/gm)].map((m) => m[1] || m[2]);
const imported = [...app.matchAll(/^import \{([^}]+)\}/gm)].flatMap((m) => m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
const names = [...declared, ...imported];
const clashes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
check("app.js: içe aktarılan ve üst düzey adlar çakışmıyor", clashes.length === 0, clashes.join(","));

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
