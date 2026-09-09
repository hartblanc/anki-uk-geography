"""
A barebones CLI for inlining file references into CrowdAnki note templates.

Templates opt in to having a tag's contents replaced by adding the
`data-anki-inline` attribute, so the substitution is visible on the tag
itself rather than being an unmarked side effect of using <img>/<script>
with a `src`:
  - an empty <img data-anki-inline src="path/to/file"> is replaced with the
    referenced file's contents (e.g. a full <svg>...</svg> element).
  - an empty <script data-anki-inline src="path/to/file"></script> is
    replaced with a <script> tag containing the referenced file's contents.
<img>/<script> tags without `data-anki-inline` (and <script> tags that
already have a body) are left untouched, so hand-written inline JS and
ordinary media references can sit alongside these. Paths are relative to the
directory the script is run from (advised to be project root).

Templates are parsed with the standard library's HTMLParser rather than
regex, so tag matching follows real HTML tokenization (attribute order,
quoting, and whitespace inside the tag don't matter) instead of a pattern
that only recognizes one exact spelling of the tag.
"""

from __future__ import annotations

import argparse
import textwrap
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable

INLINE_ATTR = "data-anki-inline"
INLINABLE_TAGS = ("img", "script")


class TemplateParseError(ValueError):
    def __init__(self, parser: "InlineReferenceParser", message: str):
        line, col = parser.getpos()
        super().__init__(f"{message} (line {line}, column {col})")


def _line_start_offsets(contents: str) -> list[int]:
    offsets = [0]
    for line in contents.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    return offsets


def _leading_whitespace(contents: str, tag_start: int) -> tuple[str, int]:
    """Return the run of spaces/tabs immediately before an offset, and where it starts."""
    start = tag_start
    while start > 0 and contents[start - 1] in " \t":
        start -= 1
    return contents[start:tag_start], start


class Reference:
    __slots__ = ("start", "end", "tag", "path", "whitespace")

    def __init__(self, start: int, end: int, tag: str, path: str, whitespace: str):
        self.start = start
        self.end = end
        self.tag = tag
        self.path = path
        self.whitespace = whitespace


class InlineReferenceParser(HTMLParser):
    """Finds tags opted into inlining via `data-anki-inline` and their spans.

    <img data-anki-inline> tags are recorded as soon as they're seen. <script
    data-anki-inline> tags must have no body: recording is deferred until the
    matching </script>, and any non-whitespace content in between is an
    error.
    """

    def __init__(self, contents: str):
        super().__init__(convert_charrefs=True)
        self.contents = contents
        self._line_offsets = _line_start_offsets(contents)
        self.references: list[Reference] = []
        self._pending_script: tuple[int, str, str] | None = None

    def _offset(self) -> int:
        line, col = self.getpos()
        return self._line_offsets[line - 1] + col

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_starttag(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_starttag(tag, attrs)
        if tag == "script" and self._pending_script is not None:
            # Self-closed <script data-anki-inline src="..." /> has an empty
            # body by construction; resolve it immediately.
            start, path, whitespace = self._pending_script
            end = self._offset() + len(self.get_starttag_text())
            self.references.append(Reference(start, end, "script", path, whitespace))
            self._pending_script = None

    def _handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = dict(attrs)
        has_inline_attr = INLINE_ATTR in attr_dict

        if not has_inline_attr:
            return

        if tag not in INLINABLE_TAGS:
            raise TemplateParseError(
                self,
                f"{INLINE_ATTR} is only supported on {INLINABLE_TAGS}, found <{tag}>",
            )

        path = attr_dict.get("src")
        if not path:
            raise TemplateParseError(self, f"<{tag} {INLINE_ATTR}> is missing a src attribute")

        tag_start = self._offset()
        whitespace, replace_start = _leading_whitespace(self.contents, tag_start)

        if tag == "img":
            tag_end = tag_start + len(self.get_starttag_text())
            self.references.append(Reference(replace_start, tag_end, "img", path, whitespace))
        else:
            if self._pending_script is not None:
                raise TemplateParseError(self, "nested <script> while awaiting a </script>")
            self._pending_script = (replace_start, path, whitespace)

    def handle_data(self, data: str) -> None:
        if self._pending_script is not None and data.strip():
            raise TemplateParseError(
                self, f"<script {INLINE_ATTR}> tags must be empty; found body content"
            )

    def handle_endtag(self, tag: str) -> None:
        if tag != "script" or self._pending_script is None:
            return
        start, path, whitespace = self._pending_script
        end = self.contents.index(">", self._offset()) + 1
        self.references.append(Reference(start, end, "script", path, whitespace))
        self._pending_script = None

    def close(self) -> None:
        super().close()
        if self._pending_script is not None:
            raise ValueError(f"<script {INLINE_ATTR}> was never closed")


def find_file_references(contents: str) -> set[str]:
    parser = InlineReferenceParser(contents)
    parser.feed(contents)
    parser.close()
    return {reference.path for reference in parser.references}


def inline_file_references(contents: str, file_contents: dict[str, str]) -> str:
    parser = InlineReferenceParser(contents)
    parser.feed(contents)
    parser.close()

    pieces = []
    cursor = 0
    for reference in sorted(parser.references, key=lambda r: r.start):
        pieces.append(contents[cursor : reference.start])
        referenced_contents = file_contents[reference.path]
        if reference.tag == "img":
            pieces.append(textwrap.indent(referenced_contents, reference.whitespace))
        else:
            pieces.append(
                f"{reference.whitespace}<script>\n"
                f"{textwrap.indent(referenced_contents, reference.whitespace)}\n"
                f"{reference.whitespace}</script>"
            )
        cursor = reference.end
    pieces.append(contents[cursor:])
    return "".join(pieces)


def read_file_references(file_references: Iterable[str]) -> dict[str, str]:
    file_ref_values = dict()
    for file_ref in file_references:
        with Path(file_ref).open(mode="r") as referenced_file:
            file_ref_values[file_ref] = referenced_file.read()

    return file_ref_values


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            f'Inlines <img {INLINE_ATTR} src="..."> and empty '
            f'<script {INLINE_ATTR} src="..."></script> placeholder tags in '
            "CrowdAnki note templates with the contents of the referenced "
            "file, so map/script changes ship as part of the note type "
            "instead of relying on Anki media sync."
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
