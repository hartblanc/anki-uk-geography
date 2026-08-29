#!/usr/bin/env python3
"""Generate front/back screenshots of card types using headless Chrome.

The script reads the built CrowdAnki deck, renders each note template with a
real note's fields, wraps it in the same HTML shell Anki uses, and screenshots
each side with headless Chrome.

Examples:
  # All card types, light mode
  python utils/uk_geog/generate_screenshots.py

  # Dark mode for three specific cards, using named sample notes, stitched
  # into a 2-column (front, back) grid.
  python utils/uk_geog/generate_screenshots.py \
    --dark \
    --only "City - Map,City - County,BoW - Map" \
    --sample "City - Map:City=Gloucester" \
    --sample "City - County:City=Gloucester" \
    --sample "BoW - Map:BoW=Bristol Channel" \
    --stitch build/screenshots/dark-mode-grid.png
"""

from __future__ import annotations

import argparse
import http.server
import json
import re
import shutil
import socket
import subprocess
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DECK = (
    REPO_ROOT
    / "build"
    / "United Kingdom Geography - Regions Counties and Cities"
    / "deck.json"
)
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEFAULT_OUT = REPO_ROOT / "build" / "screenshots"
MEDIA_DIR = REPO_ROOT / "build" / "media"
MEDIA_FILES = ["maps.js", "zoombox.js", "move_to_front.js"]
VIEWPORT = (800, 1159)

# Fields that must be populated for each template to produce a meaningful card.
REQUIRED_FIELDS = {
    "BoW - Map": ["BoW"],
    "City - County": ["City", "MacroLocation"],
    "City - Map": ["City"],
    "County - Map": ["County"],
    "County - Region": ["County", "MacroLocation"],
    "Map - BoW": ["BoW"],
    "Map - City": ["City"],
    "Map - County": ["County"],
    "Map - Region": ["Region"],
    "Region - Map": ["Region"],
}


def render_template(template: str, fields: dict[str, str]) -> str:
    """Render the subset of mustache used by these templates.

    Supports {{#Field}}...{{/Field}} conditionals and {{Field}} substitutions.
    """

    def section(match: re.Match) -> str:
        name = match.group(1)
        inner = match.group(2)
        return inner if fields.get(name, "").strip() else ""

    template = re.sub(
        r"\{\{#(\w+)\}\}(.*?)\{\{/\1\}\}", section, template, flags=re.S
    )
    template = re.sub(r"\{\{(\w+)\}\}", lambda m: fields.get(m.group(1), ""), template)
    return template


def find_note(
    notes: list,
    field_names: list[str],
    required: list[str] | None = None,
    sample: dict[str, str] | None = None,
) -> dict[str, str] | None:
    required = required or []
    for note in notes:
        values = dict(zip(field_names, note["fields"]))
        if sample and any(
            values.get(field, "").strip() != value
            for field, value in sample.items()
        ):
            continue
        if all(values.get(field, "").strip() for field in required):
            return values
    return None


def slug(name: str) -> str:
    return name.lower().replace(" - ", "-").replace(" ", "-")


def wrap_html(css: str, body: str, dark: bool = False) -> str:
    body_class = ' class="nightMode"' if dark else ""
    dark_css = ""
    if dark:
        dark_css = """
body.nightMode {
  background-color: #2f2f31;
  color: #d0d0d0;
}
body.nightMode .card {
  background-color: #2f2f31;
  color: #d0d0d0;
}
"""
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
{css}
{dark_css}
</style>
</head>
<body{body_class}>
<div class="card">
{body}
</div>
</body>
</html>
"""


def parse_samples(items: list[str]) -> dict[str, dict[str, str]]:
    samples: dict[str, dict[str, str]] = {}
    for item in items:
        template, _, field_eq = item.partition(":")
        field, _, value = field_eq.partition("=")
        samples.setdefault(template.strip(), {})[field.strip()] = value.strip()
    return samples


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def serve(directory: Path):
    handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(  # noqa: E731
        *args, directory=str(directory), **kwargs
    )
    port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def screenshot(chrome: str, url: str, out_png: Path) -> None:
    subprocess.run(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            f"--window-size={VIEWPORT[0]},{VIEWPORT[1]}",
            "--virtual-time-budget=5000",
            f"--screenshot={out_png}",
            url,
        ],
        check=True,
    )


def stitch(captured: list[tuple[str, Path, Path]], out_png: Path, dark: bool) -> None:
    files = []
    for _name, front, back in captured:
        files.extend([str(front), str(back)])
    background = "#2f2f31" if dark else "white"
    subprocess.run(
        [
            "montage",
            *files,
            "-tile",
            f"2x{len(captured)}",
            "-geometry",
            "+4+4",
            "-background",
            background,
            str(out_png),
        ],
        check=True,
    )
    print(f"Stitched {len(captured)} cards -> {out_png}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deck", type=Path, default=DEFAULT_DECK)
    parser.add_argument("--chrome", type=Path, default=DEFAULT_CHROME)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--dark", action="store_true", help="Render in dark mode")
    parser.add_argument(
        "--only",
        help="Comma-separated template names to capture (default: all)",
    )
    parser.add_argument(
        "--sample",
        action="append",
        default=[],
        metavar="TEMPLATE:FIELD=VALUE",
        help="Select a specific note for a template; repeatable",
    )
    parser.add_argument(
        "--stitch",
        type=Path,
        help="Stitch captured front/back pairs into a 2-column grid at this path",
    )
    args = parser.parse_args()

    deck = json.loads(args.deck.read_text())
    model = deck["note_models"][0]
    field_names = [field["name"] for field in model["flds"]]
    css = model["css"]
    samples = parse_samples(args.sample)

    templates = model["tmpls"]
    if args.only:
        only_names = [name.strip() for name in args.only.split(",")]
        by_name = {tmpl["name"]: tmpl for tmpl in templates}
        templates = [by_name[name] for name in only_names if name in by_name]

    # Intermediate HTML goes under build/ (git-ignored); only the PNGs are output.
    html_dir = REPO_ROOT / "build" / "screenshots" / "html"
    html_dir.mkdir(parents=True, exist_ok=True)
    for media in MEDIA_FILES:
        shutil.copy(MEDIA_DIR / media, html_dir / media)

    server, port = serve(html_dir)
    captured: list[tuple[str, Path, Path]] = []
    try:
        for tmpl in templates:
            name = tmpl["name"]
            required = REQUIRED_FIELDS.get(name, [])
            fields = find_note(
                deck["notes"],
                field_names,
                required=required,
                sample=samples.get(name),
            )
            if fields is None:
                print(f"Skipping {name}: no matching note found")
                continue

            base = slug(name)
            suffix = "-dark" if args.dark else ""
            front_png = args.out / f"{base}-front{suffix}.png"
            back_png = args.out / f"{base}-back{suffix}.png"

            for side, source, out_png in (
                ("front", tmpl["qfmt"], front_png),
                ("back", tmpl["afmt"], back_png),
            ):
                html = wrap_html(css, render_template(source, fields), dark=args.dark)
                html_path = html_dir / f"{base}-{side}{suffix}.html"
                html_path.write_text(html)
                url = f"http://127.0.0.1:{port}/{html_path.name}"
                print(f"Capturing {name} {side} -> {out_png}")
                screenshot(args.chrome, url, out_png)

            captured.append((name, front_png, back_png))
    finally:
        server.shutdown()

    if args.stitch and captured:
        stitch(captured, args.stitch, dark=args.dark)


if __name__ == "__main__":
    main()
