// Rusça okunuş (Kiril -> Türkçe harfler). SENTETİK, gündelik ifadeler; gerçek söz yok.
//
//     node tests\rureading_test.mjs

import { ruReading, hasCyrillic } from "../frontend/js/rureading.js";
import { subsList, actionView, buildMap, READING_LANGS, LOCAL_READING_LANGS, isTranslatable } from "../frontend/js/translation.js";
import { LANGS, LANG_CHOICES } from "../frontend/js/lyrics.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const eq = (name, got, want) => check(name, got === want, got === want ? "" : `"${got}" != "${want}"`);

eq("temel harfler", ruReading("привет"), "privet");
eq("büyük harf korunur, i -> İ", ruReading("Идём домой"), "İdyom domoy");
eq("е sözcük başında ye", ruReading("Есть ещё"), "Yest yeşço");
eq("я ю ё", ruReading("я люблю тебя"), "ya lyublyu tebya");
eq("ш ч ж щ", ruReading("шапка чай жук щи"), "şapka çay juk şçi");
eq("ж/ш/ц sonrası и -> ı", ruReading("жизнь машина цирк"), "jızn maşına tsırk");
eq("ы -> ı, ь ъ okunmaz", ruReading("мы день объём"), "mı den obyom");
eq("ш/ч sonrası ё -> o", ruReading("шёл чёрный"), "şol çornıy");
eq("что -> şto", ruReading("Что это?"), "Şto eto?");
eq("-ого/-его -> -ovo/-evo", ruReading("ничего моего"), "niçevo moyevo");
eq("много g ile kalır", ruReading("много"), "mnogo");
eq("-тся/-ться -> -tsa", ruReading("кажется улыбаться"), "kajetsa ulıbatsa");
eq("сегодня", ruReading("сегодня"), "sevodnya");
eq("noktalama ve Latin aynen", ruReading("Oh, да! 2 раза"), "Oh, da! 2 raza");
eq("tire ile bağlı sözcük", ruReading("кто-то"), "kto-to");
eq("TAMAMI BÜYÜK", ruReading("СТОП"), "STOP");
eq("Kiril yoksa boş", ruReading("hello world"), "");
check("hasCyrillic", hasCyrillic("да") && !hasCyrillic("da") && !hasCyrillic(null));
const sample = "в ночи огни";
check("çıktıda yalnız Türk alfabesi", /^[a-zçğıöşü ]+$/.test(ruReading(sample)), ruReading(sample));

// --- çeviri arayüzüne bağlantı
check("ru dil listelerinde", LANGS.includes("ru") && LANG_CHOICES.some(([v]) => v === "ru") && isTranslatable("ru")
  && READING_LANGS.includes("ru") && LOCAL_READING_LANGS.join() === "ru");
const lines = [{ text: "Привет мир" }, { text: "да да" }, { text: "Oh" }];
const both = { tr: true, ro: true };
const noTr = subsList(lines, null, both, "ru");
check("ru: çeviri yokken de okunuş", noTr[0].ro === "Privet mir" && noTr[0].tr === "" && noTr[2].ro === "", JSON.stringify(noTr));
const map = buildMap(lines, [{ tr: "Merhaba dünya" }, { tr: "evet evet" }, null]);
const withTr = subsList(lines, map, both, "ru");
check("ru: okunuş + çeviri", withTr[0].ro === "Privet mir" && withTr[0].tr === "Merhaba dünya" && withTr[1].ro === "da da");
const roOff = subsList(lines, map, { tr: true, ro: false }, "ru");
check("ru: okunuş kapalıysa boş", roOff[0].ro === "" && roOff[0].tr === "Merhaba dünya");
const viewNo = actionView({ lang: "ru", hasDoc: true, record: null, map: null, lines });
check("ru: çevirisizken Çevir düğmesi ve okunuş anahtarı", viewNo.kind === "translate" && viewNo.showRo === true && viewNo.showTr === false);
const viewYes = actionView({ lang: "ru", hasDoc: true, record: null, map, lines });
check("ru: 'Okunuşu ekle' yok (okunuş telefonda)", viewYes.showRo && viewYes.showTr && !viewYes.addReading);
const viewTr = actionView({ lang: "tr", hasDoc: true, record: null, map: null, lines });
check("tr: hâlâ gizli", viewTr.kind === "hidden" && !viewTr.showRo);
const viewJa = actionView({ lang: "ja", hasDoc: true, record: null, map: null, lines });
check("ja: çevirisizken okunuş anahtarı yok (eskisi gibi)", viewJa.showRo === false);

console.log(failed ? `\n${failed} test BAŞARISIZ` : "\nhepsi geçti");
process.exit(failed ? 1 : 0);
