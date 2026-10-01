// Mikser ön ayarları ve şarkı başına mikser hafızası. SAF mantık: DOM, ses ve
// localStorage'a doğrudan dokunmaz (depolama dışarıdan verilir), node ile
// test ediliyor: node tests\mixmemory_test.mjs
//
// KAYIT BİÇİMİ: şarkı KİMLİĞİNE bağlı, stems_version/pipeline'a DEĞİL; şarkı
// yenilenince (reprocess, Hi-Fi) ayar kaybolmasın.
//   stem-mikser.mix.<songId> = {
//     v: 1, savedAt, master: 0-150,
//     stems: { "<stem adı>": { fader: 0-150, mute: bool, solo: bool } }
//     loop?: {a, b}   döngü uçları (sn). Şarkı açılınca döngü KAPALI gelir.
//   }
// Biçim "stem adı -> ayar". Kayıtta olmayan kanal varsayılan kalır, şarkıda
// olmayan ad sessizce atlanır: Aşama 10'un alt kanalları (kick, snare, ana/arka
// vokal) eklenince eski kayıtlar bozulmaz.

export const MIX_PREFIX = "stem-mikser.mix.";   // meta ile AYRI önek
export const MIX_LIMIT = 40;                    // meta ile aynı LRU sınırı
export const MIX_VERSION = 1;
export const FADER_MIN = 0;
export const FADER_MAX = 150;
export const DEFAULT_STEM = Object.freeze({ fader: 100, mute: false, solo: false });

export function mixKey(songId) {
  return MIX_PREFIX + songId;
}

// ------------------------------------------------------------- solo + mute
//
// Kural (motorun eski davranışı, artık tek yerde ve testli): MUTE HER ZAMAN
// ÖNCELİKLİ. Aynı kanalda solo ve mute birlikteyse o kanal SUSAR; solo yine de
// sayılır, yani başka kanallar da solo değilse susar (kullanıcı mute'u
// kaldırınca solo geri gelir). İki bayrak da kayda olduğu gibi yazılır.
//
// GRUPLAR (Aşama 10 alt parçaları): bir kanalın `parent` alanı ana kanalın adı
// olabilir (lead/backing -> vocals). Ana kanalın M/S'i TÜM gruba, alt kanalın
// M/S'i yalnız kendine uygulanır:
//   - ana susturulmuşsa bütün alt kanallar susar; alt susturulmuşsa yalnız o
//   - ana solo ise bütün alt kanallar "soloda" sayılır; alt solo ise yalnız o
//   - herhangi bir yerde solo varsa yalnız soloda olanlar duyulur
// channels: Map ad -> {mute, solo, parent?, fader?}
export function audible(channels, name) {
  const channel = channels.get(name);
  if (!channel) return false;
  const parent = channel.parent ? channels.get(channel.parent) : null;
  if (channel.mute || (parent && parent.mute)) return false;
  for (const other of channels.values()) {
    if (other.solo) return !!channel.solo || !!(parent && parent.solo);
  }
  return true;
}

// Kanalın nihai kazancı: duyulmuyorsa 0; duyuluyorsa kendi fader'ı x grup
// fader'ı (ana kanalın fader'ı tüm grubun seviyesi).
export function effectiveGain(channels, name) {
  if (!audible(channels, name)) return 0;
  const channel = channels.get(name);
  const parent = channel.parent ? channels.get(channel.parent) : null;
  const own = Number.isFinite(channel.fader) ? channel.fader : 1;
  const group = parent && Number.isFinite(parent.fader) ? parent.fader : 1;
  return own * group;
}

// ---------------------------------------------------------------- ön ayarlar
// Ön ayar TÜM kanalları temiz başlangıca (fader %100, mute/solo yok) çekip
// yalnız kendi belirttiklerini uygular. Ana ses'e dokunmaz.
export const PRESETS = [
  // Karaoke: ana vokal kanalını susturur; alt parçalar açıksa TÜM grup susar
  // (ana kanalın M/S'i gruba uygulanır).
  { id: "karaoke", label: "Karaoke", mute: ["vocals"] },
  // Yalnız ANA vokal (lead) susar, arka vokal kalır. Alt parçası olmayan
  // şarkıda pasif; alt parçalar hazırsa ama kapalıysa uygulama önce açar.
  { id: "karaoke-backing", label: "Karaoke (arka vokal kalsın)", mute: ["lead"], needsSub: true,
    group: "vocals" },
  { id: "no-drums", label: "Davulu ben çalıyorum", mute: ["drums"] },
  { id: "no-bass", label: "Bası ben çalıyorum", mute: ["bass"] },
  { id: "no-guitar", label: "Gitarı ben çalıyorum", mute: ["guitar"] },
  { id: "no-piano", label: "Piyanoyu ben çalıyorum", mute: ["piano"] },
  { id: "vocals-only", label: "Yalnız vokal", solo: ["vocals"] },
];

export function cleanStates(names) {
  const states = new Map();
  for (const name of names) states.set(name, { ...DEFAULT_STEM });
  return states;
}

// Şarkıda hiçbir hedef kanalı yoksa null (düğme pasif); olmayan adlar atlanır.
export function applyPreset(preset, names) {
  const present = new Set(names);
  const mute = (preset.mute || []).filter((name) => present.has(name));
  const solo = (preset.solo || []).filter((name) => present.has(name));
  if (!mute.length && !solo.length) return null;
  const states = cleanStates(names);
  for (const name of mute) states.get(name).mute = true;
  for (const name of solo) states.get(name).solo = true;
  return states;
}

// ------------------------------------------------------------ kayıt <-> durum

function clampFader(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_STEM.fader;
  return Math.min(Math.max(Math.round(number), FADER_MIN), FADER_MAX);
}

