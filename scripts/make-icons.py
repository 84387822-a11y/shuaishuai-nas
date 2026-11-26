#!/usr/bin/env python3
"""生成应用图标：NAS助手。

用法：python scripts/make-icons.py
依赖：Pillow（飞牛/DSH 环境已内置）
输出：
  web/logo.png           512x512（界面用，圆角由 CSS 处理）
  web/favicon.png        64x64
  fpk/ICON.PNG           64x64   （fnOS 小图标）
  fpk/ICON_256.PNG       256x256 （fnOS 大图标）
  fpk/ui/images/icon-64.png / icon-256.png（桌面入口）
"""

import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024


def find_font():
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def gradient(size):
    """对角渐变：蓝 -> 紫，带左上角柔光。"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    c1 = (77, 171, 247)
    c2 = (124, 58, 237)
    c3 = (12, 18, 32)
    for y in range(size):
        for x in range(size):
            t = (x / size) * 0.55 + (y / size) * 0.45
            # 主体渐变
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            # 右下角压暗，制造层次
            d = max(0.0, (x / size + y / size - 1.1)) * 1.7
            r = int(r + (c3[0] - r) * d)
            g = int(g + (c3[1] - g) * d)
            b = int(b + (c3[2] - b) * d)
            # 左上柔光
            glow = max(0.0, 1 - ((x / size) ** 2 + (y / size) ** 2) * 2.4)
            r = min(255, int(r + 45 * glow))
            g = min(255, int(g + 45 * glow))
            b = min(255, int(b + 45 * glow))
            px[x, y] = (r, g, b)
    return img


def build(size=1024):
    base = gradient(size).convert("RGBA")

    # 内嵌细边，增加精致感
    frame = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(frame)
    inset = int(size * 0.055)
    fd.rounded_rectangle(
        [inset, inset, size - inset, size - inset],
        radius=int(size * 0.16),
        outline=(255, 255, 255, 38),
        width=max(2, int(size * 0.006)),
    )
    base = Image.alpha_composite(base, frame)

    # 背景柔光斑
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        [-size * 0.25, -size * 0.35, size * 0.75, size * 0.55],
        fill=(255, 255, 255, 26),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.09))
    base = Image.alpha_composite(base, glow)

    font_path = find_font()
    if font_path:
        font = ImageFont.truetype(font_path, int(size * 0.52))
        text = "帅"
        layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        box = d.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        x = (size - tw) / 2 - box[0]
        y = (size - th) / 2 - box[1] - size * 0.015

        # 投影
        shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        sd.text((x, y + size * 0.015), text, font=font, fill=(4, 10, 24, 150))
        shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.024))
        base = Image.alpha_composite(base, shadow)

        d.text((x, y), text, font=font, fill=(255, 255, 255, 248))
        base = Image.alpha_composite(base, layer)

        # 右下角的播放三角，点题「影视」
        tri = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        td = ImageDraw.Draw(tri)
        cx, cy = size * 0.785, size * 0.79
        r = size * 0.085
        td.rounded_rectangle(
            [cx - r * 1.35, cy - r * 1.35, cx + r * 1.35, cy + r * 1.35],
            radius=r * 0.75,
            fill=(255, 255, 255, 34),
            outline=(255, 255, 255, 90),
            width=max(2, int(size * 0.004)),
        )
        td.polygon(
            [
                (cx - r * 0.36, cy - r * 0.62),
                (cx - r * 0.36, cy + r * 0.62),
                (cx + r * 0.66, cy),
            ],
            fill=(255, 255, 255, 235),
        )
        base = Image.alpha_composite(base, tri)
    else:
        # 没有中文字体时退化为几何图形：三层圆角盘片 + 播放三角
        d = ImageDraw.Draw(base)
        for i, alpha in enumerate((60, 90, 240)):
            w = size * (0.52 - i * 0.06)
            h = size * 0.1
            x = (size - w) / 2
            y = size * (0.3 + i * 0.135)
            d.rounded_rectangle([x, y, x + w, y + h], radius=h / 2, fill=(255, 255, 255, alpha))

    return base


def rounded(img, radius_ratio=0.22, size=None):
    """给网页用的小图加圆角（保留透明背景）。"""
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, img.size[0], img.size[1]], radius=int(img.size[0] * radius_ratio), fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("wrote", os.path.relpath(path, ROOT), img.size)


def main():
    art = build(S)

    save(rounded(art, 0.22, 512), os.path.join(ROOT, "web", "logo.png"))
    save(rounded(art, 0.22, 64), os.path.join(ROOT, "web", "favicon.png"))

    # fnOS 规范：完整正方形直角图标
    save(art.resize((256, 256), Image.LANCZOS), os.path.join(ROOT, "fpk", "ICON_256.PNG"))
    save(art.resize((64, 64), Image.LANCZOS), os.path.join(ROOT, "fpk", "ICON.PNG"))

    save(art.resize((256, 256), Image.LANCZOS), os.path.join(ROOT, "fpk", "ui", "images", "icon_256.png"))
    save(art.resize((64, 64), Image.LANCZOS), os.path.join(ROOT, "fpk", "ui", "images", "icon_64.png"))


if __name__ == "__main__":
    main()
