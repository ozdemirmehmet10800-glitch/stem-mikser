// Çalma listesi mantığı (frontend/js/playlist.js): çalınabilirlik, sıradaki/önceki, atlama, liste sonu, devam.
//
//     node tests\playlist_test.mjs

import {
  itemState, isPlayable, nextPlayable, previousPlayable, indexOfItem, startIndex, previousAction, anyPlayable, skipNote,
  totalDuration, positionLabel, alreadyInList, PREVIOUS_RESTART_SECONDS,
} from "../frontend/js/playlist.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const SONGS = {
  zeus: { id: "zeus", title: "Zeus Kabadayı & Rota - Çok Mutlu Bir Şarkı", state: "done", duration: 158 },
  hazbin: { id: "hazbin", title: "HAZBİN HOTEL - Bağımlı (Addict)", state: "done", duration: 110 },
  usseewa: { id: "usseewa", title: "Ado - うっせぇわ", state: "done", duration: 205 },
  nem: { id: "nem", title: "NEM", state: "processing", duration: 180 },
};
const titleOf = (item) => (SONGS[item.song] ? SONGS[item.song].title : "(şarkı)");
const make = (...songs) => songs.map((song, i) => ({ iid: `i${i}`, song }));
const online = { songById: (id) => SONGS[id] || null, offline: false, offlineReady: () => true };
const offlineWith = (...ready) => ({ songById: online.songById, offline: true, offlineReady: (song) => ready.includes(song.id) });

// --- çalınabilirlik
check("ok: kitaplıkta, hazır, çevrimiçi", itemState({ iid: "a", song: "zeus" }, online) === "ok");
check("missing: kayıp damgalı ya da kitaplıkta yok", itemState({ iid: "a", song: "zeus", miss: 5 }, online) === "missing" && itemState({ iid: "a", song: "yok" }, online) === "missing" && itemState(null, online) === "missing");
check("notready: işleniyor", itemState({ iid: "a", song: "nem" }, online) === "notready");
check("offline: çevrimdışı ve cihazda kopya yok; kopya varsa ok", itemState({ iid: "a", song: "zeus" }, offlineWith()) === "offline" && itemState({ iid: "a", song: "zeus" }, offlineWith("zeus")) === "ok");
check("isPlayable yalnız ok", isPlayable({ iid: "a", song: "zeus" }, online) && !isPlayable({ iid: "a", song: "nem" }, online));

// --- sıradaki
let items = make("zeus", "hazbin", "usseewa");
check("nextPlayable: bir sonraki; atlanan yok", JSON.stringify(nextPlayable(items, 0, online)) === JSON.stringify({ index: 1, skipped: [] }));
check("nextPlayable: son öğeden sonra -1 (liste biter, döngü yok)", nextPlayable(items, 2, online).index === -1 && nextPlayable(items, 2, online).skipped.length === 0);
items = make("zeus", "nem", "yok", "usseewa");
let found = nextPlayable(items, 0, online);
check("nextPlayable: çalınamayanlar (işleniyor, kitaplıkta yok) ATLANIR ve bildirilir", found.index === 3 && found.skipped.map((i) => i.song).join() === "nem,yok");
check("nextPlayable: kalan hepsi çalınamıyorsa -1 ve hepsi atlanan", (() => {
  const f = nextPlayable(make("zeus", "nem", "yok"), 0, online);
  return f.index === -1 && f.skipped.length === 2;
})());
check("çevrimdışı: kopyası olmayan atlanır, olan çalar", (() => {
  const f = nextPlayable(make("zeus", "hazbin", "usseewa"), 0, offlineWith("zeus", "usseewa"));
  return f.index === 2 && f.skipped.length === 1 && f.skipped[0].song === "hazbin";
})());
check("aynı şarkı iki kez: indeksle ilerler (tekrar atlanmaz)", (() => {
  const dup = make("zeus", "hazbin", "zeus");
  return nextPlayable(dup, 0, online).index === 1 && nextPlayable(dup, 1, online).index === 2;
})());
check("boş liste: sıradaki yok, çalınabilir yok", nextPlayable([], -1, online).index === -1 && !anyPlayable([], online));

