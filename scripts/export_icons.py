"""Export web-ready assets from the Tabler Mail icon on a blue background."""

from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


def export(source: str, target: str, size: int) -> None:
    cairosvg.svg2png(
        url=str(PUBLIC / source),
        write_to=str(PUBLIC / target),
        output_width=size,
        output_height=size,
    )


def main() -> None:
    for size in (16, 32):
        export("logo.svg", f"favicon-{size}.png", size)
    export("logo.svg", "logo-512.png", 512)
    for size in (192, 512):
        export("icon.svg", f"icon-{size}.png", size)
    export("icon.svg", "apple-touch-icon.png", 180)
    export("icon.svg", "icon-1024.png", 1024)
    with Image.open(PUBLIC / "logo-512.png") as logo:
        logo.save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32)])
    print("Exported PNG icons and favicon.ico from SVG sources.")


if __name__ == "__main__":
    main()
