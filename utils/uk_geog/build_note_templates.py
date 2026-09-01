"""
A barebones CLI for substituting file contents into CrowdAnki Note Template.
The external file reference syntax is @[path/to/file]. Where the path is
relative to the path that the script is run from (advised to be project root).
"""

import argparse
import re
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass
class Template:
    filepath: Path
    contents: str
    placeholders: dict[str, set[str]]

    FILE_REF_PATTERN = re.compile(r"([\t ]*)@\[(.*)\]")

    @classmethod
    def from_path(cls, path: Path) -> "Template":
        with path.open(mode="r") as template_file:
            template = Template(
                filepath=path,
                contents=template_file.read(),
                placeholders=dict(),
            )

        file_ref_placeholders = cls.FILE_REF_PATTERN.findall(template.contents)

        for whitespace, file_ref in file_ref_placeholders:
            if file_ref not in template.placeholders:
                template.placeholders[file_ref] = {whitespace}
            else:
                template.placeholders[file_ref].add(whitespace)

        return template

    def replace_placeholders(self, placeholder_values: dict[str, str]) -> str:
        """
        replace_placeholders replaces the placeholders in a template's contents
        with the values provided in placeholder_values.

        placeholder_values is dict of placeholder names to placeholder values.
        """

        resolved_contents = self.contents
        for placeholder in self.placeholders:
            # Placeholders with more leading whitespace are replaced first.
            # This is because placeholders with less whitespace are substrings of
            # those with more whitespace. If the template has mixed tabs and spaces
            # there are no guarantees on expected behaviour.
            for whitespace in sorted(self.placeholders[placeholder], reverse=True):
                indented_value = textwrap.indent(placeholder_values[placeholder], whitespace)
                resolved_contents = resolved_contents.replace(
                    f"{whitespace}@[{placeholder}]", indented_value
                )

        return resolved_contents


def read_file_references(file_references: Iterable[str]) -> dict[str, str]:
    file_ref_values = dict()
    for file_ref in file_references:
        file_ref_path = Path(file_ref)
        with file_ref_path.open(mode="r") as referenced_file:
            file_ref_values[file_ref] = referenced_file.read()

    return file_ref_values


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "A barebones CLI for substituting file contents into "
            "CrowdAnki Note Template. The external file reference syntax is "
            "@[path/to/file]. Where the path is relative to current directory "
            "(i.e. the directory that the python script is run from)."
        )
    )
    parser.add_argument(
        "templates",
        type=Path,
        nargs="+",
        help="The paths to the template files which contain external file references.",
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

    templates = [Template.from_path(t_path) for t_path in args.templates]

    file_references: set[str] = set()
    for template in templates:
        file_references |= template.placeholders.keys()

    file_ref_values = read_file_references(file_references)

    for template in templates:
        resolved_contents = template.replace_placeholders(file_ref_values)
        suffix = template.filepath.suffixes[-1]
        out_path = args.out_directory / template.filepath.with_suffix("").with_suffix(suffix).name
        with out_path.open(mode="w") as out_file:
            out_file.write(resolved_contents)
