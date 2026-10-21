"""Genera los iconos PNG de la app (180, 192 y 512 px) sin dependencias externas.

Uso: python tools/make_icons.py
Dibuja un fondo verde azulado con un gráfico de barras blanco (zona segura para iconos "maskable").
"""
import struct
import zlib
from pathlib import Path

BG_TOP = (20, 150, 136)
BG_BOTTOM = (15, 118, 110)
FG = (255, 255, 255)
SS = 4  # supersampling para suavizar bordes


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """True si (x, y) cae dentro del rectángulo redondeado."""
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shapes(u):
    """Formas en coordenadas unitarias (0..1): tres barras y una línea base."""
    bars = [(0.27, 0.56), (0.44, 0.40), (0.61, 0.28)]  # (x izquierda, y superior)
    w = 0.13
    out = [(x, top, x + w, 0.72, 0.03) for x, top in bars]
    out.append((0.22, 0.75, 0.78, 0.785, 0.015))
    return out


def render(size):
    rows = []
    rects = shapes(1)
    for py in range(size):
        t = py / (size - 1)
        bg = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
        row = bytearray([0])  # filtro PNG "None"
        for px in range(size):
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if any(rounded_rect(x, y, *r) for r in rects):
                        hits += 1
            a = hits / (SS * SS)
            row += bytes(round(b + (f - b) * a) for b, f in zip(bg, FG))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # RGB 8 bits, sin transparencia (iOS)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for s in (180, 192, 512):
        (out / f"icon-{s}.png").write_bytes(png(s, render(s)))
        print(f"icons/icon-{s}.png")
