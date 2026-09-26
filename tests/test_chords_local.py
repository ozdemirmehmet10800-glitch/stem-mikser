"""Akor analizi mantığının yerel testi - Modal'a hiç bağlanmaz.

Sentetik üretilmiş bir akor dizisi kullanır; amaç ALGORİTMA MANTIĞINI
doğrulamak (şablonlar, kök bonusu, viterbi, downbeat fazı, birleştirme,
JSON şekli). Parametre ayarı gerçek kayıtla analyze_only üzerinden yapılır.

Çalıştırma:
    .\\.venv\\Scripts\\python.exe tests\\test_chords_local.py

Not: yerel librosa Modal'daki ile aynı sürüm (0.11.0) ama numpy sürümü farklı
(yerel 2.x, Modal'da 1.26.4). API aynı olduğu için mantık testi geçerli.
"""

import importlib.util
import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_app():
    """backend/app.py'yi modül olarak yükler (paket kurulumu gerekmez)."""
    spec = importlib.util.spec_from_file_location("app_under_test", ROOT / "backend" / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --------------------------------------------------------------------------
# Sentetik ses üretimi
# --------------------------------------------------------------------------

MIDI = {
    "C": 60, "C#": 61, "D": 62, "D#": 63, "E": 64, "F": 65,
    "F#": 66, "G": 67, "G#": 68, "A": 69, "A#": 70, "B": 71,
    # bemol karsiliklar (analyze_core bemollu tonlarda bu adlari donduruyor)
    "Db": 61, "Eb": 63, "Gb": 66, "Ab": 68, "Bb": 70,
}


def midi_to_hz(note: int) -> float:
    return 440.0 * 2.0 ** ((note - 69) / 12.0)


def chord_notes(label: str):
    """'Am' -> kök + üçlü + beşli MIDI notaları."""
    minor = label.endswith("m")
    root_name = label[:-1] if minor else label
    root = MIDI[root_name]
    third = root + (3 if minor else 4)
    return root, [root, third, root + 7]


def synth(progression, *, sr=22050, bpm=120.0, beats_per_chord=4, bass_degree=0):
    """Akor dizisinden (kalite, bas) sinyali üretir.

    Kalite sinyali BASI İÇERMEZ - analyze_core artık piano+guitar+other
    toplamını alıyor, bas ayrı. Her beat'te yumuşak bir atak var;
    librosa beat_track'in beat bulabilmesi için.

    bass_degree: bas hangi akor tonunu çalsın. 0=kök, 1=üçlü, 2=beşli.
    """
    beat_seconds = 60.0 / bpm
    samples_per_beat = int(round(beat_seconds * sr))
    harmonic = []
    bass = []

    for label in progression:
        root, notes = chord_notes(label)
        bass_note = notes[bass_degree]
        for _beat in range(beats_per_chord):
            t = np.arange(samples_per_beat) / sr
            # beat başında sert, sonunda zayıflayan zarf -> onset
            envelope = np.exp(-4.0 * t / beat_seconds)

            chunk = np.zeros_like(t)
            for note in notes:
                freq = midi_to_hz(note)
                chunk += np.sin(2 * np.pi * freq * t)
                chunk += 0.35 * np.sin(2 * np.pi * 2 * freq * t)  # oktav harmonik
            harmonic.append((chunk / len(notes)) * envelope)

            # bas: seçilen akor tonunun iki oktav altı
            bass_freq = midi_to_hz(bass_note - 24)
            bass.append(np.sin(2 * np.pi * bass_freq * t) * envelope)

    quality = np.concatenate(harmonic).astype(np.float32)
    bass = np.concatenate(bass).astype(np.float32)
    return quality, bass


# --------------------------------------------------------------------------
# Testler
# --------------------------------------------------------------------------

PASSED = []
FAILED = []


def check(name: str, condition: bool, detail: str = ""):
    (PASSED if condition else FAILED).append(name)
    mark = "OK  " if condition else "HATA"
    print(f"[{mark}] {name}" + (f"  -> {detail}" if detail else ""))


def test_templates(app):
    states, matrix = app._chord_states()
    check("25 durum var (12 major + 12 minor + N)", len(states) == 25, f"{len(states)}")
    check("N son sirada", states[-1] is None)
    check("triad satirlari L2-normalize",
          np.allclose(np.linalg.norm(matrix[:24], axis=1), 1.0))
    # N'in spektral sablonu yok: duz sablon chroma gurultu tabanina fit edip
    # her beat'i N yapiyordu. Skoru _chord_path'te sabit (N_SCORE).
    check("N satiri sifir (sablonu yok)", np.all(matrix[24] == 0.0))

    c_index = states.index((0, False))
    nonzero = sorted(np.nonzero(matrix[c_index])[0].tolist())
    check("C sablonu = {0,4,7}", nonzero == [0, 4, 7], str(nonzero))

    am_index = states.index((9, True))
    nonzero = sorted(np.nonzero(matrix[am_index])[0].tolist())
    check("Am sablonu = {0,4,9}", nonzero == [0, 4, 9], str(nonzero))

    similarity = float(matrix[c_index] @ matrix[am_index])
    check("C ile Am yuksek benzerlik (ayirmak zor)", similarity > 0.6,
          f"kosinus={similarity:.3f}")

    check("akor tonlari: C = C,E,G", app._chord_tones(0, False) == (0, 4, 7))
    check("akor tonlari: Am = A,C,E", sorted(app._chord_tones(9, True)) == [0, 4, 9])


def test_torchaudio_io_rule(app):
    """PLAN.md kurali: kodumuz ses I/O icin torchaudio kullanmaz.

    Paketin kurulu olmasi sorun degil (beat_this'in mel donusumu kullaniyor),
    yasak olan load/save/info ve dogrudan import.
    """
    ta = "torch" + "audio"

    check("kendi kaynagimiz temiz", app._SELF_CHECK_LINES is not None
          and app._check_no_torchaudio_io(
              (ROOT / "backend" / "app.py").read_text(encoding="utf-8")) == [],
          str(app._SELF_CHECK_LINES))

    bad = chr(10).join(["import " + ta, "x = " + ta + ".load(p)",
                        ta + ".save(p, x)", "y = " + ta + ".info(p)"])
    hits = app._check_no_torchaudio_io(bad)
    check("import yakalandi", any("import" in h for h in hits), str(hits))
    check("load yakalandi", any(".load" in h for h in hits), str(hits))
    check("save yakalandi", any(".save" in h for h in hits), str(hits))
    check("info yakalandi", any(".info" in h for h in hits), str(hits))

    # Mesru kullanim: saf torch donusumu, I/O degil -> yakalanmamali
    check("transforms.MelSpectrogram yakalanmiyor",
          app._check_no_torchaudio_io(ta + ".transforms.MelSpectrogram(n_mels=128)") == [])
    # Yorumdaki bahis de yakalanmamali
    check("yorumdaki bahis yakalanmiyor",
          app._check_no_torchaudio_io("# " + ta + ".load kullanma") == [])


def test_slash_chords(app):
    """Bas kok degil ama akor tonuysa slash akor yazilir (Ab/C)."""
    flat = app.FLAT_NAMES
    ab_major = (8, False)  # Ab = Ab, C, Eb

    check("bas kok -> sade etiket",
          app._chord_label(ab_major, flat, 8) == "Ab",
          app._chord_label(ab_major, flat, 8))
    check("bas ucluyse slash (Ab/C)",
          app._chord_label(ab_major, flat, 0) == "Ab/C",
          app._chord_label(ab_major, flat, 0))
    check("bas besliyse slash (Ab/Eb)",
          app._chord_label(ab_major, flat, 3) == "Ab/Eb",
          app._chord_label(ab_major, flat, 3))
    # Bas akor tonu degil -> slash yazmiyoruz, gurultu olmasin
    check("bas akor tonu degil -> sade etiket",
          app._chord_label(ab_major, flat, 2) == "Ab",
          app._chord_label(ab_major, flat, 2))
    check("bas bilinmiyor -> sade etiket",
          app._chord_label(ab_major, flat, None) == "Ab")
    check("N etiketi", app._chord_label(None, flat, 0) == "N")
    # Eski hata: Ab/C, bas yuzunden C veya Cm okunuyordu
    check("Ab/C artik C/Cm okunmuyor",
          app._chord_label(ab_major, flat, 0) not in ("C", "Cm"))


def test_diatonic_and_key(app):
    fm = app._diatonic_states(5, True)  # F minor
    expected = {"Fm", "Ab", "Bbm", "Cm", "Db", "Eb", "C"}
    got = {app._chord_label(state, app.FLAT_NAMES) for state in fm}
    check("Fm diyatonik kumesi", got == expected, str(sorted(got)))
    # Armonik minorun V majoru dahil olmali
    check("Fm kumesinde C major var (armonik minor V)", (0, False) in fm)
    check("Fm kumesinde Cm de var (dogal minor v)", (0, True) in fm)

    c_major = app._diatonic_states(0, False)
    got = {app._chord_label(state, app.NOTE_NAMES) for state in c_major}
    check("C major diyatonik kumesi",
          got == {"C", "Dm", "Em", "F", "G", "Am"}, str(sorted(got)))

    # Ton yazimi: bemollu tonlar bemol kullanir
    check("Fm bemollu", app._key_uses_flats(5, True) is True)
    check("Ab major bemollu", app._key_uses_flats(8, False) is True)
    check("C major diyezli (varsayilan)", app._key_uses_flats(0, False) is False)
    check("E major diyezli", app._key_uses_flats(4, False) is False)
    check("Em diyezli", app._key_uses_flats(4, True) is False)
    check("ton adi Fm", app._key_name(5, True) == "Fm", app._key_name(5, True))

    # Ton tespiti: Fm agirlikli bir dizi Fm vermeli (ilgili major Ab degil)
    beats = ([(5, True)] * 24) + [(8, False), (1, False), (3, False), (0, True)]
    durations = [0.5] * len(beats)
    tonic, is_minor = app._detect_key(beats, durations)
    check("ton tespiti Fm", (tonic, is_minor) == (5, True),
          app._key_name(tonic, is_minor))

    # Ab agirlikli olsa Ab major cikmali - tonik terimi ayirt ediyor
    beats = ([(8, False)] * 24) + [(5, True), (1, False), (3, False)]
    tonic, is_minor = app._detect_key(beats, [0.5] * len(beats))
    check("ton tespiti Ab major", (tonic, is_minor) == (8, False),
          app._key_name(tonic, is_minor))


def test_key_bonus_prefers_diatonic(app):
    """Uclu zayifken tonun diyatonik akoru kazanmali: F degil Fm."""
    # F koku guclu, besli guclu, ucluler ikisi de zayif ve birbirine yakin:
    # A (major uclu) 0.30, Ab (minor uclu) 0.32 -> karar cok yakin
    chroma = np.zeros((12, 6))
    chroma[5] = 1.0    # F  kok
    chroma[0] = 0.9    # C  besli
    chroma[9] = 0.30   # A  major uclu
    chroma[8] = 0.32   # Ab minor uclu
    bass_chroma = np.zeros((12, 6))
    bass_chroma[5] = 1.0

    fm_diatonic = app._diatonic_states(5, True)
    without = app._chord_path(chroma, bass_chroma, None, key_weight=0.0)
    with_key = app._chord_path(chroma, bass_chroma, None,
                               diatonic=fm_diatonic, key_weight=app.KEY_WEIGHT)

    labels_without = {app._chord_label(s, app.FLAT_NAMES) for s in without}
    labels_with = {app._chord_label(s, app.FLAT_NAMES) for s in with_key}
    check("ton bonusuyla Fm secildi", labels_with == {"Fm"}, str(labels_with))
    print(f"    (bonussuz: {sorted(labels_without)}, bonuslu: {sorted(labels_with)})")

    # Bonus NET bir ucluyu cevirmemeli: F major acikca baskinsa F kalmali
    strong = np.zeros((12, 6))
    strong[5] = 1.0
    strong[0] = 0.9
    strong[9] = 0.95   # A  guclu major uclu
    strong[8] = 0.02   # Ab neredeyse yok
    result = app._chord_path(strong, bass_chroma, None,
                             diatonic=fm_diatonic, key_weight=app.KEY_WEIGHT)
    labels = {app._chord_label(s, app.FLAT_NAMES) for s in result}
    check("net uclu bonusla cevrilmiyor (F kaldi)", labels == {"F"}, str(labels))


def test_low_energy_becomes_n(app):
    chroma = np.zeros((12, 6))
    chroma[[0, 4, 7]] = 1.0
    bass_chroma = np.zeros((12, 6))
    bass_chroma[0] = 1.0
    energy = np.array([1.0, 1.0, 1.0, 0.0001, 0.0001, 1.0])
    states = app._chord_path(chroma, bass_chroma, energy)
    labels = [app._chord_label(s, app.NOTE_NAMES) for s in states]
    check("sessiz beat'ler N oldu", labels[3] == "N" and labels[4] == "N", str(labels))
    check("dolu beat'ler N degil", labels[0] != "N" and labels[5] != "N", str(labels))


def test_downbeat_phase(app):
    # Akor değişimleri 4, 8, 12. beat'lerde -> faz 0
    labels = (["C"] * 4) + (["Am"] * 4) + (["F"] * 4) + (["G"] * 4)
    phase = app._choose_downbeat_phase(labels, None)
    check("degisimler 4'un katlarinda -> faz 0", phase == 0, f"faz={phase}")

    # Değişimler 2, 6, 10'da -> faz 2
    shifted = (["C"] * 2) + (["Am"] * 4) + (["F"] * 4) + (["G"] * 4) + (["C"] * 2)
    phase = app._choose_downbeat_phase(shifted, None)
    check("degisimler 2 offsetli -> faz 2", phase == 2, f"faz={phase}")

    # Hiç değişim yok -> bas enerjisi karar verir (faz 1'de en yüksek)
    flat = ["C"] * 16
    energy = np.zeros(16)
    energy[1::4] = 1.0
    phase = app._choose_downbeat_phase(flat, energy)
    check("degisim yoksa bas enerjisi karar verir", phase == 1, f"faz={phase}")


def test_merge(app):
    labels = ["C", "C", "Am", "Am", "Am", "F"]
    times = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]
    chords = app._merge_chords(labels, times, end_time=3.0)
    check("ardisik ayni akorlar birlestirildi", len(chords) == 3, str(len(chords)))
    check("etiket sirasi korundu", [c["label"] for c in chords] == ["C", "Am", "F"])
    check("ilk akor 0.0-1.0", chords[0] == {"start": 0.0, "end": 1.0, "label": "C"},
          str(chords[0]))
    check("son akor ses sonuna kadar", chords[-1]["end"] == 3.0, str(chords[-1]))
    check("araliklar bitisik",
          all(chords[i]["end"] == chords[i + 1]["start"] for i in range(len(chords) - 1)))