// --- önceki
items = make("zeus", "hazbin", "nem", "usseewa");
check("previousPlayable: çalınamayanı atlayarak geriye", previousPlayable(items, 3, online).index === 1 && previousPlayable(items, 3, online).skipped.length === 1);
check("previousPlayable: başta -1", previousPlayable(items, 0, online).index === -1);
check(`previousAction: konum > ${PREVIOUS_RESTART_SECONDS} sn ise AYNI şarkıyı başa sar`, previousAction(items, 3, 20, online).action === "restart" && previousAction(items, 3, PREVIOUS_RESTART_SECONDS + 0.1, online).action === "restart");
check(`previousAction: konum <= ${PREVIOUS_RESTART_SECONDS} sn ise bir önceki şarkı`, (() => {
  const a = previousAction(items, 3, 1.5, online);
  return a.action === "previous" && a.index === 1 && a.skipped.length === 1 && previousAction(items, 3, PREVIOUS_RESTART_SECONDS, online).action === "previous";
})());
check("previousAction: ilk şarkıda konum küçükse de başa sar (öncesi yok)", previousAction(items, 0, 1, online).action === "restart");

// --- başlangıç / devam
items = make("zeus", "hazbin", "usseewa");
check("startIndex: cur yok -> ilk çalınabilir", startIndex(items, null, online).index === 0);
check("startIndex: cur var ve çalınabilir -> o öğe (Devam)", startIndex(items, "i1", online).index === 1);
check("startIndex: cur çalınamıyorsa ondan SONRAKİ ilk çalınabilir (atlananlarla)", (() => {
  const list = make("zeus", "nem", "usseewa");
  const f = startIndex(list, "i1", online);
  return f.index === 2 && f.skipped.length === 1;
})());
check("startIndex: cur listede yoksa baştan; ilk öğe çalınamıyorsa ikinciden", (() => {
  const list = make("nem", "hazbin");
  const f = startIndex(list, "iyok", online);
  return f.index === 1 && f.skipped.length === 1;
})());
check("startIndex: hiç çalınabilir yoksa -1", startIndex(make("nem", "yok"), null, online).index === -1 && !anyPlayable(make("nem", "yok"), online));
check("indexOfItem: kimlikle", indexOfItem(items, "i2") === 2 && indexOfItem(items, "x") === -1);

// --- metinler / özetler
check("skipNote: tek atlanan (neden: telefonda kayıtlı değil / hazır değil / bulunamadı)",
  skipNote([{ iid: "a", song: "hazbin" }], titleOf, offlineWith()).includes("atlandı: telefonda kayıtlı değil")
  && skipNote([{ iid: "a", song: "nem" }], titleOf, online).includes("henüz hazır değil")
  && skipNote([{ iid: "a", song: "yok" }], titleOf, online).includes("bulunamadı"));
check("skipNote: birden çok atlanan sayıyı söyler; hiç yoksa boş", skipNote([{ iid: "a", song: "nem" }, { iid: "b", song: "yok" }], titleOf, online).startsWith("2 şarkı atlandı")
  && skipNote([], titleOf, online) === "");
check("totalDuration: süre bilinmeyenler 0 sayılır", totalDuration(make("zeus", "hazbin", "yok"), (item) => (SONGS[item.song] || {}).duration) === 268);
check("positionLabel: 'Cuma provası · 2/4'", positionLabel("Cuma provası", 1, 4) === "Cuma provası · 2/4");
check("alreadyInList: listede zaten olanlar (tekil), sırayla", JSON.stringify(alreadyInList(make("zeus", "zeus", "hazbin"), ["zeus", "usseewa", "hazbin", "zeus"])) === '["zeus","hazbin"]'
  && alreadyInList([], ["zeus"]).length === 0);

// --- uçtan uca: 4 şarkılık liste baştan sona (atlama dahil)
(() => {
  const list = make("zeus", "hazbin", "nem", "usseewa");
  const played = [];
  let at = startIndex(list, null, online).index;
  while (at >= 0) {
    played.push(list[at].song);
    at = nextPlayable(list, at, online).index;
  }
  check("Cuma provası: çalma sırası zeus, hazbin, (nem atlanır), usseewa; sonra durur", played.join() === "zeus,hazbin,usseewa");
})();

console.log(failed ? `\n${failed} test başarısız` : "\ntümü geçti");
process.exit(failed ? 1 : 0);
