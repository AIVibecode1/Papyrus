# Generates the Papyrus app icon (1024x1024 PNG) using Pillow.
# Usage: .venv/Scripts/python.exe dev/generate-icon.py
# Then regenerate all platform icons with: pnpm exec tauri icon app-icon.png
from PIL import Image, ImageDraw

W = H = 1024
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Background: rounded square, deep navy
d.rounded_rectangle([0, 0, W - 1, H - 1], radius=224, fill=(23, 24, 46, 255))

# Subtle inner glow ring
d.rounded_rectangle(
    [70, 70, W - 71, H - 71], radius=170, outline=(255, 255, 255, 14), width=3
)

GOLD = (214, 175, 55, 255)
GOLD_DARK = (166, 124, 40, 255)
PARCHMENT = (247, 227, 150, 255)

# Scroll geometry
body_w, body_h = 320, 520
bx = (W - body_w) // 2
by = (H - body_h) // 2
roll_w = body_w + 76
roll_h = 96

# Top roll (behind body)
d.rounded_rectangle(
    [bx - 38, by - 40, bx + body_w + 38, by - 40 + roll_h], radius=48, fill=GOLD_DARK
)
# Bottom roll (behind body)
d.rounded_rectangle(
    [bx - 38, by + body_h - roll_h + 40, bx + body_w + 38, by + body_h + 40],
    radius=48,
    fill=GOLD_DARK,
)

# Scroll body (parchment)
d.rounded_rectangle([bx, by, bx + body_w, by + body_h], radius=30, fill=PARCHMENT)

# Roll caps on top of the body (front)
d.rounded_rectangle(
    [bx - 38, by - 40, bx + body_w + 38, by - 40 + roll_h], radius=48, fill=GOLD
)
d.rounded_rectangle(
    [bx - 38, by + body_h - roll_h + 40, bx + body_w + 38, by + body_h + 40],
    radius=48,
    fill=GOLD,
)

# Text lines on the parchment
for i in range(5):
    y = by + 104 + i * 82
    x1 = bx + body_w - 62 - (0 if i % 2 == 0 else 74)
    d.line([bx + 62, y, x1, y], fill=GOLD_DARK, width=16)

# A tiny sparkle accent (AI) at top right of the scroll
sx, sy = bx + body_w - 96, by + 128
d.line([sx, sy - 24, sx, sy + 24], fill=GOLD, width=8)
d.line([sx - 24, sy, sx + 24, sy], fill=GOLD, width=8)

img.save("app-icon.png")
print("app-icon.png written (1024x1024)")
