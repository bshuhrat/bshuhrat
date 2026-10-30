"""Генерирует полосы «НАРУШЕНИЕ» / «ИСПРАВЛЕНО» для фото и сохраняет их в src/banners.js.

Запуск: python3 scripts/make_banners.py  (нужен Pillow и шрифт DejaVu Sans Bold)
"""
import base64
import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 150
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
OUT = Path(__file__).resolve().parent.parent / "src" / "banners.js"


def banner(text: str, color: tuple[int, int, int], icon: str) -> bytes:
    img = Image.new("RGBA", (W, H), color + (235,))
    d = ImageDraw.Draw(img)
    # иконка: белый круг с крестиком или галочкой
    cx, cy, r = 95, H // 2, 52
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill="white")
    w = 14
    if icon == "cross":
        k = 26
        d.line((cx - k, cy - k, cx + k, cy + k), fill=color, width=w)
        d.line((cx - k, cy + k, cx + k, cy - k), fill=color, width=w)
    else:
        d.line((cx - 28, cy + 2, cx - 8, cy + 24), fill=color, width=w, joint="curve")
        d.line((cx - 8, cy + 24, cx + 30, cy - 22), fill=color, width=w, joint="curve")
    font = ImageFont.truetype(FONT, 92)
    d.text((180, H // 2), text, font=font, fill="white", anchor="lm")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main() -> None:
    violation = banner("НАРУШЕНИЕ", (220, 38, 38), "cross")
    fixed = banner("ИСПРАВЛЕНО", (22, 163, 74), "check")
    OUT.write_text(
        "// Сгенерировано scripts/make_banners.py — полосы, которые бот рисует поверх фото.\n"
        f'export const VIOLATION_PNG = "{base64.b64encode(violation).decode()}";\n'
        f'export const FIXED_PNG = "{base64.b64encode(fixed).decode()}";\n'
    )
    print(f"{OUT}: {len(violation)} + {len(fixed)} байт")


if __name__ == "__main__":
    main()
