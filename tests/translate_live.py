"""Soz cevirisini CANLI API'de dener (Asama 14). Token dosyasindan okunur, ASLA yazdirilmaz.

Gercek sozler/cikti yalniz gitignore'li backend/lyrics_out/ altina yazilir (commit edilmez). Bu dosyada soz yok.

    .\\.venv\\Scripts\\python.exe tests\\translate_live.py list
    .\\.venv\\Scripts\\python.exe tests\\translate_live.py run <baslik parcasi> [--replace] [--show N]
"""

import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://ozdemirmehmet10800-glitch--stem-mikser.modal.run"
TOKEN_FILE = pathlib.Path(r"C:\Users\user\stem-mikser-token.txt")
OUT = ROOT / "backend" / "lyrics_out"


def call(method, path, body=None):
    raw = TOKEN_FILE.read_bytes()
    token = (raw.decode("utf-16") if raw[:2] in (bytes([0xFF, 0xFE]), bytes([0xFE, 0xFF])) else raw.decode("utf-8-sig")).strip()
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method,
                                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8"))
        except Exception:
            return error.code, {}


def songs():
    status, data = call("GET", "/songs")
    return data.get("songs", []) if status == 200 else []


def main():
    args = sys.argv[1:]
    if not args or args[0] == "list":
        for song in songs():
            print(f"{song['id'][:8]}  {str(song.get('title'))[:50]:50}  soz={song.get('lyrics_state')}  ceviri={song.get('translation_state')}")
        return
    needle = args[1].lower()
    replace = "--replace" in args
    show = int(args[args.index("--show") + 1]) if "--show" in args else 0
    found = [s for s in songs() if needle in str(s.get("title", "")).lower() or s["id"].startswith(needle)]
    if not found:
        raise SystemExit("sarki bulunamadi")
    song = found[0]
    sid = song["id"]
    print(f"sarki: {str(song.get('title'))[:50]}  soz={song.get('lyrics_state')}")
    started = time.time()
    status, body = call("POST", f"/songs/{sid}/translate", {"replace": replace})
    print("baslat:", status, {k: v for k, v in body.items() if k != "call_id"})
    if status != 200:
        return
    while True:
        status, body = call("GET", f"/songs/{sid}/translation")
        state = body.get("state") if status == 200 else None
        if status == 200 and state in ("done", "error") or (status == 404 and time.time() - started > 400):
            break
        if time.time() - started > 600:
            print("zaman asimi")
            return
        time.sleep(4)
    print(f"sonuc: {state} ({round(time.time() - started)} sn)", {k: body.get(k) for k in ("code", "message", "lang", "model", "missing", "has_reading")})
    if status != 200 or not body.get("lines"):
        return
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"translate_{sid[:8]}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = body["lines"]
    have = sum(1 for x in lines if x)
    print(f"satir: {len(lines)}  cevirili: {have}  okunuslu(ro): {sum(1 for x in lines if x and x.get('ro'))}")
    if show:
        _, lyr = call("GET", f"/songs/{sid}/lyrics")
        texts = [l["text"] for l in lyr["lyrics"]["lines"]]
        for i, item in list(enumerate(lines))[:show]:
            print(f"\n{i}: {texts[i]}")
            for key in ("tr", "ro"):
                if item and item.get(key):
                    print(f"   {key}: {item[key]}")


if __name__ == "__main__":
    main()
