"""Generate the _maps.js media file from per-layer SVG building blocks.

The Makefile renders each layer as its own SVG (build/maps/layers/*.min.svg),
all sharing the same viewBox (fit-extent=canvas). _maps.js stores each layer
once and injectMap() composes the full SVG for a map from its layers at render
time, so shared geometry (counties, extra_land) is not duplicated.

City ring markers are also generated at render time from the city circles,
so the ring_cities layer doesn't need to be stored as geometry at all.
"""

import json
import re
from pathlib import Path

LAYER_FILES = {
    "extra_land": "build/maps/layers/extra_land.min.svg",
    "counties": "build/maps/layers/counties.min.svg",
    "cities": "build/maps/layers/cities.min.svg",
    "regions": "build/maps/layers/regions.min.svg",
    "water": "build/maps/layers/water.min.svg",
    "motorways": "build/maps/layers/motorways.min.svg",
}

# Which layers each map is composed of, in paint order (DOM order).
MAP_LAYERS = {
    "cities": ["extra_land", "counties", "cities"],
    "counties": ["extra_land", "counties"],
    "regions": ["extra_land", "regions"],
    "bodies_of_water": ["water"],
    "motorways": ["extra_land", "counties", "motorways"],
}

# Root <svg> id used for each map (matches the ids in the old full SVGs).
MAP_SVG_IDS = {
    "cities": "map",
    "counties": "map",
    "regions": "regions_map",
    "bodies_of_water": None,
    "motorways": "map",
}

OUTPUT = "build/media/_maps.js"


def extract_layer(svg: str, layer_id: str) -> str:
    match = re.search(
        r'<g id="' + re.escape(layer_id) + r'"[^>]*>.*?</g>', svg, re.S
    )
    if not match:
        raise ValueError(f"layer {layer_id!r} not found")
    return match.group(0)


def extract_root_attrs(svg: str) -> str:
    match = re.search(r"<svg\b([^>]*)>", svg)
    if not match:
        raise ValueError("root <svg> tag not found")
    # Remove the id; injectMap sets the per-map id on the composed root.
    return re.sub(r'\sid="[^"]*"', "", match.group(1)).strip()


def main() -> None:
    layers = {}
    root_attrs = None
    for layer_id, path in LAYER_FILES.items():
        svg = Path(path).read_text()
        layers[layer_id] = extract_layer(svg, layer_id)
        if root_attrs is None:
            root_attrs = extract_root_attrs(svg)

    js = (
        "var MAPS = "
        + json.dumps(layers)
        + ";\n\n"
        + "var MAP_LAYERS = "
        + json.dumps(MAP_LAYERS)
        + ";\n\n"
        + "var MAP_SVG_IDS = "
        + json.dumps(MAP_SVG_IDS)
        + ";\n\n"
        + "var SVG_ROOT_ATTRS = "
        + json.dumps(root_attrs)
        + ";\n\n"
        + "var RING_RADIUS = 4;\n\n"
        + "function addRingCities(svg) {\n"
        + "  var citiesGroup = svg.querySelector('[id=\"cities\"]');\n"
        + "  if (!citiesGroup) {\n"
        + "    return;\n"
        + "  }\n"
        + "  var ringGroup = document.createElementNS(\n"
        + "    \"http://www.w3.org/2000/svg\",\n"
        + "    \"g\"\n"
        + "  );\n"
        + "  ringGroup.id = \"ring_cities\";\n"
        + "  ringGroup.setAttribute(\"fill-opacity\", \"0\");\n"
        + "  ringGroup.setAttribute(\"stroke\", \"#fff\");\n"
        + "  var cityCircles = citiesGroup.querySelectorAll(\"circle\");\n"
        + "  for (var i = 0; i < cityCircles.length; i++) {\n"
        + "    var city = cityCircles[i];\n"
        + "    var ring = document.createElementNS(\n"
        + "      \"http://www.w3.org/2000/svg\",\n"
        + "      \"circle\"\n"
        + "    );\n"
        + "    ring.setAttribute(\"data-city\", city.getAttribute(\"id\"));\n"
        + "    ring.setAttribute(\"cx\", city.getAttribute(\"cx\"));\n"
        + "    ring.setAttribute(\"cy\", city.getAttribute(\"cy\"));\n"
        + "    ring.setAttribute(\"r\", RING_RADIUS);\n"
        + "    ringGroup.appendChild(ring);\n"
        + "  }\n"
        + "  svg.appendChild(ringGroup);\n"
        + "}\n\n"
        + "function injectMap(containerId, mapName) {\n"
        + "  var container = document.getElementById(containerId);\n"
        + "  if (!container) {\n"
        + "    return;\n"
        + "  }\n"
        + "  var layerNames = MAP_LAYERS[mapName];\n"
        + "  var layers = \"\";\n"
        + "  for (var i = 0; i < layerNames.length; i++) {\n"
        + "    layers += MAPS[layerNames[i]];\n"
        + "  }\n"
        + "  var idAttr = MAP_SVG_IDS[mapName]\n"
        + "    ? ' id=\"' + MAP_SVG_IDS[mapName] + '\"'\n"
        + "    : \"\";\n"
        + "  container.innerHTML =\n"
        + "    '<svg ' + SVG_ROOT_ATTRS + idAttr + '>' + layers + '</svg>';\n"
        + "  if (mapName === \"cities\") {\n"
        + "    addRingCities(container.querySelector(\"svg\"));\n"
        + "  }\n"
        + "}\n"
    )
    output = Path(OUTPUT)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(js)


if __name__ == "__main__":
    main()
