"""PWA ikonlarini uretir - yalnizca standart kutuphane (zlib + struct).

Pillow gibi bir bagimlilik eklemeye gerek yok. 4x supersampling ile
kenarlari yumusatiyor.

Calistirma:
    .\\.venv\\Scripts\\python.exe tests\\make_icons.py

Uretilenler (frontend/icons/):
    icon-192.png           ana ekran ikonu
    icon-512.png           yuksek cozunurluk
    icon-512-maskable.png  Android maskeleme icin ic %80'de guvenli alan
    apple-touch-icon.png   180x180, iOS manifest ikonunu yok sayiyor
"""

import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "frontend" / "icons"

BG = (7, 9, 13)        # --bg
PANEL = (32, 38, 48)   # fader rayi
ACCENT = (34, 211, 238)  # --accent
WHITE = (240, 245, 250)

SUPERSAMPLE = 4


def write_png(path, width, height, pixels):
    """pixels: [[(r,g,b,a), ...], ...]"""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filtre tipi: None
        for red, green, blue, alpha in row:
            raw += bytes((red, green, blue, alpha))

    def chunk(tag, data):
        body = tag + data
        return (struct.pack(">I", len(data)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)


def rounded_rect(x, y, width, height, radius):
    """Nokta testi donduren bir kapali bicim."""
    def inside(px, py):
        if not (x <= px <= x + width and y <= py <= y + height):
            return False
        for corner_x, corner_y in (
            (x + radius, y + radius),
            (x + width - radius, y + radius),
            (x + radius, y + height - radius),
            (x + width - radius, y + height - radius),
        ):
            near_x = abs(px - corner_x) > 0 and (
                (px < x + radius and corner_x == x + radius)
                or (px > x + width - radius and corner_x == x + width - radius)
            )
            near_y = (
                (py < y + radius and corner_y == y + radius)
                or (py > y + height - radius and corner_y == y + height - radius)
            )
            if near_x and near_y:
                if (px - corner_x) ** 2 + (py - corner_y) ** 2 > radius ** 2:
                    return False
        return True
    return inside


def circle(center_x, center_y, radius):
    def inside(px, py):
        return (px - center_x) ** 2 + (py - center_y) ** 2 <= radius ** 2
    return inside


def render(size, safe_ratio=1.0):
    """Mikser motifi: uc fader rayi ve farkli konumlarda dugmeler.

    safe_ratio < 1 ise icerik ortada kuculterek ciziliyor (maskable icon'da
    Android ikonun kenarlarini kirpabiliyor).
    """
    scale = size * SUPERSAMPLE
    inset = scale * (1 - safe_ratio) / 2
    content = scale * safe_ratio

    def to_content(value):
        return inset + value * content

    shapes = []
    # arka plan yuvarlatilmis kare (tum tuvali kaplar)
    shapes.append((rounded_rect(0, 0, scale, scale, scale * 0.22), BG))

    rail_x0, rail_x1 = 0.16, 0.84
    knob_positions = (0.72, 0.42, 0.60)
    for index, knob in enumerate(knob_positions):
        center_y = to_content((0.30 + index * 0.20))
        thickness = content * 0.035
        shapes.append((
            rounded_rect(to_content(rail_x0), center_y - thickness / 2,
                         content * (rail_x1 - rail_x0), thickness, thickness / 2),
            PANEL,
        ))
        # dugmeye kadar olan kisim vurgulu
        shapes.append((
            rounded_rect(to_content(rail_x0), center_y - thickness / 2,
                         content * (knob - rail_x0), thickness, thickness / 2),
            ACCENT if index == 0 else WHITE,
        ))
        shapes.append((
            circle(to_content(knob), center_y, content * 0.075),
            ACCENT if index == 0 else WHITE,
        ))

    # supersample edilmis tuval
    big = [[BG + (0,) for _ in range(scale)] for _ in range(scale)]
    for test, color in shapes:
        for py in range(scale):
            for px in range(scale):
                if test(px + 0.5, py + 0.5):
                    big[py][px] = color + (255,)

    # 4x -> 1x indirgeme (kenar yumusatma)
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            totals = [0, 0, 0, 0]
            for dy in range(SUPERSAMPLE):
                for dx in range(SUPERSAMPLE):
                    pixel = big[y * SUPERSAMPLE + dy][x * SUPERSAMPLE + dx]
                    for channel in range(4):
                        totals[channel] += pixel[channel]
            count = SUPERSAMPLE * SUPERSAMPLE
            row.append(tuple(value // count for value in totals))
        out.append(row)
    return out


def main():
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        # maskable: icerik ic %80'de kalsin, Android kenarlardan kirpiyor
        ("icon-512-maskable.png", 512, 0.78),
        ("apple-touch-icon.png", 180, 1.0),
    ]
    for name, size, safe in jobs:
        pixels = render(size, safe)
        written = write_png(ICON_DIR / name, size, size, pixels)
        print(f"{name:24} {size}x{size}  {written:>7} bayt")


if __name__ == "__main__":
    main()
