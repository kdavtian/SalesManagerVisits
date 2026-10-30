# iPhone-style frames: status bar + rounded screen + home-indicator strip + dark bezel + soft shadow.
# Input: ../screenshots/raw/*.png (390x844 @3x). Output: ../screenshots/*.png.   Run: python3 frames.py
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "screenshots", "raw")
OUT = os.path.join(HERE, "..", "screenshots")
S = 3
FONT = "/usr/share/fonts/truetype/inter/Inter-SemiBold.ttf"
import glob, os
cands = glob.glob("/usr/share/fonts/**/Inter*SemiBold*.ttf", recursive=True) + glob.glob("/usr/share/fonts/**/Inter*.ttf", recursive=True) + glob.glob("/usr/share/fonts/**/*Inter*.otf", recursive=True)
FONT = next((c for c in cands if c.endswith("Inter-SemiBold.otf") or c.endswith("Inter-SemiBold.ttf")), cands[0])

def status_bar(w, color, fg):
    h = 50 * S
    im = Image.new("RGB", (w, h), color)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, 17 * S) if FONT else None
    d.text((52 * S, 16 * S), "9:41", fill=fg, font=f)
    # dynamic island
    iw, ih = 124 * S, 36 * S
    d.rounded_rectangle(((w - iw) // 2, 11 * S, (w + iw) // 2, 11 * S + ih), radius=ih // 2, fill=(0, 0, 0))
    # signal bars
    x = w - 112 * S; y = 31 * S
    for i, bh in enumerate((4, 6.5, 9, 11.5)):
        d.rounded_rectangle((x + i * 5.2 * S, y - bh * S, x + i * 5.2 * S + 3.4 * S, y), radius=S, fill=fg)
    # wifi (three arcs)
    cx, cy = w - 73 * S, 32 * S
    for r in (11, 7.5, 4):
        d.arc((cx - r * S, cy - r * S, cx + r * S, cy + r * S), 225, 315, fill=fg, width=int(2.2 * S))
    d.ellipse((cx - 1.6 * S, cy - 3.2 * S, cx + 1.6 * S, cy), fill=fg)
    # battery
    bx, by = w - 52 * S, 20 * S
    d.rounded_rectangle((bx, by, bx + 25 * S, by + 12 * S), radius=3.5 * S, outline=fg, width=int(1.2 * S))
    d.rounded_rectangle((bx + 2 * S, by + 2 * S, bx + 20 * S, by + 10 * S), radius=2 * S, fill=fg)
    d.rounded_rectangle((bx + 26 * S, by + 4 * S, bx + 27.6 * S, by + 8 * S), radius=S, fill=fg)
    return im

def frame(name, bar=(255, 255, 255), fg=(0, 0, 0), out=None, scale=0.5):
    shot = Image.open(os.path.join(RAW, name + ".png")).convert("RGB")
    w, h = shot.size
    sb = status_bar(w, bar, fg)
    hb = 22 * S  # home-indicator strip in the colour of the screen's bottom edge
    bottom = shot.getpixel((w // 2, h - 2))
    screen = Image.new("RGB", (w, h + sb.size[1] + hb), bottom)
    screen.paste(sb, (0, 0)); screen.paste(shot, (0, sb.size[1]))
    ImageDraw.Draw(screen).rounded_rectangle(((w - 134 * S) // 2, h + sb.size[1] + 12 * S, (w + 134 * S) // 2, h + sb.size[1] + 17 * S), radius=3 * S, fill=(20, 20, 20))
    sw, sh = screen.size
    r = 52 * S
    bez = 13 * S
    edge = 2 * S
    pad = 40 * S  # room for the shadow
    W, H = sw + 2 * (bez + edge) + 2 * pad, sh + 2 * (bez + edge) + 2 * pad
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    # shadow
    sh_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh_img).rounded_rectangle((pad, pad + 10 * S, W - pad, H - pad + 10 * S), radius=r + bez + edge, fill=(0, 0, 0, 70))
    sh_img = sh_img.filter(ImageFilter.GaussianBlur(16 * S))
    canvas.alpha_composite(sh_img)
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle((pad, pad, W - pad, H - pad), radius=r + bez + edge, fill=(58, 60, 64, 255))
    d.rounded_rectangle((pad + edge, pad + edge, W - pad - edge, H - pad - edge), radius=r + bez, fill=(14, 14, 16, 255))
    mask = Image.new("L", screen.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw, sh), radius=r, fill=255)
    canvas.paste(screen, (pad + edge + bez, pad + edge + bez), mask)
    # side buttons
    d.rounded_rectangle((pad - 3 * S, pad + 170 * S, pad + 1, pad + 205 * S), radius=S, fill=(58, 60, 64, 255))
    d.rounded_rectangle((pad - 3 * S, pad + 225 * S, pad + 1, pad + 285 * S), radius=S, fill=(58, 60, 64, 255))
    d.rounded_rectangle((W - pad - 1, pad + 230 * S, W - pad + 3 * S, pad + 320 * S), radius=S, fill=(58, 60, 64, 255))
    canvas = canvas.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
    canvas.save(os.path.join(OUT, (out or name) + ".png"), optimize=True)

for n in ["map", "checkin", "customer", "order", "debt", "dashboard", "team", "vaghinak", "vaghinak_rep", "tasks", "reports"]:
    frame(n)
frame("bot", bar=(247, 247, 247))
# shelf audit callout: the Castrol column of the check-in "KAD products" sheet
sh = Image.open(os.path.join(RAW, "shelf.png")).convert("RGB")
crop = sh.crop((0, 292 * S, 196 * S, 778 * S))
cw, ch = crop.size
pad = 30 * S
card = Image.new("RGBA", (cw + 2 * pad, ch + 2 * pad), (0, 0, 0, 0))
shadow = Image.new("RGBA", card.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 6 * S, pad + cw, pad + ch + 6 * S), radius=18 * S, fill=(0, 0, 0, 60))
card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12 * S)))
m = Image.new("L", crop.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, cw, ch), radius=18 * S, fill=255)
card.paste(crop, (pad, pad), m)
card = card.resize((card.size[0] // 2, card.size[1] // 2), Image.LANCZOS)
card.save(os.path.join(OUT, "shelf_audit.png"), optimize=True)
print("frames done", FONT)
