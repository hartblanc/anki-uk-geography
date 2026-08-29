"""Generate the maps.js media file from the minified map SVGs.

maps.js stores each map SVG exactly once as a JavaScript string. Templates
inject the relevant SVG into the DOM at render time (via injectMap()), which
keeps the SVG accessible to the existing CSS/JS (highlighting, zoombox,
move-to-front) while avoiding duplicating the SVG in every note type template.
"""

import json
from pathlib import Path

MAPS = {
    "cities": "build/maps/cities.min.svg",
    "counties": "build/maps/counties.min.svg",
    "regions": "build/maps/regions.min.svg",
    "bodies_of_water": "build/maps/bodies_of_water.min.svg",
}

OUTPUT = "build/maps.js"


def main() -> None:
    data = {name: Path(path).read_text() for name, path in MAPS.items()}
    js = (
        "var MAPS = "
        + json.dumps(data)
        + ";\n\n"
        + "function injectMap(containerId, mapName) {\n"
        + "  var container = document.getElementById(containerId);\n"
        + "  if (container) {\n"
        + "    container.innerHTML = MAPS[mapName];\n"
        + "  }\n"
        + "}\n"
    )
    Path(OUTPUT).write_text(js)


if __name__ == "__main__":
    main()
