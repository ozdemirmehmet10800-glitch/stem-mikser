// Ton ve akor adları: transpoze + bemol/diyez seçimi.
//
// Bu, arka uçtaki `_key_uses_flats` / `_chord_label` mantığının ön yüz
// karşılığı. Ton değiştirince akor şeridi yeniden etiketlenmek zorunda ve
// yazım YENİ tona göre seçilmeli: Fm'de "Ab" yazan akor +2 yarım sesle
// Gm'ye çıkınca "Bb" olur, "A#" değil.
//
// Arka uç etiketleri şu biçimlerde: "C", "Cm", "Ab/C", "N" (akor yok).

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export const NO_CHORD = "N";

const PITCH_CLASS = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
  // Arka uç üretmiyor ama elle girilmiş veriye karşı toleranslı olalım.
  "B#": 0, Cb: 11, "E#": 5, Fb: 4,
};

// Beşliler çemberi konumu (majör tonikler). Negatif = bemollü ton.
// Arka uçtaki _CIRCLE_OF_FIFTHS ile birebir aynı.
const CIRCLE_OF_FIFTHS = {
  0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6,
  1: -5, 8: -4, 3: -3, 10: -2, 5: -1,
};

/** Ton bemollü mü? Minörde ilgili majöre bakılır (Fm -> Ab -> bemol). */
export function keyUsesFlats(tonic, isMinor) {
  const relativeMajor = isMinor ? (tonic + 3) % 12 : tonic;
  return CIRCLE_OF_FIFTHS[((relativeMajor % 12) + 12) % 12] < 0;
}

/** "Fm" -> {tonic: 5, minor: true}. Tanınmayan girdide null. */
export function parseKey(name) {
  if (typeof name !== "string") return null;
  const match = /^([A-G][b#]?)(m)?$/.exec(name.trim());
  if (!match) return null;
  const tonic = PITCH_CLASS[match[1]];
  if (tonic === undefined) return null;
  return { tonic, minor: Boolean(match[2]) };
}

export function keyName(tonic, isMinor) {
  const pitch = ((tonic % 12) + 12) % 12;
  const names = keyUsesFlats(pitch, isMinor) ? FLAT_NAMES : SHARP_NAMES;
  return `${names[pitch]}${isMinor ? "m" : ""}`;
}

/** "Fm" + 2 -> "Gm". Ton bilinmiyorsa null. */
export function transposeKey(name, semitones) {
  const key = parseKey(name);
  if (!key) return null;
  return keyName(key.tonic + Math.round(semitones), key.minor);
}

/**
 * Transpoze sonrası hangi nota adları kullanılacak?
 * Ton biliniyorsa YENİ tonun yazımı, bilinmiyorsa diyez (arka ucun varsayılanı).
 */
export function namesForKey(name, semitones = 0) {
  const key = parseKey(name);
  if (!key) return SHARP_NAMES;
  const tonic = (((key.tonic + Math.round(semitones)) % 12) + 12) % 12;
  return keyUsesFlats(tonic, key.minor) ? FLAT_NAMES : SHARP_NAMES;
}

/**
 * Tek bir akor etiketini transpoze eder. Slash akorda kök ve bas ayrı ayrı
 * kaydırılır. "N" olduğu gibi kalır; tanınmayan etiket de dokunulmadan döner.
 */
export function transposeLabel(label, semitones, names = SHARP_NAMES) {
  if (typeof label !== "string") return label;
  const text = label.trim();
  if (!text || text === NO_CHORD) return text;

  const match = /^([A-G][b#]?)(m?)(?:\/([A-G][b#]?))?$/.exec(text);
  if (!match) return text;

  const shift = Math.round(semitones);
  const move = (noteName) => {
    const pitch = PITCH_CLASS[noteName];
    if (pitch === undefined) return null;
    return names[(((pitch + shift) % 12) + 12) % 12];
  };

  const root = move(match[1]);
  if (root === null) return text;
  let out = `${root}${match[2]}`;
  if (match[3]) {
    const bass = move(match[3]);
    // Bas notası tanınmazsa slash'ı DÜŞÜRÜYORUZ: yanlış bir bas yazmaktan
    // temiz bir triad etiketi iyidir.
    if (bass !== null) out += `/${bass}`;
  }
  return out;
}

/**
 * chords.json'ın akor listesini transpoze eder. semitones 0 ise AYNI dizi
 * döner (gereksiz kopya yok); şerit yeniden kurulmadan kısa devre yapılabilir.
 */
export function transposeChords(chords, semitones, key) {
  const shift = Math.round(semitones);
  if (!Array.isArray(chords) || shift === 0) return chords;
  const names = namesForKey(key, shift);
  return chords.map((chord) => ({
    ...chord,
    label: transposeLabel(chord.label, shift, names),
  }));
}

export { SHARP_NAMES, FLAT_NAMES };