def test_end_to_end(app):
    progression = ["C", "Am", "F", "G"] * 2
    harmonic, bass = synth(progression, bpm=120.0, beats_per_chord=4)
    print(f"\n  sentetik ses: {len(harmonic) / 22050:.1f} sn, "
          f"dizi: {' '.join(progression)}")

    data = app.analyze_core(harmonic, bass, 22050)

    check("bpm ~120", 100.0 <= data["bpm"] <= 140.0, f"{data['bpm']}")
    check("beat listesi dolu", len(data["beats"]) > 20, str(len(data["beats"])))
    check("downbeat listesi dolu", len(data["downbeats"]) > 4, str(len(data["downbeats"])))
    check("downbeat'ler beat'lerin altkumesi",
          set(data["downbeats"]).issubset(set(data["beats"])))

    labels = [chord["label"] for chord in data["chords"]]
    print(f"  bulunan akorlar: {' '.join(labels)}")
    expected = set(progression)
    found = set(labels) - {"N"}
    overlap = len(expected & found)
    check("beklenen akorlarin en az 3'u bulundu", overlap >= 3,
          f"beklenen={sorted(expected)} bulunan={sorted(found)}")
    check("ardisik tekrar yok (birlestirme calisti)",
          all(labels[i] != labels[i + 1] for i in range(len(labels) - 1)))
    check("akor araliklari artan",
          all(c["start"] < c["end"] for c in data["chords"]) and
          all(data["chords"][i]["end"] <= data["chords"][i + 1]["start"] + 1e-6
              for i in range(len(data["chords"]) - 1)))

    # PLAN.md'deki JSON şekli + Aşama 2 revizyonunun eklediği alanlar
    check("json anahtarlari",
          set(data) == {"bpm", "beats", "downbeats", "chords", "key",
                        "beats_source", "downbeats_source", "segment_mode"},
          str(sorted(data)))
    check("ton tespit edildi", isinstance(data["key"], str) and data["key"])
    check("beat kaynagi librosa (beat verilmedi)", data["beats_source"] == "librosa",
          data["beats_source"])
    check("downbeat kaynagi kural", data["downbeats_source"] == "kural",
          data["downbeats_source"])
    app._assert_plain(data)
    check("duz tip bekcisi gecti (torch/numpy nesnesi yok)", True)
    round_trip = json.loads(json.dumps(data))
    check("json serialize/deserialize", round_trip == data)


