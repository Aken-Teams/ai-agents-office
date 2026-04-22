'use client';

import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from '../../../i18n/index';
import type { MapData, MapMarker } from './mapTypes';
import { validateMapData } from './mapTypes';

function isIncompleteJson(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  return (t[0] === '{' || t[0] === '[') && !t.endsWith('}') && !t.endsWith(']');
}

interface ChatMapProps {
  rawJson: string;
}

export default function ChatMap({ rawJson }: ChatMapProps) {
  const { t } = useTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [routeCoords, setRouteCoords] = useState<[number, number][] | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [leafletReady, setLeafletReady] = useState(false);
  const leafletRef = useRef<any>(null);
  const rlRef = useRef<any>(null);

  // Inject Leaflet CSS
  useEffect(() => {
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
  }, []);

  // Dynamic import leaflet + react-leaflet (SSR-safe)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const L = await import('leaflet');
      const rl = await import('react-leaflet');
      // Fix default marker icons (webpack/Next.js known issue)
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });
      if (!cancelled) {
        leafletRef.current = L;
        rlRef.current = rl;
        setLeafletReady(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Parse JSON
  const parsed = useMemo<{ data: MapData | null; error: string | null }>(() => {
    try {
      const obj = JSON.parse(rawJson);
      const err = validateMapData(obj);
      if (err) return { data: null, error: err };
      return { data: obj as MapData, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [rawJson]);

  // Fetch OSRM route
  useEffect(() => {
    if (!parsed.data?.route) return;
    const { from, to } = parsed.data.route;
    setRouteLoading(true);
    setRouteError(null);

    // Build waypoints string: lng,lat;lng,lat
    let coords = `${from[1]},${from[0]};`;
    if (parsed.data.route.waypoints) {
      for (const wp of parsed.data.route.waypoints) {
        coords += `${wp[1]},${wp[0]};`;
      }
    }
    coords += `${to[1]},${to[0]}`;

    fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`)
      .then(r => r.json())
      .then(data => {
        if (data.routes?.[0]?.geometry?.coordinates) {
          // OSRM returns [lng, lat], Leaflet needs [lat, lng]
          const pts = data.routes[0].geometry.coordinates.map(
            (c: [number, number]) => [c[1], c[0]] as [number, number]
          );
          setRouteCoords(pts);
        } else {
          setRouteError('No route found');
        }
      })
      .catch(e => setRouteError(e.message))
      .finally(() => setRouteLoading(false));
  }, [parsed.data?.route]);

  const getGoogleMapsMarkerUrl = (marker: MapMarker) =>
    `https://www.google.com/maps/search/?api=1&query=${marker.lat},${marker.lng}`;

  const getGoogleMapsRouteUrl = (route: MapData['route']) => {
    if (!route) return '';
    return `https://www.google.com/maps/dir/${route.from[0]},${route.from[1]}/${route.to[0]},${route.to[1]}`;
  };

  const handleDownloadHtml = useCallback(() => {
    if (!parsed.data) return;
    const mapData = parsed.data;
    const json = JSON.stringify(mapData);
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${(mapData.title || 'Map').replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>body{margin:0;font-family:system-ui,sans-serif}#map{width:100vw;height:100vh}
.disclaimer{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:1000;
background:rgba(255,235,59,0.9);color:#333;padding:6px 16px;border-radius:20px;font-size:12px;
box-shadow:0 2px 6px rgba(0,0,0,0.2)}</style>
</head><body>
<div class="disclaimer">⚠ AI-generated coordinates — verify on Google Maps</div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script>
var d=${json};
var map=L.map('map').setView(d.center,d.zoom);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
  attribution:'&copy; OpenStreetMap'
}).addTo(map);
d.markers.forEach(function(m){
  L.marker([m.lat,m.lng]).addTo(map)
    .bindPopup('<b>'+m.label+'</b>'+(m.description?'<br>'+m.description:'')
    +'<br><a href="https://www.google.com/maps/search/?api=1&query='+m.lat+','+m.lng
    +'" target="_blank">Open in Google Maps ↗</a>');
});
${mapData.route ? `
fetch('https://router.project-osrm.org/route/v1/driving/'+d.route.from[1]+','+d.route.from[0]+';'+d.route.to[1]+','+d.route.to[0]+'?overview=full&geometries=geojson')
.then(function(r){return r.json()}).then(function(data){
  if(data.routes&&data.routes[0]){
    var coords=data.routes[0].geometry.coordinates.map(function(c){return[c[1],c[0]]});
    L.polyline(coords,{color:'#1565c0',weight:4}).addTo(map);
  }
});` : ''}
<\/script></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${mapData.title || 'map'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [parsed.data]);

  // --- Render states ---

  // Streaming: incomplete JSON
  if (parsed.error && isIncompleteJson(rawJson)) {
    return (
      <div className="chat-chart-container">
        <div className="chat-chart-body flex items-center justify-center" style={{ minHeight: 120 }}>
          <span className="text-sm opacity-50 animate-pulse">{t('map.status.rendering' as any)}</span>
        </div>
      </div>
    );
  }

  // Parse error
  if (parsed.error || !parsed.data) {
    return (
      <div className="chat-chart-fallback">
        <div className="chat-chart-fallback-header">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>warning</span>
          <span>{t('map.error.map' as any)}{parsed.error ? `: ${parsed.error}` : ''}</span>
        </div>
        <pre><code>{rawJson}</code></pre>
      </div>
    );
  }

  // Leaflet not loaded yet
  if (!leafletReady) {
    return (
      <div className="chat-chart-container">
        <div className="chat-chart-body flex items-center justify-center" style={{ minHeight: 120 }}>
          <span className="text-sm opacity-50 animate-pulse">{t('map.status.loading' as any)}</span>
        </div>
      </div>
    );
  }

  const mapData = parsed.data;
  const { MapContainer, TileLayer, Marker, Popup, Polyline } = rlRef.current;
  const isDark = document.documentElement.classList.contains('dark');
  const tileUrl = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const tileAttribution = isDark
    ? '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
    : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  const renderMap = (height: number, keyPrefix: string) => (
    <MapContainer
      key={`${keyPrefix}-${isDark}`}
      center={mapData.center}
      zoom={mapData.zoom}
      style={{ height, width: '100%' }}
      scrollWheelZoom={true}
    >
      <TileLayer url={tileUrl} attribution={tileAttribution} />
      {mapData.markers.map((marker: MapMarker, i: number) => (
        <Marker key={i} position={[marker.lat, marker.lng]}>
          <Popup>
            <div style={{ minWidth: 150 }}>
              <strong>{marker.label}</strong>
              {marker.description && <p style={{ margin: '4px 0 8px', fontSize: 12 }}>{marker.description}</p>}
              <a
                href={getGoogleMapsMarkerUrl(marker)}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
              >
                {t('map.action.openGoogleMaps' as any)} ↗
              </a>
            </div>
          </Popup>
        </Marker>
      ))}
      {routeCoords && (
        <Polyline positions={routeCoords} color={isDark ? '#64b5f6' : '#1565c0'} weight={4} opacity={0.8} />
      )}
    </MapContainer>
  );

  return (
    <>
      <div className="chat-chart-container group">
        {mapData.title && <div className="chat-chart-title">{mapData.title}</div>}

        {/* AI Disclaimer Banner */}
        <div className="chat-map-disclaimer">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>
          <span>{t('map.disclaimer' as any)}</span>
        </div>

        <div className="chat-map-body">
          {renderMap(320, 'inline')}
          {routeLoading && (
            <div className="chat-map-route-loading">
              <span className="animate-pulse text-xs opacity-60">{t('map.status.loadingRoute' as any)}</span>
            </div>
          )}
        </div>

        {/* Route info + Google Maps link */}
        {mapData.route && (
          <div className="chat-map-route-info">
            <span className="text-xs">{mapData.route.label || t('map.route.label' as any)}</span>
            <a href={getGoogleMapsRouteUrl(mapData.route)} target="_blank" rel="noopener noreferrer" className="chat-map-gmaps-link">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
              {t('map.action.openRouteGoogleMaps' as any)}
            </a>
          </div>
        )}
        {routeError && (
          <div className="chat-map-route-info" style={{ color: 'var(--error, #b3261e)' }}>
            <span className="text-xs">Route error: {routeError}</span>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-1 px-2 md:px-3 py-1.5 border-t border-[var(--chart-border)]">
          <button onClick={() => setFullscreen(true)} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.expand' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>fullscreen</span>
            <span>{t('chart.action.expand' as any)}</span>
          </button>
          <button onClick={handleDownloadHtml} className="chat-chart-toggle flex items-center gap-1" title={t('chart.action.downloadHtml' as any)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span>
            <span>{t('chart.action.downloadHtml' as any)}</span>
          </button>
          <button onClick={() => setShowRaw(!showRaw)} className="chat-chart-toggle flex items-center gap-1">
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{showRaw ? 'visibility_off' : 'data_object'}</span>
            <span>{t('chart.action.data' as any)}</span>
          </button>
        </div>
        {showRaw && (
          <pre className="chat-chart-raw"><code>{JSON.stringify(mapData, null, 2)}</code></pre>
        )}

        {/* Hint */}
        <div className="chat-mindmap-hint">{t('map.hint' as any)}</div>
      </div>

      {/* Fullscreen modal */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-2xl w-[95vw] md:w-[85vw] max-h-[90vh] overflow-auto p-4 md:p-8 relative"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer transition-colors"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
            {mapData.title && <div className="text-base md:text-lg font-bold text-on-surface mb-3 md:mb-4 pr-10">{mapData.title}</div>}
            <div className="chat-map-disclaimer" style={{ borderRadius: 8, marginBottom: 8 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>info</span>
              <span>{t('map.disclaimer' as any)}</span>
            </div>
            {renderMap(typeof window !== 'undefined' && window.innerWidth < 768 ? 350 : 500, 'fullscreen')}
            <div className="flex items-center flex-wrap gap-2 mt-3 md:mt-4 pt-3 border-t border-outline-variant/20">
              <button onClick={handleDownloadHtml} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span> {t('chart.action.downloadHtml' as any)}
              </button>
              {mapData.route && (
                <a href={getGoogleMapsRouteUrl(mapData.route)} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1 no-underline">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span> {t('map.action.openRouteGoogleMaps' as any)}
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
