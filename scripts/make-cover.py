#!/usr/bin/env python
"""生成发布用封面：1280x640（横版）与 1080x1440（竖版）。

素材：真机截图 docs/screenshots/*.png；字体使用系统微软雅黑。
输出：docs/cover.png、docs/cover-vertical.png
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "docs" / "screenshots"
OUT_H = ROOT / "docs" / "cover.png"
OUT_V = ROOT / "docs" / "cover-vertical.png"

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C:/Windows/Fonts/msyh.ttc"

BG_TOP = (10, 16, 28)
BG_BOTTOM = (6, 10, 18)
ACCENT = (77, 171, 247)
ACCENT_2 = (167, 139, 250)
TEXT = (231, 238, 251)
TEXT_2 = (170, 184, 208)
MUTED = (119, 135, 163)


def font(path, size):
    return ImageFont.truetype(path, size)


def gradient(size):
    w, h = size
    img = Image.new("RGB", size, BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def add_glow(img, center, radius, color, alpha=70):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = center
    d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(radius // 2))
    img.alpha_composite(layer)


def rounded_shot(path, width, radius=18, border=(60, 74, 96)):
    shot = Image.open(path).convert("RGB")
    ratio = width / shot.width
    shot = shot.resize((width, int(shot.height * ratio)), Image.LANCZOS)
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, shot.width, shot.height], radius=radius, fill=255)
    out = Image.new("RGBA", shot.size, (0, 0, 0, 0))
    out.paste(shot, (0, 0), mask)
    frame = Image.new("RGBA", (shot.width + 4, shot.height + 4), (0, 0, 0, 0))
    ImageDraw.Draw(frame).rounded_rectangle(
        [0, 0, shot.width + 3, shot.height + 3], radius=radius + 2, outline=border + (200,), width=2
    )
    frame.alpha_composite(out, (2, 2))
    return frame


def chips(draw, x, y, items, size=19, gap=12, pad_x=16, pad_y=9):
    f = font(FONT_REG, size)
    cx = x
    for text in items:
        w = draw.textlength(text, font=f)
        box = [cx, y, cx + w + pad_x * 2, y + size + pad_y * 2]
        draw.rounded_rectangle(box, radius=(size + pad_y * 2) // 2, outline=(70, 86, 112), width=1, fill=(20, 28, 44))
        draw.text((cx + pad_x, y + pad_y - 1), text, font=f, fill=TEXT_2)
        cx = box[2] + gap
    return cx


def build_horizontal():
    w, h = 1280, 640
    img = gradient((w, h)).convert("RGBA")
    add_glow(img, (1050, 90), 320, ACCENT, 60)
    add_glow(img, (200, 620), 300, ACCENT_2, 45)

    d = ImageDraw.Draw(img)

    # 左侧文字
    d.text((72, 118), "NAS助手", font=font(FONT_BOLD, 78), fill=TEXT)
    d.text((74, 216), "飞牛 fnOS 本地运维工具箱", font=font(FONT_REG, 30), fill=ACCENT)
    d.text((74, 268), "本地运行 · 数据不上传 · 零第三方依赖", font=font(FONT_REG, 21), fill=MUTED)

    chips(d, 74, 330, ["一键体检", "系统清理", "网络诊断 / 测速"], size=18, gap=10)
    chips(d, 74, 386, ["安全防护", "服务进程", "Docker"], size=18, gap=10)
    chips(d, 74, 442, ["硬盘存储", "文件管理", "应用中心", "监控"], size=18, gap=10)

    d.text((74, 556), "github.com/84387822-a11y/shuaishuai-nas", font=font(FONT_REG, 20), fill=TEXT_2)
    d.rounded_rectangle([74, 590, 220, 590 + 34], radius=17, fill=(28, 38, 56), outline=(70, 86, 112))
    d.text((94, 596), "v1.0.3", font=font(FONT_REG, 19), fill=ACCENT)

    # 右侧截图：两张叠加
    main = rounded_shot(SHOTS / "01-monitor.png", 620)
    back = rounded_shot(SHOTS / "02-apps-center.png", 470)

    img.alpha_composite(back, (w - back.width - 10, 96 + 26))
    img.alpha_composite(main, (w - main.width - 66, 250))

    img.convert("RGB").save(OUT_H, "PNG", optimize=True)
    return OUT_H


def build_vertical():
    w, h = 1080, 1440
    img = gradient((w, h)).convert("RGBA")
    add_glow(img, (860, 120), 420, ACCENT, 55)
    add_glow(img, (140, 1320), 380, ACCENT_2, 45)

    d = ImageDraw.Draw(img)
    d.text((90, 150), "NAS助手", font=font(FONT_BOLD, 96), fill=TEXT)
    d.text((92, 272), "飞牛 fnOS 本地运维工具箱", font=font(FONT_REG, 40), fill=ACCENT)
    d.text((92, 340), "本地运行 · 数据不上传 · 零第三方依赖", font=font(FONT_REG, 26), fill=MUTED)

    chips(d, 92, 430, ["一键体检", "系统清理", "网络诊断 / 测速"], size=24, gap=14, pad_x=20, pad_y=11)
    chips(d, 92, 510, ["安全防护", "服务进程", "Docker"], size=24, gap=14, pad_x=20, pad_y=11)
    chips(d, 92, 590, ["硬盘存储", "文件管理", "应用中心", "监控"], size=24, gap=14, pad_x=20, pad_y=11)

    shot = rounded_shot(SHOTS / "01-monitor.png", 900, radius=22)
    img.alpha_composite(shot, (90, 700))

    d.text((92, 1250), "github.com/84387822-a11y/shuaishuai-nas", font=font(FONT_REG, 24), fill=TEXT_2)
    d.rounded_rectangle([92, 1300, 268, 1300 + 44], radius=22, fill=(28, 38, 56), outline=(70, 86, 112))
    d.text((118, 1310), "v1.0.3", font=font(FONT_REG, 24), fill=ACCENT)

    img.convert("RGB").save(OUT_V, "PNG", optimize=True)
    return OUT_V


if __name__ == "__main__":
    print("saved", build_horizontal())
    print("saved", build_vertical())
