// Kitaplık arama/süzme (frontend/js/songfilter.js). Örnekler gerçek şarkı adlarından.
//
//     node tests\songfilter_test.mjs

import { fold, queryTokens, songText, matchesTokens, filterSongs, isFiltering, separatorIndex } from "../frontend/js/songfilter.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const ZEUS = { id: "z".repeat(64), title: "Zeus Kabadayı & Rota - Çok Mutlu Bir Şarkı" };
const HAZBIN = { id: "h".repeat(64), title: "HAZBİN HOTEL - Bağımlı (Addict) - Turkish Cover (Türkçe Cover)" };
const USSEEWA = { id: "u".repeat(64), title: "Ado - うっせぇわ (Usseewa)" };
const FULLWIDTH = { id: "f".repeat(64), title: "ＡＤＯ ウッセェワ" };
const NEM = { id: "n".repeat(64), title: "NEM - slowed + reverb" };
const NOTITLE = { id: "abcdef0123456789".repeat(4), title: "" };
const SONGS = [ZEUS, HAZBIN, USSEEWA, FULLWIDTH, NEM, NOTITLE];

const find = (query, state = {}, ctx = {}) => filterSongs(SONGS, { query, ...state }, ctx).map((s) => s.title || "(adsız)");
const has = (query, song) => find(query).includes(song.title);

// --- fold: Türkçe İ/i, I/ı
check("fold: İ, I, ı, i hepsi i", fold("İsparta") === "isparta" && fold("ISPARTA") === "isparta" && fold("ısparta") === "isparta" && fold("isparta") === "isparta");
check("fold: Türkçe harfler aksansız (ş ç ğ ö ü â)", fold("Şarkı Çok Bağımlı Öğün Ürün Âlem") === "sarki cok bagimli ogun urun alem");
check("fold: NFKC tam genişlik ADO = ado", fold("ＡＤＯ") === "ado" && fold("ｱﾄﾞ") === fold("アド"));
check("fold: katakana = hiragana (アド = あど)", fold("アド") === fold("あど") && fold("ウッセェワ") === fold("うっせぇわ"));
check("fold: dakuten korunur (か ≠ が)", fold("か") !== fold("が") && fold("カ") === fold("か"));
check("fold: null/undefined/sayı patlamaz", fold(null) === "" && fold(undefined) === "" && fold(12) === "12");
check("queryTokens: boşluklar atılır, katlanır", JSON.stringify(queryTokens("  İSTANBUL   şarkı ")) === '["istanbul","sarki"]');

// --- gerçek şarkılar
check('"zeus" ve "ZEUS" Zeus şarkısını bulur', has("zeus", ZEUS) && has("ZEUS", ZEUS) && has("Zeus", ZEUS));
check('"bagimli" -> "Bağımlı" (Hazbin)', has("bagimli", HAZBIN) && has("BAĞIMLI", HAZBIN) && has("bağımlı", HAZBIN));
check('"hazbin" (noktasız) ve "HAZBİN" ve "hazbİn" Hazbin\'i bulur', has("hazbin", HAZBIN) && has("HAZBİN", HAZBIN) && has("hazbİn", HAZBIN) && has("HAZBIN", HAZBIN));
check('"sarki" -> "Şarkı" (Zeus), "cok mutlu" iki sözcük', has("sarki", ZEUS) && has("cok mutlu", ZEUS) && has("mutlu cok", ZEUS));
check('"turkce" -> "Türkçe"', has("turkce", HAZBIN));
check("Türkçe büyük I problemi: 'ISPARTA' sorgusu 'ısparta' ve 'Isparta' adını bulur", (() => {
  const a = { id: "a".repeat(64), title: "Isparta Gülü" };
  const b = { id: "b".repeat(64), title: "ısparta" };
  const c = { id: "c".repeat(64), title: "İsparta" };
  return filterSongs([a, b, c], { query: "ISPARTA" }).length === 3 && filterSongs([a, b, c], { query: "isparta" }).length === 3;
})());
check('Japonca: "うっせぇわ" ve "せぇ" parçası Usseewa\'yı bulur', has("うっせぇわ", USSEEWA) && has("せぇ", USSEEWA));
check('Japonca: katakana "ウッセェワ" sorgusu hiragana başlığı da bulur', has("ウッセェワ", USSEEWA));
check('Japonca: tam genişlik "ＡＤＯ" başlığı "ado" ve "ADO" ile bulunur', has("ado", FULLWIDTH) && has("ADO", FULLWIDTH) && has("ado", USSEEWA));
check('Latin kısım: "usseewa" Ado şarkısını bulur', has("usseewa", USSEEWA));
check("Japonca başlığı romaji ile bulma YOK (okunuş verisi başlıkta yok; bilinen sınır)", !has("usseewa", FULLWIDTH));
check("eşleşme yoksa boş", find("yokboylebirsarki").length === 0);
check("boş sorgu: hepsi, sıra korunur", find("").length === SONGS.length && find("   ").length === SONGS.length);
check("adsız şarkı kimliğinin ilk 12 karakterinden aranır (görünen ad)", find("abcdef012345").length === 1);
check("özel karakterler (&, +, parantez) düz metin sayılır, kaçış gerekmez", has("&", ZEUS) && has("+ reverb", NEM) && has("(addict)", HAZBIN) && find("(((").length === 0);

