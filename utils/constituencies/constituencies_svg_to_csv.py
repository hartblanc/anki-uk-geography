"""methods associtated with generating the anki-dm data.csv file"""

import csv
import json
from pathlib import Path
from typing import Iterator, Optional, Sequence, TypeVar

from lxml import etree

CONSTITUENCY_MAP = Path("uk_constituencies.svg")
with open("county_country.json") as f:
    county_country = json.load(f)

A = TypeVar("A")


def pad_none(items: Sequence[A]) -> Iterator[Optional[A]]:
    """A generator which pads the end of a sequence with Nones"""

    count = 0
    while True:
        if items:
            yield items[count]
            count += 1
        else:
            yield None


def build_deck_csv(anki_dm_src_path: Path, guids: Optional[Sequence[str]] = None) -> None:
    """
    constructs the data.csv file for anki-dm which is ultimately used to
    generate the crowdanki json. Optionally retains old guids to ensure that
    Anki does not lose track of progress.

    :param anki_dm_src_path: The path to the anki-dm src folder, which is used
                             by the anki-dm build command to generate the crowdanki
                             json.
    :param guids: A sequence of the globally unique IDs to use for each card, if
                  not included, guids can be set automatically by calling
                  anki-dm reindex
                  later, which will generate a new set of random guids.
    """

    with (anki_dm_src_path / "data.csv").open(mode="w") as outfile:
        fieldnames = [
            "guid",
            "Constituency",
            "Counties",
            "tags",
        ]
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()

        padded_guids = pad_none(guids) if guids else pad_none([])

        with CONSTITUENCY_MAP.open(mode="rb") as svg_file:
            svg_string = svg_file.read()

        svg_root = etree.fromstring(svg_string)

        constituency_elems = list(svg_root.xpath('//*[@id="Constituencies"]/*'))

        for constituency_elem in constituency_elems:
            constituency_name = constituency_elem.attrib["id"]
            counties = list(
                map(lambda x: x.replace("_", " "), constituency_elem.attrib["class"].split(" "))
            )
            countries = set(county_country[county].replace(" ", "") for county in counties)

            writer.writerow(
                {
                    "guid": next(padded_guids),
                    "Constituency": constituency_name,
                    "Counties": "; ".join(counties),
                    "tags": " ".join(countries),
                }
            )


if __name__ == "__main__":
    SRC_FOLDER = Path("anki_dm", "src")

    # with (SRC_FOLDER / "data.csv").open(mode="r") as curr_datafile:
    #     reader = csv.DictReader(curr_datafile)
    #     curr_guids = [row["guid"] for row in reader]

    # build_deck_csv(SRC_FOLDER, curr_guids)
    build_deck_csv(SRC_FOLDER)
