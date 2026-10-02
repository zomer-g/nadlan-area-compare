// The גוש/חלקה layer: parcel outlines from OVER, fetched for the viewport.
// Statutory parcels first; a tax-assessment parcel (חלקת שומה) is drawn only
// when its gush+parcel number is absent from the statutory layer, dashed, and
// labelled as shuma — it is less precise.
//
// OVER allows 30 feature requests a minute, so the layer fetches a padded box
// once and does not refetch while the view stays inside it.

import { parcelFeatures, shumaParcelFeatures } from './over.js?v=e0710ebd20';
import { esc } from './util.js?v=e0710ebd20';

const MIN_ZOOM = 16;
const LABEL_ZOOM = 18;

// opts.picking() → true while the user picks parcels; opts.onPick(name, geometry).
export function createParcelLayer(map, onStatus, opts = {}) {
  const renderer = L.canvas({ padding: 0.3 });
  const polygons = L.geoJSON(null, {
    renderer,
    style: (f) => (f.properties._shuma
      ? { color: '#7c3aed', weight: 1, dashArray: '4 3', fill: true, fillOpacity: 0.02, opacity: 0.9 }
      : { color: '#b45309', weight: 1, fill: true, fillOpacity: 0.02, opacity: 0.8 }),
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const suffix = Number(p.GUSH_SUFFI) ? ` (תת-גוש ${p.GUSH_SUFFI})` : '';
      layer.bindTooltip(p._shuma
        ? `חלקת שומה — לא סטטוטורית<br>גוש ${esc(p.GUSH_NUM)}${esc(suffix)} · חלקה ${esc(p.PARCEL)} · ${Math.round(Number(p.LEGAL_AREA) || 0)} מ"ר`
        : `גוש ${esc(p.GUSH_NUM)}${esc(suffix)} · חלקה ${esc(p.PARCEL)}<br>${esc(p.LOCALITY_N)} · ${Math.round(Number(p.LEGAL_AREA) || 0)} מ"ר רשום`,
      { sticky: true, direction: 'top' });
      layer.on('mouseover', () => { if (opts.picking?.()) layer.setStyle({ fillOpacity: 0.35, weight: 2 }); });
      layer.on('mouseout', () => layer.setStyle({ fillOpacity: 0.02, weight: 1 }));
      layer.on('click', (e) => {
        if (!opts.picking?.()) return;
        L.DomEvent.stop(e);
        const sub = Number(p.GUSH_SUFFI) ? `/${Number(p.GUSH_SUFFI)}` : '';
        opts.onPick?.(`גוש ${p.GUSH_NUM}${sub} חלקה ${p.PARCEL}${p._shuma ? ' (שומה)' : ''}`, f.geometry, Boolean(p._shuma));
      });
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
      const bb = [box.getWest(), box.getSouth(), box.getEast(), box.getNorth()].map((v) => v.toFixed(6));
      const [fc, sh] = await Promise.all([
        parcelFeatures(bb, controller.signal),
        // The shuma layer is a fallback: if it fails, the statutory one still shows.
        shumaParcelFeatures(bb, controller.signal).catch((e) => { if (e.name === 'AbortError') throw e; return { features: [] }; }),
      ]);
      if (!enabled || map.getZoom() < MIN_ZOOM) return;
      const statutory = new Set(fc.features.map((f) => `${f.properties.GUSH_NUM}-${f.properties.PARCEL}`));
      const shuma = sh.features.filter((f) => !statutory.has(`${f.properties.GUSH_NUM}-${f.properties.PARCEL}`));
      for (const f of shuma) f.properties._shuma = true;
      features = [...fc.features, ...shuma];
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
      onStatus(`${fc.features.length.toLocaleString('he-IL')} חלקות${shuma.length ? ` + ${shuma.length.toLocaleString('he-IL')} חלקות שומה (מקווקו)` : ''}${fc.exceededTransferLimit ? ' (חלקי — התקרבו)' : ''}`);
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
