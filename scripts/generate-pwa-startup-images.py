from pathlib import Path
import re

from PIL import Image

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
BACKGROUND = "#101114"
ICON_SIZE = 84
VIEWPORTS = [
    (375, 667, 2),
    (375, 812, 3),
    (390, 844, 3),
    (393, 852, 3),
    (402, 874, 3),
    (414, 736, 3),
    (414, 896, 2),
    (414, 896, 3),
    (420, 912, 3),
    (428, 926, 3),
    (430, 932, 3),
    (440, 956, 3),
    (744, 1133, 2),
    (768, 1024, 2),
    (810, 1080, 2),
    (820, 1180, 2),
    (834, 1194, 2),
    (834, 1210, 2),
    (1024, 1366, 2),
    (1032, 1376, 2),
]


def main():
    output = WEB / "public" / "startup"
    output.mkdir(exist_ok=True)
    with Image.open(WEB / "public" / "icon-512.png") as source:
        icons = {
            scale: source.convert("RGBA").resize((ICON_SIZE * scale,) * 2, Image.Resampling.LANCZOS)
            for scale in {scale for _, _, scale in VIEWPORTS}
        }

    links = []
    for width, height, scale in VIEWPORTS:
        icon = icons[scale]
        for orientation, (image_width, image_height) in [
            ("portrait", (width * scale, height * scale)),
            ("landscape", (height * scale, width * scale)),
        ]:
            filename = f"moondi-{image_width}x{image_height}.png"
            screen = Image.new("RGB", (image_width, image_height), BACKGROUND)
            center = ((image_width - icon.width) // 2, (image_height - icon.height) // 2)
            screen.paste(icon, center, icon)
            screen.quantize(colors=32).save(output / filename, optimize=True)
            media = (
                f"(device-width: {width}px) and (device-height: {height}px) and "
                f"(-webkit-device-pixel-ratio: {scale}) and (orientation: {orientation})"
            )
            links.append(f'    <link rel="apple-touch-startup-image" href="/startup/{filename}" media="{media}" />')

    index = WEB / "index.html"
    contents, count = re.subn(
        r'(?:[ \t]*<link rel="apple-touch-startup-image"[^\n]*\n)+',
        "\n".join(links) + "\n",
        index.read_text(encoding="utf-8"),
        count=1,
    )
    if count != 1:
        raise ValueError("index.html must contain one block of apple-touch-startup-image links")
    index.write_text(contents, encoding="utf-8")


if __name__ == "__main__":
    main()
