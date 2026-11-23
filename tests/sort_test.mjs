// Kitaplık sıralaması ve çalma sayacı (js/sortplays.js).   node tests\sort_test.mjs

import { normalizeSort, readSort, writeSort, readPlays, bumpPlays, sortSongs, SORT_KEY, PLAYS_KEY } from "../frontend/js/sortplays.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const store = (seed = {}) => { const d = { ...seed }; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; };

const songs = [
  { id: "a1", title: "Zeytin", duration: 200 },
  { id: "b2", title: "Çilek", duration: 100 },
  { id: "c3", title: "Armut", duration: 300 },
  { id: "d4", title: "armut", duration: null },
];
const ids = (list) => list.map((s) => s.id).join();
check("new: olduğu gibi (kopya, girdi değişmez)", ids(sortSongs(songs, "new")) === "a1,b2,c3,d4" && sortSongs(songs, "new") !== songs);
check("name: Türkçe sıra (Ç, Z'den önce; büyük-küçük aynı, eşitte özgün sıra)", ids(sortSongs(songs, "name")) === "c3,d4,b2,a1", ids(sortSongs(songs, "name")));
check("long: uzundan kısaya, süresiz sona", ids(sortSongs(songs, "long")) === "c3,a1,b2,d4");
check("short: kısadan uzuna, süresiz sona", ids(sortSongs(songs, "short")) === "b2,a1,c3,d4");
check("played: sayıya göre, eşitlikte özgün sıra", ids(sortSongs(songs, "played", { c3: 5, b2: 5, a1: 1 })) === "b2,c3,a1,d4");
check("bilinmeyen kip -> new", normalizeSort("x") === "new" && ids(sortSongs(songs, "x")) === "a1,b2,c3,d4");
check("boş liste", sortSongs([], "name").length === 0);

const s = store();
check("sıralama tercihi: varsayılan new, yaz/oku, bozuk değer new", readSort(s) === "new" && writeSort(s, "name") && readSort(s) === "name" && readSort(store({ [SORT_KEY]: "??" })) === "new");
check("sayaç: artar ve kalıcı", bumpPlays(s, "a1") === 1 && bumpPlays(s, "a1") === 2 && readPlays(s).a1 === 2);
check("sayaç: bozuk/negatif/geçersiz kimlik atılır", JSON.stringify(readPlays(store({ [PLAYS_KEY]: JSON.stringify({ ok: 3, "../x": 2, neg: -1, str: "a" }) }))) === JSON.stringify({ ok: 3 }) && Object.keys(readPlays(store({ [PLAYS_KEY]: "{x" }))).length === 0);
check("sayaç: yazma hatası çökmez", bumpPlays({ getItem: () => null, setItem() { throw new Error("kota"); } }, "x") === 1);
const big = store();
for (let i = 0; i < 410; i += 1) bumpPlays(big, `s${i}`);
bumpPlays(big, "s0");
check("sayaç: 400 sınırı, en çok çalınanlar kalır", Object.keys(readPlays(big)).length === 400 && readPlays(big).s0 === 2);

if (failed) { console.error(`\n${failed} test başarısız`); process.exit(1); }
console.log("\ntümü geçti");
