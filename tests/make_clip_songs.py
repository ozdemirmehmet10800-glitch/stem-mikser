"""Sentetik KESIT sarkilari uretir (S/M cizirtisi tekrar uretimi icin).

Deney sarkilari gibi: id'si -pd<harf>s ile biter, 21 sn, chords.json YOK.
Stem'ler WAV baytlari ama .m4a adiyla yaziliyor; decodeAudioData icerigi
koklediginden on yuz fark etmiyor (yerelde ffmpeg yok).

    python tests/make_clip_songs.py 12
"""
import array
import hashlib
import json
import math
import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
RATE = 48000
SECONDS = 21
STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def wav_bytes(samples):
    data = samples.tobytes()
    head = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
    head += struct.pack("<IHHIIHH", 16, 1, 2, RATE, RATE * 4, 4, 16)
    return head + b"data" + struct.pack("<I", len(data)) + data


def render(stem, seed):
    n = RATE * SECONDS
    out = array.array("h", [0]) * (n * 2)
    freq = {"vocals": 440, "bass": 55, "guitar": 220, "piano": 330, "other": 660}
    for i in range(n):
        t = i / RATE
        if stem == "drums":
            phase = (t * 2) % 1.0            # 120 bpm vurus
            v = math.exp(-phase * 30) * math.sin(2 * math.pi * 90 * phase)
        else:
            f = freq[stem] * (1 + 0.01 * seed)
            v = 0.5 * math.sin(2 * math.pi * f * t)
        s = int(max(-1, min(1, v * 0.6)) * 32767)
        out[2 * i] = s
        out[2 * i + 1] = s
    return out


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    cache = {}
    for k in range(count):
        sid = hashlib.sha256(f"clip-{k}".encode()).hexdigest() + f"-pd{chr(97 + k)}s"
        folder = OUT / sid / "stems"
        folder.mkdir(parents=True, exist_ok=True)
        for stem in STEMS:
            key = (stem, k % 3)
            if key not in cache:
                cache[key] = wav_bytes(render(stem, k % 3))
            (folder / f"{stem}.m4a").write_bytes(cache[key])
        (OUT / sid / "status.json").write_text(json.dumps({
            "state": "done", "progress": 100, "title": f"Kesit {chr(65 + k)}",
            "duration": SECONDS, "stems": STEMS, "samplerate": 48000,
            "channels": 2, "quality": "hifi"}), encoding="utf-8")
    print(f"{count} kesit sarkisi yazildi: {OUT}")


if __name__ == "__main__":
    main()
