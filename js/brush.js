// The brush: paint an area on the map with a stroke of a chosen width (in
// metres on the ground, so a stroke covers the same street at any zoom).
//
// A stroke becomes a polygon by buffering its path by half the width; the
// caller merges it into (or, erasing, cuts it out of) the active area.

export function metersPerPixel(map, lat) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom() + 8);
}

export function strokeToPolygon(latlngs, widthM) {
  const coords = latlngs.map((ll) => [ll.lng, ll.lat]);
  const shape = coords.length < 2 ? turf.point(coords[0]) : turf.lineString(coords);
  return turf.buffer(shape, widthM / 2, { units: 'meters', steps: 8 });
}

export function createBrush(map, { getWidth, getColor, onStroke }) {
  const el = map.getContainer();
  let mode = 'pan';
  let path = null; // latlngs of the stroke in progress
  let pointerId = null; // the one pointer drawing it; a second finger is ignored
  let strokeMode = null; // mode at pointerdown — a key press mid-stroke must not flip it
  let lastPt = null;
  let preview = null;
  let cursor = null;

  function weightPx(lat) {
    return Math.max(2, getWidth() / metersPerPixel(map, lat));
  }

  function showCursor(latlng) {
    const r = getWidth() / 2;
    if (!cursor) {
      cursor = L.circle(latlng, { radius: r, interactive: false, weight: 1, dashArray: '3 3', fillOpacity: 0.08 }).addTo(map);
    }
    cursor.setLatLng(latlng).setRadius(r);
    cursor.setStyle({ color: mode === 'erase' ? '#dc2626' : getColor() });
  }

  function hideCursor() {
    cursor?.remove();
    cursor = null;
  }

  function onDown(e) {
    if (mode === 'pan' || e.button !== 0 || path) return;
    // Zoom buttons, layer switcher, attribution links keep working while painting.
    if (e.target.closest('.leaflet-control')) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const ll = map.mouseEventToLatLng(e);
    path = [ll];
    pointerId = e.pointerId;
    strokeMode = mode;
    lastPt = map.mouseEventToContainerPoint(e);
    preview = L.polyline(path, {
      interactive: false,
      color: strokeMode === 'erase' ? '#dc2626' : getColor(),
      opacity: 0.45,
      weight: weightPx(ll.lat),
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
  }

  function onMove(e) {
    if (mode === 'pan' && !path) return;
    const ll = map.mouseEventToLatLng(e);
    if (mode !== 'pan') showCursor(ll);
    if (!path || e.pointerId !== pointerId) return;
    const pt = map.mouseEventToContainerPoint(e);
    if (pt.distanceTo(lastPt) < 4) return; // decimate: one vertex per ~4px
    lastPt = pt;
    path.push(ll);
    preview.addLatLng(ll);
  }

  function onUp(e) {
    if (!path || e.pointerId !== pointerId) return;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const stroke = path;
    path = null;
    preview.remove();
    preview = null;
    pointerId = null;
    onStroke(strokeToPolygon(stroke, getWidth()), strokeMode);
  }

  // Capture phase, so Leaflet's own drag handling never sees a paint stroke.
  el.addEventListener('pointerdown', onDown, true);
  el.addEventListener('pointermove', onMove, true);
  el.addEventListener('pointerup', onUp, true);
  el.addEventListener('pointercancel', onUp, true);
  el.addEventListener('pointerleave', () => { if (!path) hideCursor(); });

  return {
    get mode() {
      return mode;
    },
    setMode(m) {
      mode = m;
      const painting = m !== 'pan';
      if (painting) {
        map.dragging.disable();
        map.doubleClickZoom.disable();
      } else {
        map.dragging.enable();
        map.doubleClickZoom.enable();
        hideCursor();
      }
      el.classList.toggle('painting', painting);
    },
  };
}
