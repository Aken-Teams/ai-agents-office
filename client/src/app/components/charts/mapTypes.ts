export interface MapMarker {
  lat: number;
  lng: number;
  label: string;
  description?: string;
  /**
   * Set by the generating skill when the coordinates came back from the
   * geocoding tool as a confirmed match, rather than from the model.
   *
   * Absent means unverified, deliberately: the old behaviour was a blanket
   * "coordinates are AI-generated" banner over every map, which was both
   * useless on a fully geocoded map and unable to point at the one pin that
   * actually was a guess. Defaulting to unverified keeps an un-updated
   * producer honest — it can only lose the warning by claiming verification.
   */
  verified?: boolean;
}

export interface MapRoute {
  from: [number, number]; // [lat, lng]
  to: [number, number];   // [lat, lng]
  waypoints?: [number, number][];
  label?: string;
}

export interface MapData {
  center: [number, number]; // [lat, lng]
  zoom: number;
  markers: MapMarker[];
  route?: MapRoute;
  title?: string;
}

export function validateMapData(data: MapData): string | null {
  if (!Array.isArray(data.center) || data.center.length !== 2) {
    return 'Map requires "center" as [lat, lng] array';
  }
  if (typeof data.zoom !== 'number' || data.zoom < 1 || data.zoom > 20) {
    return 'Map requires "zoom" between 1 and 20';
  }
  if (!Array.isArray(data.markers) || data.markers.length === 0) {
    return 'Map requires non-empty "markers" array';
  }
  for (const m of data.markers) {
    if (typeof m.lat !== 'number' || typeof m.lng !== 'number') {
      return `Marker "${m.label}" has invalid coordinates`;
    }
    if (!m.label) return 'Each marker requires a "label"';
  }
  if (data.route) {
    if (!Array.isArray(data.route.from) || data.route.from.length !== 2) {
      return 'Route "from" must be [lat, lng]';
    }
    if (!Array.isArray(data.route.to) || data.route.to.length !== 2) {
      return 'Route "to" must be [lat, lng]';
    }
  }
  return null;
}
