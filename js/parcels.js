// The גוש/חלקה layer: parcel outlines from OVER, fetched for the viewport.
//
// OVER allows 30 feature requests a minute, so the layer fetches a padded box
// once and does not refetch while the view stays inside it.

import { parcelFeatures } from './over.js?v=5dbd4d41de';
import { esc } from './util.js?v=5dbd4d41de';

const MIN_ZOOM = 16;
const LABEL_ZOOM = 18;

export function createParcelLayer(map, onStatus) {
  const renderer = L.canvas({ padding: 0.3 });
  const polygons = L.geoJSON(null, {
    renderer,
    style: () => ({ color: '#b45309', weight: 1, fill: true, fillOpacity: 0.02, opacity: 0.8 }),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const suffix = Number(p.GUSH_SUFFI) ? ` (תת-גוש ${p.GUSH_SUFFI})` : '';
      layer.bindTooltip(
        `גוש ${esc(p.GUSH_NUM)}${esc(suffix)} · חלקה ${esc(p.PARCEL)}<br>${esc(p.LOCALITY_N)} · ${Math.round(Number(p.LEGAL_AREA) || 0)} מ"ר רשום`,
        { sticky: true, direction: 'top' },
      );
    },
  });
  const labels = L.layerGroup();
  const group = L.layerGroup([polygons, labels]);

  let loadedBox = null; // L.LatLngBounds already covered
  let controller = null;
  let timer = null;
  let enabled = true;
  let features = [];

  function drawLabels() {
    labels.clearLayers();
    const z = map.getZoom();
    if (z < MIN_ZOOM) return;
    const view = map.getBounds();
    if (z >= LABEL_ZOOM) {
      for (const f of features) {
        const c = f._c;
        if (!view.contains(c)) continue;
        labels.addLayer(L.marker(c, {
          interactive: false,
          icon: L.divIcon({ className: 'parcel-label', html: esc(f.properties.PARCEL), iconSize: null }),
        }));
      }
      return;
    }
    // Below LABEL_ZOOM: one label per gush, at the mean of its parcels' centres.
    const byGush = new Map();
    for (const f of features) {
      if (!view.contains(f._c)) continue;
      const k = f.properties.GUSH_NUM;
      const g = byGush.get(k) || { lat: 0, lng: 0, n: 0 };
      g.lat += f._c.lat; g.lng += f._c.lng; g.n += 1;
      byGush.set(k, g);
    }
    for (const [gush, g] of byGush) {
      labels.addLayer(L.marker([g.lat / g.n, g.lng / g.n], {
        interactive: false,
        icon: L.divIcon({ className: 'gush-label', html: `גוש ${esc(gush)}`, iconSize: null }),
      }));
    }
  }

  async function load() {
    if (!enabled) return;
    const z = map.getZoom();
    if (z < MIN_ZOOM) {
      onStatus(`שכבת גוש/חלקה מוצגת מזום ${MIN_ZOOM} ומעלה`);
      controller?.abort();
      labels.clearLayers();
      group.removeLayer(polygons);
      return;
    }
    if (!group.hasLayer(polygons)) group.addLayer(polygons);
    const view = map.getBounds();
    if (loadedBox && loadedBox.contains(view)) {
      drawLabels();
      return;
    }
    const box = view.pad(0.4);
    controller?.abort();
    controller = new AbortController();
    onStatus('טוען חלקות…');
    try {
      const fc = await parcelFeatures(
        [box.getWest(), box.getSouth(), box.getEast(), box.getNorth()].map((v) => v.toFixed(6)),
        controller.signal,
      );
      if (!enabled || map.getZoom() < MIN_ZOOM) return;
      features = fc.features;
      for (const f of features) {
        const c = turf.centroid(f).geometry.coordinates;
        f._c = L.latLng(c[1], c[0]);
      }
      polygons.clearLayers();
      polygons.addData(features);
      // A truncated answer does not cover the whole box, so do not trust it
      // to answer the next pan either.
      loadedBox = fc.exceededTransferLimit ? null : box;
      drawLabels();
      onStatus(`${features.length.toLocaleString('he-IL')} חלקות${fc.exceededTransferLimit ? ' (חלקי — התקרבו)' : ''}`);
    } catch (e) {
      if (e.name === 'AbortError') return;
      onStatus('שגיאה בטעינת חלקות: ' + e.message);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(load, 500);
  }

  map.on('moveend', schedule);
  group.addTo(map);
  schedule();

  return {
    layer: group,
    setEnabled(on) {
      enabled = on;
      if (on) {
        group.addTo(map);
        schedule();
      } else {
        controller?.abort();
        map.removeLayer(group);
        onStatus('שכבת גוש/חלקה כבויה');
      }
    },
  };
}
