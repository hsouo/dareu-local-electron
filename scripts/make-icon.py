#!/usr/bin/env python3
"""从 webapp/images/logo/banner_logo.png 生成 exe 图标 build/icon.ico（圆角深蓝底 + 品牌字标）。"""
import os, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'webapp', 'images', 'logo', 'banner_logo.png')
OUT_DIR = os.path.join(ROOT, 'build')
S = 256

os.makedirs(OUT_DIR, exist_ok=True)
if not os.path.exists(SRC):
    sys.exit('缺少 ' + SRC)

logo = Image.open(SRC).convert('RGBA')
print('logo 原始尺寸', logo.size)

canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(canvas)
# 深蓝圆角底
d.rounded_rectangle([6, 6, S - 6, S - 6], radius=46, fill=(13, 22, 40, 255))
d.rounded_rectangle([6, 6, S - 6, S - 6], radius=46, outline=(58, 109, 240, 200), width=4)

# logo 等比缩到宽的 76%，居中
tw = int(S * 0.76)
th = int(logo.height * tw / logo.width)
lg = logo.resize((tw, th), Image.LANCZOS)
canvas.alpha_composite(lg, ((S - tw) // 2, (S - th) // 2 - 6))

# 底部画一个「USB/无线」小点阵，避免 16px 时糊成一块
d = ImageDraw.Draw(canvas)
cy = S - 60
for i in range(3):
    x = S // 2 - 34 + i * 34
    d.ellipse([x - 7, cy - 7, x + 7, cy + 7], fill=(120, 170, 255, 235))

canvas.save(os.path.join(OUT_DIR, 'icon.png'))
canvas.save(os.path.join(OUT_DIR, 'icon.ico'),
            sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print('写出', os.path.join(OUT_DIR, 'icon.ico'), os.path.getsize(os.path.join(OUT_DIR, 'icon.ico')), 'bytes')