// Döngü uçları: sonlu, a >= 0, b > a; değilse yok sayılır.
export function validLoop(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const a = Number(raw.a);
  const b = Number(raw.b);
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b > a ? { a, b } : undefined;
}

// Ham (JSON'dan gelen) kaydı doğrular. Bozuk/uyumsuz sürüm -> null (yok sayılır,
// SİLİNMEZ: ileride daha yeni bir sürüm aynı kaydı okuyabilir).
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== MIX_VERSION) return null;
  if (!raw.stems || typeof raw.stems !== "object") return null;
  const stems = new Map();
  for (const name of Object.keys(raw.stems)) {
    const entry = raw.stems[name];
    if (!entry || typeof entry !== "object") continue;
    stems.set(name, {
      fader: clampFader(entry.fader),
      mute: entry.mute === true,
      solo: entry.solo === true,
    });
  }
  const record = {
    stems,
    master: clampFader(raw.master),
    savedAt: Number(raw.savedAt) || 0,
  };
  const loop = validLoop(raw.loop);
  if (loop) record.loop = loop;
  return record;
}

// Kaydı şarkının GERÇEK kanal adlarına uygular: kayıtta olmayan ad varsayılan,
// şarkıda olmayan kayıt adı atlanır.
export function planRestore(record, names) {
  const plan = cleanStates(names);
  if (!record) return plan;
  for (const name of names) {
    const saved = record.stems.get(name);
    if (saved) plan.set(name, { ...saved });
  }
  return plan;
}

export function isDefaultMix(states, master = 100) {
  if (master !== 100) return false;
  for (const state of states.values()) {
    if (state.fader !== DEFAULT_STEM.fader || state.mute || state.solo) return false;
  }
  return true;
}

// Motor kanalları (fader = kazanç 0-1.5) -> kayıt durumu (yüzde).
export function snapshot(channels) {
  const states = new Map();
  for (const [name, channel] of channels) {
    states.set(name, {
      fader: clampFader(channel.fader * 100),
      mute: !!channel.mute,
      solo: !!channel.solo,
    });
  }
  return states;
}

// -------------------------------------------------------------------- depo

function readRaw(storage, songId) {
  try {
    const text = storage.getItem(mixKey(songId));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function readMix(storage, songId) {
  return normalizeRecord(readRaw(storage, songId));
}

// Varsayılan duruma dönülmüşse (ve saklanacak başka alan yoksa) kayıt SİLİNİR:
// "geri yüklendi" rozeti boşuna çıkmaz, depo şişmez. Bilinmeyen/yeni alanlar
// (loop) eski kayıttan korunur.
export function writeMix(storage, songId, states, master, now = Date.now(),
                         options = {}) {
  try {
    const old = readRaw(storage, songId);
    const loop = old && old.v === MIX_VERSION ? validLoop(old.loop) : undefined;
    // O an şarkıda OLMAYAN kanalların kayıtlı ayarı (alt parçalar kapalıyken
    // lead/backing) kaybolmasın. Sıfırlamada (`replaceAbsent`) onlar da gider.
    if (!options.replaceAbsent && old && old.v === MIX_VERSION) {
      const previous = normalizeRecord(old);
      if (previous) {
        states = new Map(states);
        for (const [name, state] of previous.stems) {
          if (!states.has(name)) states.set(name, state);
        }
      }
    }
    if (isDefaultMix(states, master) && loop === undefined) {
      storage.removeItem(mixKey(songId));
      return;
    }
    const stems = {};
    for (const [name, state] of states) stems[name] = state;
    const record = { v: MIX_VERSION, savedAt: now, master, stems };
    if (loop !== undefined) record.loop = loop;
    storage.setItem(mixKey(songId), JSON.stringify(record));
    pruneMix(storage);
  } catch {
    // Kota dolduysa önemli değil: ayar hatırlanmaz, uygulama bozulmaz.
  }
}

// Yalnız döngü alanını yazar/siler (loop null = sil). Mikser ayarına dokunmaz.
// Döngü yok ve mikser de varsayılansa kaydın TAMAMI silinir. Uyumsuz sürümlü
// kayda dokunulmaz.
export function writeLoop(storage, songId, loop, now = Date.now()) {
  try {
    const old = readRaw(storage, songId);
    if (old && old.v !== MIX_VERSION) return;
    const record = old && old.stems && typeof old.stems === "object"
      ? { ...old } : { v: MIX_VERSION, master: 100, stems: {} };
    record.v = MIX_VERSION;
    record.savedAt = now;
    const clean = validLoop(loop);
    if (clean) record.loop = clean;
    else delete record.loop;
    const norm = normalizeRecord(record);
    if (!clean && norm && isDefaultMix(norm.stems, norm.master)) {
      storage.removeItem(mixKey(songId));
      return;
    }
    storage.setItem(mixKey(songId), JSON.stringify(record));
    pruneMix(storage);
  } catch {
    /* kota: önemli değil */
  }
}

export function removeMix(storage, songIds) {
  for (const id of songIds || []) {
    try {
      storage.removeItem(mixKey(id));
    } catch {
      /* yok say */
    }
  }
}

export function pruneMix(storage) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(MIX_PREFIX)) keys.push(key);
    }
    if (keys.length <= MIX_LIMIT) return;
    const aged = keys.map((key) => {
      let savedAt = 0;
      try {
        savedAt = (JSON.parse(storage.getItem(key)) || {}).savedAt || 0;
      } catch {
        savedAt = 0;
      }
      return { key, savedAt };
    }).sort((a, b) => a.savedAt - b.savedAt);
    for (const item of aged.slice(0, aged.length - MIX_LIMIT)) {
      storage.removeItem(item.key);
    }
  } catch {
    /* yok say */
  }
}
