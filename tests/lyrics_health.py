"""Canlı kitaplıktaki sözlerin zaman sağlığı (SALT OKUNUR: yalnız GET). Söz metni yazdırmaz; yalnız satır numaraları ve sayılar.

İki tür bozukluk aranır (2026-11-28 dersi: 26 Kasım taraması yalnız TAM aynı ana yığılmayı arıyordu ve "холод по спине"deki
0,24 sn'lik sıkışmayı kaçırmıştı):
  - yığılma: ardışık satırların başlangıcı < 0,15 sn arayla (Nothing Else Matters, eski hizalama)
  - sıkışma: en az 2 kelimelik satırın süresi < 0,6 sn (tekrar eden kıtada sıkışan kopya)

    .venv\\Scripts\\python.exe tests\\lyrics_health.py        (token: C:\\Users\\user\\stem-mikser-token.txt)
Çıkış kodu: sorun yoksa 0, varsa 1. Ücretsiz (GPU yok). run_all'da DEĞİL (canlı sunucuya bağlanır).
"""

import json
import pathlib
import sys
import urllib.request

API = "https://ozdemirmehmet10800-glitch--stem-mikser.modal.run"
TOKEN_FILE = pathlib.Path(r"C:\Users\user\stem-mikser-token.txt")
STACK_SECONDS = 0.15
SHORT_SECONDS = 0.6


def get(path, token):
    request = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token})
    return json.load(urllib.request.urlopen(request, timeout=60))


def problems(lines):
    stacked = [i + 1 for i, (a, b) in enumerate(zip(lines, lines[1:])) if abs(b["t"] - a["t"]) < STACK_SECONDS]
    short = [i for i, line in enumerate(lines) if (line.get("e", 0) - line["t"]) < SHORT_SECONDS and len(line["text"].split()) >= 2]
    return stacked, short


def main():
    token = TOKEN_FILE.read_text(encoding="utf-16").strip()
    songs = get("/songs", token)
    songs = songs if isinstance(songs, list) else songs["songs"]
    bad = 0
    for song in songs:
        if song.get("lyrics_state") != "done":
            continue
        lines = (get(f"/songs/{song['id']}/lyrics", token).get("lyrics") or {}).get("lines") or []
        stacked, short = problems(lines)
        low = sum(1 for line in lines if line.get("c") == 0)
        flag = "SORUN" if (stacked or short) else "tamam"
        bad += bool(stacked or short)
        print(f"{flag:5s} {song['id'][:8]} {len(lines):3d} satır | yığılan {stacked} | sıkışan {short} | düşük güven {low} | "
              f"{(song.get('title') or '')[:40]}")
    print(f"\n{bad} şarkıda sorun" if bad else "\nhiçbir şarkıda yığılma/sıkışma yok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
