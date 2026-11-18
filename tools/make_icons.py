"""Rasterises the Headroom icon (same geometry as web/icons/icon.svg) to PNGs, no dependencies.

The mark is a screen with its top edge lit: the "lit screens" look (DESIGN.md). Night plate, an off-white outline,
an azure band of light with a soft glow, the band's light spilling a little onto the plate.

Shapes are evaluated as signed distance fields at 4x4 supersampling, so edges are antialiased.
Run: python tools/make_icons.py   (or --macos for just assets/macos/AppIcon.icns)
"""
import math
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "web" / "icons"


def png(path, w, h, rgba):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


def sd_round_rect(px, py, x, y, w, h, r):
    cx, cy = x + w / 2, y + h / 2
    qx, qy = abs(px - cx) - (w / 2 - r), abs(py - cy) - (h / 2 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


# ---- the artwork, in 512-unit design space -------------------------------------------------------------------
OUTLINE = (84, 138, 344, 236, 46)   # x, y, w, h, corner radius (centre line of the stroke)
STROKE = 33.0
BAND = (141, 195, 230, 47, 23.5)
INK = (0xee, 0xf1, 0xf6)
GLOW = (0x2b, 0x99, 0xe7)
LAMP = (0xfa, 0xab, 0x3f)


def plate_color(qx, qy):
    """The night plate: a quiet diagonal from #121722 to #07090d."""
    t = max(0.0, min(1.0, (qx + qy) / 1024))
    return [0x12 * (1 - t) + 0x07 * t, 0x17 * (1 - t) + 0x09 * t, 0x22 * (1 - t) + 0x0d * t]


def art(qx, qy, col):
    """Paints the mark over `col` (the plate colour at this point) and returns the result."""
    d_band = sd_round_rect(qx, qy, *BAND)
    if d_band > 0:
        g = 0.5 * math.exp(-d_band / 26.0)  # the band's light spilling onto the plate
        col = [c * (1 - g) + gc * g for c, gc in zip(col, GLOW)]
    if abs(sd_round_rect(qx, qy, *OUTLINE)) - STROKE / 2 <= 0:
        col = list(INK)
    if d_band <= 0:
        t = max(0.0, min(1.0, (qy - BAND[1]) / BAND[3]))  # brightest at the top edge
        col = [0xe2 * (1 - t) + 0x8f * t, 0xf4 * (1 - t) + 0xd2 * t, 0xff * (1 - t) + 0xff * t]
    return col


def ico(path, images):
    """Windows .ico with PNG-compressed entries (supported since Vista). images: [(size, rgba)]."""
    pngs = []
    for size, rgba in images:
        tmp = path.with_suffix(f".{size}.tmp")
        png(tmp, size, size, rgba)
        pngs.append((size, tmp.read_bytes()))
        tmp.unlink()
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, blobs = b"", b""
    for size, data in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(header + entries + blobs)


def render(size, maskable=False, rounded=True, badge=False):
    s = size / 512.0
    # Maskable icons need content inside the central 80% safe zone and a full-bleed background.
    inner = 0.78 if maskable else 1.0
    off = 256 * (1 - inner)
    rgba = bytearray(size * size * 4)
    ss = 4
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) / ss) / s
                    py = (y + (sy + 0.5) / ss) / s
                    inside_bg = sd_round_rect(px, py, 0, 0, 512, 512, 112) <= 0 if (rounded and not maskable) else True
                    if not inside_bg:
                        continue
                    # map into the (possibly shrunken) content box
                    qx = (px - off) / inner
                    qy = (py - off) / inner
                    col = art(qx, qy, plate_color(px, py))
                    if badge:
                        # "someone is connected" for the tray icon: the warm lamp, with a dark ring to separate it
                        d_dot = math.hypot(px - 412, py - 412) - 100
                        if d_dot <= 26:
                            col = [0x07, 0x09, 0x0d]
                        if d_dot <= 0:
                            col = list(LAMP)
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = ss * ss
            i = (y * size + x) * 4
            a = acc[3] / n
            if a > 0:
                rgba[i] = int(acc[0] / (acc[3] / 255))
                rgba[i + 1] = int(acc[1] / (acc[3] / 255))
                rgba[i + 2] = int(acc[2] / (acc[3] / 255))
            rgba[i + 3] = int(a)
    return rgba