def test_inversion_end_to_end(app):
    """Bas ucluyu caliyorsa slash akor cikmali: Ab/C, C veya Cm DEGIL.

    Eski davranista bas kok bonusu yuzunden Ab/C -> C/Cm okunuyordu.
    """
    quality, bass = synth(["Ab"] * 4, bpm=120.0, beats_per_chord=4, bass_degree=1)
    data = app.analyze_core(quality, bass, 22050)
    labels = [chord["label"] for chord in data["chords"]]
    print(f"  bas ucluyu calarken bulunan: {labels}")
    check("Ab/C bulundu", any(l == "Ab/C" for l in labels), str(labels))
    check("C veya Cm okunmadi", not any(l in ("C", "Cm") for l in labels), str(labels))

    # Karsilastirma: bas koku calarsa sade Ab
    quality, bass = synth(["Ab"] * 4, bpm=120.0, beats_per_chord=4, bass_degree=0)
    data = app.analyze_core(quality, bass, 22050)
    labels = [chord["label"] for chord in data["chords"]]
    print(f"  bas koku calarken bulunan: {labels}")
    check("bas kokte -> sade Ab", any(l == "Ab" for l in labels), str(labels))


def test_bpm_regression(app):
    """bpm regresyondan: beat_this cikitisini 50 fps (20 ms) izgarasina oturtuyor.

    Medyan aralik bu veriyle bpm'i 60/(k*0.02) kumesine hapsediyor
    (120.0, 125.0, 130.43...). Regresyon egimi izgara gurultusunu ortaliyor.
    """
    for true_bpm in (127.0, 92.0, 143.5):
        period = 60.0 / true_bpm
        raw = np.arange(200) * period
        grid = np.round(raw / 0.02) * 0.02          # beat_this'in izgarasi
        got = app._bpm_from_beats(grid)
        median_bpm = 60.0 / float(np.median(np.diff(grid)))
        check(f"regresyon {true_bpm} bpm'i buluyor", abs(got - true_bpm) < 0.5,
              f"bulundu {got:.2f} (medyan yontemi: {median_bpm:.2f})")

    # Izgarasiz, tam zamanlar da dogru kalmali
    exact = np.arange(64) * (60.0 / 120.0)
    check("izgarasiz veri hala dogru", abs(app._bpm_from_beats(exact) - 120.0) < 0.01,
          str(round(app._bpm_from_beats(exact), 3)))

    # Atlanmis vurus indeksi kaydirmamali: ortadaki bir vurusu at
    period = 60.0 / 127.0
    times = np.arange(120) * period
    times = np.delete(times, [40, 41, 77])
    check("atlanmis vuruslara dayanikli",
          abs(app._bpm_from_beats(times) - 127.0) < 0.5,
          str(round(app._bpm_from_beats(times), 2)))

    check("tek vurus -> 0", app._bpm_from_beats([1.0]) == 0.0)
    check("bos -> 0", app._bpm_from_beats([]) == 0.0)


