"""Validate the README and web icon assets without dependencies."""

import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        ERRORS.append(message)


def local_link(source: Path, target: str) -> None:
    target = target.split()[0].strip("<>")
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return
    resolved = (source.parent / unquote(parsed.path)).resolve()
    check(resolved.is_relative_to(ROOT) and resolved.exists(),
          f"{source.relative_to(ROOT)}: broken local link {target}")


def main() -> int:
    for source in [ROOT / "README.md"]:
        text = source.read_text()
        fences = re.findall(r"^\s*```", text, flags=re.MULTILINE)
        check(len(fences) % 2 == 0, f"{source.name}: unclosed code fence")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            local_link(source, target)
        for target in re.findall(r'<img\b[^>]*\bsrc="([^"]+)"', text):
            local_link(source, target)

    namespace = "{http://www.w3.org/2000/svg}"
    for source in (ROOT / "public").glob("*.svg"):
        try:
            svg = ET.parse(source).getroot()
            check(svg.tag == namespace + "svg", f"{source.name}: missing SVG namespace")
            check(svg.attrib.get("viewBox") == "0 0 512 512",
                  f"{source.name}: unexpected viewBox")
            check(svg.find(namespace + "title") is not None,
                  f"{source.name}: missing accessible title")
            for element in svg.iter():
                check(element.tag not in {namespace + "script", namespace + "foreignObject"},
                      f"{source.name}: executable or external SVG content")
                for name, value in element.attrib.items():
                    check(not name.lower().startswith("on"),
                          f"{source.name}: inline event handler")
                    if name.endswith("href"):
                        check(value.startswith("#"), f"{source.name}: external SVG reference")
        except ET.ParseError:
            ERRORS.append(f"{source.name}: malformed SVG")

    sizes = {"favicon-16.png": 16, "favicon-32.png": 32,
             "apple-touch-icon.png": 180, "icon-192.png": 192,
             "icon-512.png": 512, "logo-512.png": 512, "icon-1024.png": 1024}
    for name, size in sizes.items():
        path = ROOT / "public" / name
        if not path.exists():
            ERRORS.append(f"Missing icon: {name}")
            continue
        data = path.read_bytes()
        valid = len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR"
        check(valid, f"{name}: invalid PNG header")
        if valid:
            check(struct.unpack(">II", data[16:24]) == (size, size),
                  f"{name}: incorrect dimensions")

    ico = ROOT / "public/favicon.ico"
    if ico.exists():
        data = ico.read_bytes()
        check(len(data) >= 6 and struct.unpack("<HHH", data[:6]) == (0, 1, 2),
              "favicon.ico: expected a two-size icon file")
    else:
        ERRORS.append("Missing favicon.ico")

    if ERRORS:
        print("Repository validation failed:", file=sys.stderr)
        for error in ERRORS:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("README links, SVG sources, PNG dimensions, and favicon passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
