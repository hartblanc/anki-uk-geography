function setupZoombox(options) {
  var zoomNames = options.zoomNames;
  var current = options.current;
  if (zoomNames.indexOf(current) === -1) {
    return null;
  }

  // targetSelector lets callers disambiguate duplicate ids (e.g. "City of
  // London" is both a county path and a city circle). When provided it takes
  // precedence over targetId.
  var targetEl = options.targetSelector
    ? document.querySelector(options.targetSelector)
    : document.getElementById(options.targetId);
  var zoombox = document.getElementById("zoombox");
  var mapSvg = document.getElementById(options.mapId);
  if (!targetEl || !zoombox || !mapSvg) {
    return null;
  }

  zoombox.style.display = "block";

  var bbox = targetEl.getBBox();
  var centerX = bbox.x + bbox.width / 2;
  var centerY = bbox.y + bbox.height / 2;
  var zsize = options.zsize || 40;

  // Zoom to the target first so the zoomed viewBox is in place before callers
  // read the screen scale (getScreenCTM).
  zoombox.setAttribute(
    "viewBox",
    centerX -
      zsize / 2 +
      " " +
      (centerY - zsize / 2) +
      " " +
      zsize +
      " " +
      zsize
  );

  // Build the zoombox from a copy of the main map's contents. CSS can't style
  // <use> clones (and they're static), so we copy the map into the regular DOM
  // and adjust/draw things there.
  var zoomMap = document.createElementNS("http://www.w3.org/2000/svg", "g");
  zoomMap.id = "zoombox-map";
  var mapChildren = mapSvg.children;
  for (var i = 0; i < mapChildren.length; i++) {
    zoomMap.appendChild(mapChildren[i].cloneNode(true));
  }

  // Draw the red zoom-region outline around the zoombox too, matching the
  // indicator shown on the main map.
  var zoomIndicator = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "rect"
  );
  zoomIndicator.setAttribute("class", "zoom-indicator");
  zoomIndicator.setAttribute("x", centerX - zsize / 2);
  zoomIndicator.setAttribute("y", centerY - zsize / 2);
  zoomIndicator.setAttribute("width", String(zsize));
  zoomIndicator.setAttribute("height", String(zsize));
  zoomMap.appendChild(zoomIndicator);

  while (zoombox.firstChild) {
    zoombox.removeChild(zoombox.firstChild);
  }
  zoombox.appendChild(zoomMap);

  var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("class", "zoom-indicator");
  rect.setAttribute("x", centerX - zsize / 2);
  rect.setAttribute("y", centerY - zsize / 2);
  rect.setAttribute("width", String(zsize));
  rect.setAttribute("height", String(zsize));
  mapSvg.appendChild(rect);

  // The zoombox magnifies the map, so every SVG stroke (county borders,
  // coast outlines, ring circles) would otherwise appear thicker than on the
  // main map. Scale stroke widths by the ratio of the screen scales so they
  // keep the same on-screen thickness. The red .zoom-indicator rectangles are
  // UI overlays and should keep their normal stroke width.
  var mainScale = mapSvg.getScreenCTM().a;
  var zoomScale = zoombox.getScreenCTM().a;
  var strokeScale = mainScale / zoomScale;
  zoomMap
    .querySelectorAll("path, circle, rect, line, polyline, polygon")
    .forEach(function (el) {
      if (el.getAttribute("class") === "zoom-indicator") {
        return;
      }
      var strokeWidth = parseFloat(el.getAttribute("stroke-width"));
      if (isNaN(strokeWidth)) {
        strokeWidth = 1;
      }
      el.setAttribute("stroke-width", String(strokeWidth * strokeScale));
    });

  // Return the clone so callers can apply any card-type-specific adjustments
  // (e.g. city marker sizing) after the generic zoombox is set up.
  return zoomMap;
}