def test_supplied_beats(app):
    """beat_this'ten gelen beats/downbeats kullanilmali (librosa devre disi)."""
    quality, bass = synth(["C", "Am", "F", "G"], bpm=120.0, beats_per_chord=4)
    # 120 BPM -> 0.5 sn'lik beat'ler, downbeat her 4 beat'te
    beats = [round(i * 0.5, 3) for i in range(32)]
    downbeats = [round(i * 2.0, 3) for i in range(8)]

    data = app.analyze_core(quality, bass, 22050, beats=beats, downbeats=downbeats)
    check("beat kaynagi beat_this", data["beats_source"] == "beat_this",
          data["beats_source"])
    check("downbeat kaynagi beat_this", data["downbeats_source"] == "beat_this",
          data["downbeats_source"])
    check("downbeat'ler beat'lerin altkumesi",
          set(data["downbeats"]).issubset(set(data["beats"])),
          f"{data['downbeats'][:4]} vs {data['beats'][:6]}")
    check("bpm verilen gridden (~120)", 110.0 <= data["bpm"] <= 130.0, str(data["bpm"]))
    labels = [c["label"] for c in data["chords"]]
    print(f"  verilen beat gridiyle: {' '.join(labels)}")
    check("akorlar hala bulunuyor", len(set(labels) - {"N"}) >= 3, str(set(labels)))

    # _snap_to_beats dogrudan: grid disi bir downbeat en yakin beat'e oturur
    snapped = app._snap_to_beats([0.03, 1.02, 99.0], [0.0, 0.5, 1.0, 1.5], 2.0)
    check("downbeat en yakin beat'e oturdu", snapped == [0.0, 1.0], str(snapped))