// --- favori / etiket süzmesi ve sıralama
const favs = new Set([HAZBIN.id, NEM.id]);
const tags = { [ZEUS.id]: ["tprova"], [HAZBIN.id]: ["tprova", "tturkce"], [USSEEWA.id]: ["tjapon"] };
const names = { tprova: "Prova", tturkce: "Türkçe cover", tjapon: "Japonca" };
const ctx = { isFav: (id) => favs.has(id), tagIdsOf: (id) => tags[id] || [], tagName: (tid) => names[tid] };
const titles = (list) => list.map((s) => s.title || "(adsız)");
check("favoriler ÜSTTE (kendi aralarında sunucu sırası), diğerleri sırayla", JSON.stringify(titles(filterSongs(SONGS, {}, ctx)))
  === JSON.stringify([HAZBIN.title, NEM.title, ZEUS.title, USSEEWA.title, FULLWIDTH.title, "(adsız)"]));
check("pinFavorites kapalıysa sıra aynen", titles(filterSongs(SONGS, {}, ctx, { pinFavorites: false }))[0] === ZEUS.title);
check("★ süzmesi: yalnız favoriler", JSON.stringify(titles(filterSongs(SONGS, { fav: true }, ctx))) === JSON.stringify([HAZBIN.title, NEM.title]));
check("etiket süzmesi: yalnız o etiketliler (Prova = Zeus + Hazbin, Hazbin üstte)", JSON.stringify(titles(filterSongs(SONGS, { tag: "tprova" }, ctx)))
  === JSON.stringify([HAZBIN.title, ZEUS.title]));
check("etiket adı da aranır: 'prova' sorgusu etiketli şarkıları bulur", titles(filterSongs(SONGS, { query: "prova" }, ctx)).length === 2);
check("etiket adı katlanır: 'turkce cover' etiketinden Hazbin", filterSongs(SONGS, { query: "turkce cover" }, ctx).some((s) => s === HAZBIN));
check("arama + etiket + favori birlikte (AND)", titles(filterSongs(SONGS, { query: "bagimli", tag: "tprova", fav: true }, ctx)).length === 1
  && filterSongs(SONGS, { query: "zeus", fav: true }, ctx).length === 0);
check("ctx verilmezse (favori/etiket yok) yalnız arama çalışır", filterSongs(SONGS, { query: "zeus" }).length === 1);
check("isFiltering", !isFiltering({}) && !isFiltering({ query: "  " }) && isFiltering({ query: "z" }) && isFiltering({ fav: true }) && isFiltering({ tag: "t1" }));
check("separatorIndex: favoriler sonrası ilk favori olmayan; hepsi favori/hiçbiri değilse -1", (() => {
  const list = filterSongs(SONGS, {}, ctx);
  return separatorIndex(list, ctx.isFav) === 2 && separatorIndex(filterSongs(SONGS, { fav: true }, ctx), ctx.isFav) === -1
    && separatorIndex(SONGS.filter((s) => !favs.has(s.id)), ctx.isFav) === -1;
})());
check("songText: ad + etiket adları katlanmış", songText(ZEUS, ["Prova"]).includes("prova") && songText(ZEUS).includes("kabadayi"));
check("matchesTokens", matchesTokens("zeus kabadayi", ["zeus", "kabadayi"]) && !matchesTokens("zeus", ["zeus", "rota"]));

// --- ölçek: yüzlerce şarkıda süzme hızlı
const many = Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`.padEnd(8, "0"), title: `Şarkı ${i} - Çok Güzel Bir Parça İstanbul` }));
const started = Date.now();
const out = filterSongs(many, { query: "ISTANBUL sarki 19" }, {});
check("2000 şarkıda süzme < 200 ms", Date.now() - started < 200 && out.length > 0, `${Date.now() - started} ms, ${out.length} sonuç`);

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
