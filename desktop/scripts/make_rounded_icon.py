"""把方形品牌图(build/icon-source.png)做成 macOS 规范的圆角应用图标(build/icon.png)。

为什么需要它:iOS 会自动把方图抠成圆角,但 **macOS 不会**——圆角(squircle)+ 四周透明边距 + alpha
必须事先做进图里,否则桌面上就显示成方块(我们之前那张白底满铺方图就是这个问题)。

栅格(贴合苹果 macOS 图标规范):1024 画布内,本体 824(四周各留 100 透明边),圆角半径 185。
electron-builder 打包时会从这张 icon.png 自动生成 mac 的 .icns 和 win 的 .ico。

改了品牌图后重跑:  python3 scripts/make_rounded_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

BUILD = Path(__file__).resolve().parent.parent / "build"
SRC = BUILD / "icon-source.png"   # 高清原图(art),缩下来更清晰
OUT = BUILD / "icon.png"
CANVAS, TILE, RADIUS = 1024, 824, 185

art = Image.open(SRC).convert("RGBA").resize((TILE, TILE), Image.LANCZOS)
mask = Image.new("L", (TILE, TILE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], radius=RADIUS, fill=255)
canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
off = (CANVAS - TILE) // 2
canvas.paste(art, (off, off), mask)
canvas.save(OUT)
print(f"OK -> {OUT}  (画布 {CANVAS} · 本体 {TILE} · 圆角 {RADIUS} · 带透明边+alpha)")