def test_chart(app):
    """Akor cizelgesi bicimlendirmesi - saf fonksiyon, ses gerekmez."""
    data = {
        "bpm": 120.0,
        "beats": [],
        "downbeats": [12.0, 14.0, 16.0, 18.0, 20.0, 22.0],
        "chords": [
            {"start": 12.0, "end": 14.0, "label": "C"},
            {"start": 14.0, "end": 16.0, "label": "Am"},
            {"start": 16.0, "end": 18.0, "label": "F"},
            {"start": 18.0, "end": 19.0, "label": "G"},
            # G 18-19, C 19-21: degisim 19.0'da, yani 4. olcunun ([18,20)) icinde.
            # 5. olcu ([20,22)) de C ve G'yi paylasiyor.
            {"start": 19.0, "end": 21.0, "label": "C"},
            {"start": 21.0, "end": 24.0, "label": "G"},
        ],
    }
    chart = app._format_chord_chart(data)
    print()
    print(chart)
    lines = chart.splitlines()

    check("basta bpm var", lines[0] == "bpm: 120.0", lines[0])
    bar_lines = [l for l in lines if l.startswith(("0:", "1:"))]
    check("6 olcu -> 2 satir (satir basina 4)", len(bar_lines) == 2, str(len(bar_lines)))

    first = bar_lines[0]
    check("satir basi dakika:saniye", first.startswith("0:12"), first[:6])
    check("satirda 4 olcu var", first.count("|") == 5, first)
    check("satir | ile bitiyor", first.endswith("|"))
    first_cells = [c.strip() for c in first[6:].strip("|").split("|")]
    check("ilk satirin ilk 3 olcusu C Am F", first_cells[:3] == ["C", "Am", "F"],
          str(first_cells))
    check("olcu icinde degisim iki akorla yazildi (4. olcu)",
          first_cells[3] == "G  C", str(first_cells))

    second = bar_lines[1]
    cells = [c.strip() for c in second[6:].strip("|").split("|")]
    check("5. olcu de iki akorlu", cells[0] == "C  G", str(cells))
    check("son olcu tek akor", cells[1] == "G", str(cells))
    check("ikinci satir zamani 0:20", second.startswith("0:20"), second[:6])
    check("kolonlar hizali (tum hucreler ayni genislikte)",
          len({len(c) for c in first[6:].strip("|").split("|")}) == 1, first)

    # downbeat yoksa cokmesin
    empty = app._format_chord_chart({"bpm": 90.0, "downbeats": [], "chords": []})
    check("downbeat yoksa cokmuyor", "cizilemedi" in empty, " ".join(empty.split()))

    check("mmss bicimi", app._mmss(0) == "0:00" and app._mmss(65) == "1:05"
          and app._mmss(605) == "10:05")


def main():
    app = load_app()
    print(f"librosa mantik testi - {ROOT / 'backend' / 'app.py'}\n")
    for test in (
        test_templates,
        test_torchaudio_io_rule,
        test_slash_chords,
        test_diatonic_and_key,
        test_key_bonus_prefers_diatonic,
        test_low_energy_becomes_n,
        test_downbeat_phase,
        test_merge,
        test_chart,
        test_end_to_end,
        test_inversion_end_to_end,
        test_bpm_regression,
        test_supplied_beats,
    ):
        print(f"\n--- {test.__name__} ---")
        test(app)

    print(f"\n{'=' * 60}")
    print(f"gecen: {len(PASSED)}   basarisiz: {len(FAILED)}")
    if FAILED:
        for name in FAILED:
            print(f"  BASARISIZ: {name}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
