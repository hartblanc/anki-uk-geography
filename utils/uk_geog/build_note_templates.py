"""
A barebones CLI for inlining file references into CrowdAnki note templates.

Templates reference external files with plain, valid-HTML placeholder tags
so the source templates stay parseable as HTML on their own:
  - an empty <img src="path/to/file"> is replaced with the referenced
    file's contents (e.g. a full <svg>...</svg> element).
  - an empty <script src="path/to/file"></script> is replaced with a
    <script> tag containing the referenced file's contents.
<script> tags that already have a body (i.e. have no src attribute) are
left untouched, so hand-written inline JS can sit alongside an inlined
snippet. Paths are relative to the directory the script is run from
(advised to be project root).
"""

import argparse
import re
import textwrap
from pathlib import Path
from typing import Iterable

IMG_PATTERN = re.compile(r'([\t ]*)<img src="([^"]+)">')
SCRIPT_SRC_PATTERN = re.compile(r'([\t ]*)<script src="([^"]+)"></script>')


def find_file_references(contents: str) -> set[str]:
    return {path for _, path in IMG_PATTERN.findall(contents)} | {
        path for _, path in SCRIPT_SRC_PATTERN.findall(contents)
    }


def inline_file_references(contents: str, file_contents: dict[str, str]) -> str:
    def replace_img(match: re.Match) -> str:
        whitespace, path = match.groups()
        return textwrap.indent(file_contents[path], whitespace)

    def replace_script(match: re.Match) -> str:
        whitespace, path = match.groups()
        return (
            f"{whitespace}<script>\n"
            f"{textwrap.indent(file_contents[path], whitespace)}\n"
            f"{whitespace}</script>"
        )

    contents = IMG_PATTERN.sub(replace_img, contents)
    contents = SCRIPT_SRC_PATTERN.sub(replace_script, contents)
    return contents


def read_file_references(file_references: Iterable[str]) -> dict[str, str]:
    file_ref_values = dict()
    for file_ref in file_references:
        with Path(file_ref).open(mode="r") as referenced_file:
            file_ref_values[file_ref] = referenced_file.read()

    return file_ref_values


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            'Inlines <img src="..."> and empty <script src="..."></script> '
            "placeholder tags in CrowdAnki note templates with the contents "
            "of the referenced file, so map/script changes ship as part of "
            "the note type instead of relying on Anki media sync."
        )
    )
    parser.add_argument(
        "templates",
        type=Path,
        nargs="+",
        help="The paths to the template files which contain file references.",
    )
    parser.add_argument(
        "-o",
        "--out_directory",
        type=Path,
        help=(
            "The path to the directory where the resolved templates should be "
            "written to. The filenames will be identical to the template used."
        ),
    )

    args = parser.parse_args()

    template_contents = {t_path: t_path.read_text() for t_path in args.templates}

    file_references: set[str] = set()
    for contents in template_contents.values():
        file_references |= find_file_references(contents)

    file_ref_values = read_file_references(file_references)

    for t_path, contents in template_contents.items():
        resolved_contents = inline_file_references(contents, file_ref_values)
        suffix = t_path.suffixes[-1]
        out_path = args.out_directory / t_path.with_suffix("").with_suffix(suffix).name
        out_path.write_text(resolved_contents)
