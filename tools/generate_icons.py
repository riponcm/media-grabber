"""
Generate Media Grabber toolbar icons.

Renders a rounded-square mark with an indigo-to-violet gradient and a white
"download" glyph (arrow + tray) at all required sizes. Drawn at 4x and
downscaled with Lanczos for clean anti-aliasing.

Usage:
    python tools/generate_icons.py
"""

from pathlib import Path
from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4

GRADIENT_TOP = (79, 70, 229)      # #4f46e5 indigo
GRADIENT_BOTTOM = (124, 58, 237)  # #7c3aed violet
WHITE = (255, 255, 255, 255)


def vertical_gradient(size: int) -> Image.Image:
    """Return an opaque vertical gradient image of (size x size)."""
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(size):
        t = y / (size - 1)
        color = (
            round(GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t),
            round(GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t),
            round(GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t),
            255,
        )
        for x in range(size):
            px[x, y] = color
    return grad


def render(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rounded gradient background.
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    img.paste(vertical_gradient(s), (0, 0), mask)

    draw = ImageDraw.Draw(img)
    cx = s / 2

    # Arrow shaft.
    shaft_w = s * 0.12
    draw.rounded_rectangle(
        [cx - shaft_w / 2, s * 0.26, cx + shaft_w / 2, s * 0.50],
        radius=shaft_w / 2,
        fill=WHITE,
    )
    # Arrow head (also reads as a media "play" triangle).
    head_w = s * 0.34
    draw.polygon(
        [(cx - head_w / 2, s * 0.44), (cx + head_w / 2, s * 0.44), (cx, s * 0.66)],
        fill=WHITE,
    )
    # Download tray.
    bar_w = s * 0.46
    bar_h = s * 0.085
    draw.rounded_rectangle(
        [cx - bar_w / 2, s * 0.74, cx + bar_w / 2, s * 0.74 + bar_h],
        radius=bar_h / 2,
        fill=WHITE,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        render(size).save(OUT_DIR / f"icon{size}.png")
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
