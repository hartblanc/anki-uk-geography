""" methods associtated with generating the anki-dm data.csv file """

import argparse
import csv
from pathlib import Path
from typing import TypeVar


region_country = {
    "Scotland": "Scotland",
    "Wales": "Wales",
    "Northern Ireland": "NorthernIreland",  # tags are delimited by spaces
    "South East": "England",
    "London": "England",
    "South West": "England",
    "West Midlands": "England",
    "East Midlands": "England",
    "East of England": "England",
    "North West": "England",
    "North East": "England",
    "Yorkshire and the Humber": "England",
}

fieldnames = [
    "location",
    "macrolocation",
    "city",
    "county",
    "region",
    "bow",
    "tags",
]


def key(d):
    return tuple([d.get(k, "") for k in fieldnames])


A = TypeVar("A")


def build_deck_csv(
    uk_regions_path: Path,
    uk_counties_path: Path,
    uk_cities_path: Path,
    bodies_of_water_path: Path,
    city_county_csv_path: Path,
    outfile_path: Path,
    guids: dict,
) -> None:
    rows = []
    # Regions
    with uk_regions_path.open(mode="r") as csvfile:
        region_names = list(csv.reader(csvfile))[1:]  # Skip header row

    for (region_name,) in region_names:
        rows.append(
            {
                "location": region_name,
                "region": region_name,
                "tags": f"Region, {region_country[region_name]}",
            }
        )

    assert set([r for (r,) in region_names]) == set(region_country.keys())

    # Counties
    county_country = dict()
    with uk_counties_path.open(mode="r") as csvfile:
        county_regions = list(csv.reader(csvfile))[1:]  # Skip header row

    for county_name, region_name in county_regions:
        try:
            county_country[county_name] = region_country[region_name]
        except KeyError:
            raise Exception(
                f"Key error, could not find region {region_name} in region_country for county {county_name}"
            )

        rows.append(
            {
                "location": county_name,
                "macrolocation": region_name,
                "county": county_name,
                "tags": f"County, {county_country[county_name]}",
            }
        )

    # Bodies of Water
    with bodies_of_water_path.open(mode="r") as csvfile:
        body_of_water_names = list(csv.reader(csvfile))[1:]  # Skip header row

    for (bow_name,) in body_of_water_names:
        rows.append({"location": bow_name, "bow": bow_name, "tags": "BoW"})

    # Cities
    with city_county_csv_path.open(mode="r") as csvfile:
        city_counties = list(csv.reader(csvfile))[1:]  # Skip header row

    counties_by_city = dict()
    for city_name, county_name in city_counties:
        counties_by_city[city_name] = [c.strip() for c in county_name.split("/")]

    with uk_cities_path.open(mode="r") as csvfile:
        city_names = list(csv.reader(csvfile))[1:]  # Skip header row

    for (city_name,) in city_names:
        counties = counties_by_city[city_name]
        country = county_country[counties[0]]
        rows.append(
            {
                "location": city_name,
                "macrolocation": " / ".join(counties),
                "city": city_name,
                "tags": f"City, {country}",
            }
        )
    assert set([c for (c,) in city_names]) == set(
        counties_by_city.keys()
    ), f"city counties csv mappsing - cities in map: {set(counties_by_city.keys()) - set([c for (c,) in city_names])}, cities in map - city counties csv mapping: {set(counties_by_city.keys()) - set([c for (c,) in city_names])}"

    for row in rows:
        try:
            row["guid"] = guids[key(row)]
        except KeyError:
            print("previously unseen item!: ", key(row))

    assert set([r["guid"] for r in rows if "guid" in r]) == set(guids.values())

    rows.sort(key=lambda r: r.get("guid", ""))

    with outfile_path.open(mode="w") as outfile:
        writer = csv.DictWriter(outfile, fieldnames=["guid"] + fieldnames)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="A utility for extracting data from SVG files into the brain brew CSV format",
    )
    parser.add_argument(
        "uk_regions",
        type=Path,
        help="The path to the CSV file containing all of the regions",
    )
    parser.add_argument(
        "uk_counties",
        type=Path,
        help="The path to the CSV file containing all of the regions and counties",
    )
    parser.add_argument(
        "uk_cities",
        type=Path,
        help="The path to the CSV file containing all of the cities",
    )
    parser.add_argument(
        "bodies_of_water",
        type=Path,
        help="The path to the CSV file containing the bodies of water",
    )
    parser.add_argument(
        "city_county_csv",
        type=Path,
        help=(
            "The path to a CSV file which contains the mapping between cities in the UK and their associated counties"
        ),
    )
    parser.add_argument(
        "outfile",
        type=Path,
        help=(
            "The path to write the output CSV to. This is typically the input CSV for brain brew."
        ),
    )
    parser.add_argument(
        "--guids",
        type=Path,
        help=(
            "The path to the csv that contains the current guids in the guid column."
            "If omitted, the guid column will be left blank and brain brew will generate new ones."
        ),
    )

    curr_guids = []
    args = parser.parse_args()
    with args.guids.open(mode="r") as curr_datafile:
        reader = csv.DictReader(curr_datafile)
        rows = list(reader)
        curr_guids = {key(row): row["guid"] for row in rows}

    build_deck_csv(
        args.uk_regions,
        args.uk_counties,
        args.uk_cities,
        args.bodies_of_water,
        args.city_county_csv,
        args.outfile,
        curr_guids,
    )
