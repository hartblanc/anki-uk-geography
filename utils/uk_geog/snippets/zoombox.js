function setupZoombox(options) {
  var targetEl = document.getElementById(options.targetId);
  var zoombox = document.getElementById("zoombox");
  var mapSvg = document.getElementById(options.mapId);
  if (!targetEl || !zoombox || !mapSvg) {
    return null;
  }

  var bbox = targetEl.getBBox();
  var zsize = options.zsize || 40;

  if (options.zoomNames) {
    // Explicit allowlist: for features that are all the same size (e.g. city
    // markers) but need zooming to tell apart specific pairs that sit almost
    // on top of each other, rather than because any single one is too small
    // to see.
    if (options.zoomNames.indexOf(options.current) === -1) {
      return null;
    }
  } else {
    // Otherwise zoom automatically for any feature small enough that its
    // bounding box comfortably fits inside the zoom window. Bounding-box
    // area (rather than width or height alone) catches both compact tiny
    // features (e.g. City of London) and long, thin ones (e.g. a narrow
    // strait) that are hard to see despite spanning a large width or height.
    // Bigger features are already legible on the main map and would just
    // get cropped by the zoom window.
    var bboxArea = bbox.width * bbox.height;
    if (bboxArea > 0.35 * zsize * zsize) {
      return null;
    }
  }

  zoombox.style.display = "block";

  var centerX = bbox.x + bbox.width / 2;
  var centerY = bbox.y + bbox.height / 2;

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
