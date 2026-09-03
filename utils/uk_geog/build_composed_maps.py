"""Generate composed map SVGs from per-layer SVG building blocks.

The Makefile renders each layer as its own SVG (build/maps/layers/*.min.svg),
all sharing the same viewBox (fit-extent=canvas). This script composes the
layers into the full per-map SVGs that used to live directly in each note type
template (cities.min.svg, counties.min.svg, regions.min.svg,
bodies_of_water.min.svg).

Keeping the maps as static, inlined SVGs means map changes are part of the
note type templates themselves, so they sync to AnkiWeb with the deck instead
of relying on media files being re-synced when they change.

City markers and their white rings are grouped per city at build time. Each
city becomes <g id="city-Name"> containing a .city-marker circle and a
.city-ring circle, so templates can target the whole city (marker + ring) with
a single prefixed id.
"""

import re
from pathlib import Path

# Layer names match both the SVG group ids and the layer file names
# (e.g. the county layer lives in build/maps/layers/county.min.svg).
LAYER_DIR = "build/maps/layers"
LAYER_NAMES = ["extra_land", "county", "city", "region", "bow"]

# Which layers each map is composed of, in paint order (DOM order).
MAP_LAYERS = {
    "cities": ["extra_land", "county", "city"],
    "counties": ["extra_land", "county"],
    "regions": ["extra_land", "region"],
    "bodies_of_water": ["bow"],
}

# Element ids are namespaced by layer so a place name shared between layers
# (e.g. Edinburgh is both a county and a city) never produces duplicate ids in
# a composed map. The prefix is the layer name plus "-" (extra_land is the
# exception and is not prefixed).

# Root <svg> id used for each map (matches the ids in the old full SVGs).
MAP_SVG_IDS = {
    "cities": "map",
    "counties": "map",
    "regions": "regions_map",
    "bodies_of_water": "map",
}

# Output file name for each map.
MAP_OUTPUTS = {
    "cities": "build/maps/cities.min.svg",
    "counties": "build/maps/counties.min.svg",
    "regions": "build/maps/regions.min.svg",
    "bodies_of_water": "build/maps/bodies_of_water.min.svg",
}

# Radius of the white ring drawn around each city marker.
RING_RADIUS = 4


def extract_layer(svg: str, layer_id: str) -> str:
    """Return the <g id=layer_id>...</g> element, including nested <g>s."""
    start_tag = f'<g id="{layer_id}"'
    start = svg.find(start_tag)
    if start == -1:
        raise ValueError(f"layer {layer_id!r} not found")

    tag_end = svg.find(">", start)
    if tag_end == -1:
        raise ValueError(f"layer {layer_id!r} has no closing '>' on its open tag")

    depth = 1
    pos = tag_end + 1
    while depth > 0:
        next_open = svg.find("<g", pos)
        next_close = svg.find("</g>", pos)
        if next_close == -1:
            raise ValueError(f"layer {layer_id!r} has unbalanced <g> tags")
        if next_open != -1 and next_open < next_close:
            depth += 1
            close_of_open = svg.find(">", next_open)
            if close_of_open == -1:
                raise ValueError(f"layer {layer_id!r} has a malformed <g> tag")
            pos = close_of_open + 1
        else:
            depth -= 1
            pos = next_close + len("</g>")
    return svg[start:pos]


def extract_root_attrs(svg: str) -> str:
    match = re.search(r"<svg\b([^>]*)>", svg)
    if not match:
        raise ValueError("root <svg> tag not found")
    # Remove the id; compose_map sets the per-map id on the composed root.
    return re.sub(r'\sid="[^"]*"', "", match.group(1)).strip()


def group_city_markers(layer: str) -> str:
    """Rewrite the city layer so each city is a group with marker + ring.

    The Makefile emits <circle id="city-Name" .../> markers. This turns each
    into <g id="city-Name" class="city"><circle class="city-marker" .../><circle
    class="city-ring" .../></g>, keeping the id on the group (unique per city)
    and giving templates a stable handle for both marker and ring.
    """

    def replace_circle(match: "re.Match[str]") -> str:
        circle = match.group(0)
        id_match = re.search(r'\bid="([^"]+)"', circle)
        cx_match = re.search(r'\bcx="([^"]+)"', circle)
        cy_match = re.search(r'\bcy="([^"]+)"', circle)
        r_match = re.search(r'\br="([^"]+)"', circle)
        if not (id_match and cx_match and cy_match and r_match):
            return circle

        marker = re.sub(r'\bid="[^"]*"\s?', "", circle)
        marker = marker.replace("<circle", '<circle class="city-marker"', 1)
        ring = (
            f'<circle class="city-ring" cx="{cx_match.group(1)}" '
            f'cy="{cy_match.group(1)}" r="{RING_RADIUS}" fill="none" stroke="#fff"/>'
        )
        return f'<g id="{id_match.group(1)}" class="city">{marker}{ring}</g>'

    return re.sub(r"<circle\b[^>]*/>", replace_circle, layer)


def validate_unique_ids(layers: dict) -> None:
    """Fail the build if a composed map would contain duplicate element ids.

    Layer ids are namespaced (county-, city-, region-, bow-), but this is a
    guard against regressions: duplicate ids in the DOM make getElementById
    and CSS id selectors silently target the wrong element.
    """
    for map_name, layer_names in MAP_LAYERS.items():
        ids = []
        for layer_name in layer_names:
            layer_ids = re.findall(r'\bid="([^"]+)"', layers[layer_name])
            # The first id in each extracted group is the group's own id
            # (e.g. id="county"); the rest are feature ids.
            group_id = layer_ids[0] if layer_ids else None
            expected_prefix = "" if layer_name == "extra_land" else layer_name + "-"
            for id_ in layer_ids:
                if id_ == group_id or not expected_prefix:
                    continue
                if not id_.startswith(expected_prefix):
                    raise ValueError(
                        f"unexpected id {id_!r} in layer {layer_name!r}: "
                        f"expected prefix {expected_prefix!r}"
                    )
            ids.extend(layer_ids)
        counts = {}
        for id_ in ids:
            counts[id_] = counts.get(id_, 0) + 1
        duplicates = sorted(id_ for id_, count in counts.items() if count > 1)
        if duplicates:
            raise ValueError(
                f"duplicate ids in composed map {map_name!r}: {duplicates!r}"
            )


def compose_map(layers: dict, root_attrs: str, map_name: str) -> str:
    layer_names = MAP_LAYERS[map_name]
    inner = "".join(layers[name] for name in layer_names)
    svg_id = MAP_SVG_IDS[map_name]
    id_attr = f' id="{svg_id}"' if svg_id else ""
    return f"<svg {root_attrs}{id_attr}>{inner}</svg>"


def main() -> None:
    layers = {}
    root_attrs = None
    for layer_id in LAYER_NAMES:
        svg = Path(LAYER_DIR, f"{layer_id}.min.svg").read_text()
        layer = extract_layer(svg, layer_id)
        if layer_id == "city":
            layer = group_city_markers(layer)
        layers[layer_id] = layer
        if root_attrs is None:
            root_attrs = extract_root_attrs(svg)

    validate_unique_ids(layers)

    for map_name, output in MAP_OUTPUTS.items():
        output_path = Path(output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(compose_map(layers, root_attrs, map_name))
        print(f"wrote {output_path}")


if __name__ == "__main__":
    main()