def render_macos(size):
    """macOS app icon: the same artwork on Apple's icon grid — an 824/1024 rounded plate centred in the canvas,
    with a soft drop shadow (the system does not round or shade app icons itself)."""
    s = size / 1024.0
    plate, inset = 824.0, 100.0
    k = plate / 512.0  # design units -> canvas units
    rgba = bytearray(size * size * 4)
    ss = 2
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            cov = 0.0
            shadow = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) / ss) / s
                    py = (y + (sy + 0.5) / ss) / s
                    # design coordinates inside the plate
                    qx, qy = (px - inset) / k, (py - inset) / k
                    d_plate = sd_round_rect(qx, qy, 0, 0, 512, 512, 115)
                    if d_plate > 0:
                        # shadow: offset down 12 px, ~28 px falloff
                        ds = sd_round_rect(qx, qy - 12 / k, 0, 0, 512, 512, 115) * k
                        shadow += max(0.0, 1 - max(0.0, ds) / 28.0) ** 2 * 0.32
                        continue
                    col = art(qx, qy, plate_color(qx, qy))
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]
                    cov += 1
            n = ss * ss
            i = (y * size + x) * 4
            a_plate = cov / n
            a_shadow = (shadow / n) * (1 - a_plate)
            a = a_plate + a_shadow
            if a > 0:
                # plate colour over black shadow, straight alpha
                rgba[i] = int(acc[0] / n / a) if cov else 0
                rgba[i + 1] = int(acc[1] / n / a) if cov else 0
                rgba[i + 2] = int(acc[2] / n / a) if cov else 0
            rgba[i + 3] = int(min(1.0, a) * 255)
    return rgba


def macos_icns(out_path):
    """Renders 1024 px once, downsizes with sips, packs with iconutil (macOS only)."""
    import shutil
    import subprocess
    import tempfile
    if not shutil.which("iconutil") or not shutil.which("sips"):
        print("skipping macOS icon (needs iconutil + sips)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        master = tmp / "master.png"
        png(master, 1024, 1024, render_macos(1024))
        iconset = tmp / "AppIcon.iconset"
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = base * scale
                name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
                subprocess.run(["sips", "-z", str(px), str(px), str(master), "--out", str(iconset / name)], check=True, capture_output=True)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out_path)], check=True)
    print("wrote", out_path)


def main():
    import sys
    if "--macos" in sys.argv:  # only the macOS icon (fast path for tools/build-macos.sh)
        macos_icns(OUT.parent.parent / "assets" / "macos" / "AppIcon.icns")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, maskable, rounded in [
        ("icon-192.png", 192, False, True),
        ("icon-512.png", 512, False, True),
        ("icon-maskable-512.png", 512, True, False),
        ("apple-touch-icon.png", 180, False, False),  # iOS rounds the corners itself; must be opaque
    ]:
        png(OUT / name, size, size, render(size, maskable, rounded))
        print("wrote", OUT / name)
    # Windows app / tray icons
    assets = OUT.parent.parent / "assets"
    assets.mkdir(exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    ico(assets / "headroom.ico", [(n, render(n)) for n in sizes])
    ico(assets / "headroom-active.ico", [(n, render(n, badge=True)) for n in sizes])
    print("wrote", assets / "headroom.ico", "and headroom-active.ico")
    # macOS app icon (Headroom Server.app and Headroom Viewer.app)
    macos_icns(assets / "macos" / "AppIcon.icns")


if __name__ == "__main__":
    main()
