// Rusça sözlerin Türkçe harflerle okunuşu: SAF, DOM/ağ/ses YOK. node tests\rureading_test.mjs
//
// Sunucuya gitmez, ücretsizdir ve çevrimdışı çalışır: kural tabanlı harf çevirisi (Kiril -> Türk alfabesi).
// Bilinçli sınır: Rusçada vurgu yazıda görünmez, bu yüzden vurgusuz "o"nun "a" gibi okunması (хорошо ->
// "haraşo") yapılmaz; "horoşo" yazılır. Sık geçen söyleyiş istisnaları (что -> şto, -ого/-его -> -ovo/-evo,
// -тся/-ться -> -tsa) ve ж/ш/ц sonrası и -> ı kuralı uygulanır.

const BASE = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ç", ш: "ş", щ: "şç",
  ъ: "", ы: "ı", ь: "", э: "e", ю: "yu", я: "ya",
};
const VOWELS = new Set("аеёиоуыэюя");
const HUSH = new Set("жшчщ");           // bunlardan sonra ё -> o
const HARD = new Set("жшц");            // bunlardan sonra и -> ı
const WORDS = new Map([
  ["что", "şto"], ["чтобы", "ştobı"], ["ничто", "nişto"], ["нечто", "neşto"],
  ["конечно", "koneşno"], ["скучно", "skuşno"], ["сегодня", "sevodnya"], ["сегодняшний", "sevodnyaşniy"],
]);
// -ого/-его ama "g" okunan sözcükler
const KEEP_G = new Set(["много", "немного", "строго", "нестрого", "дорого", "недорого", "убого", "полого", "отлого"]);
const WORD_RE = /[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*/g;

function letters(word) {
  let out = "";
  for (let i = 0; i < word.length; i += 1) {
    const ch = word[i];
    const prev = i > 0 ? word[i - 1] : "";
    const afterVowelOrStart = !prev || prev === "-" || VOWELS.has(prev) || prev === "ь" || prev === "ъ";
    if (ch === "е") out += afterVowelOrStart ? "ye" : "e";
    else if (ch === "ё") out += HUSH.has(prev) ? "o" : "yo";
    else if (ch === "и" && HARD.has(prev)) out += "ı";
    else out += BASE[ch] !== undefined ? BASE[ch] : ch;
  }
  return out;
}

function lowerWord(word) {
  const known = WORDS.get(word);
  if (known) return known;
  let stem = word;
  let tail = "";
  if (/ться$/.test(stem)) { stem = stem.slice(0, -4); tail = "tsa"; }
  else if (/тся$/.test(stem)) { stem = stem.slice(0, -3); tail = "tsa"; }
  else if (/[ое]го$/.test(stem) && stem.length > 3 && !KEEP_G.has(stem)) {
    return letters(stem.slice(0, -2)) + "vo";
  }
  return letters(stem) + tail;
}

function upperFirst(text) {
  if (!text) return text;
  const first = text[0] === "i" ? "İ" : text[0] === "ı" ? "I" : text[0].toUpperCase();
  return first + text.slice(1);
}

function word(original) {
  const low = original.toLowerCase();
  const out = lowerWord(low);
  if (original.length > 1 && original === original.toUpperCase()) {
    return out.replace(/i/g, "İ").replace(/ı/g, "I").toUpperCase();     // БОЛЬШИЕ БУКВЫ
  }
  return original[0] !== low[0] ? upperFirst(out) : out;
}

/** Satırda Kiril harf var mı? */
export function hasCyrillic(text) {
  return /[А-Яа-яЁё]/.test(String(text || ""));
}

/** Rusça satırın Türkçe harfli okunuşu. Kiril olmayan kısımlar (Latin sözcük, noktalama, rakam) aynen kalır. Kiril yoksa "". */
export function ruReading(text) {
  const source = String(text || "");
  if (!hasCyrillic(source)) return "";
  return source.replace(WORD_RE, (match) => match.split("-").map(word).join("-"));
}
