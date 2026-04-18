import React, { useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { Circle, CircleMarker, MapContainer, Pane, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import { DisplayFilters, FleetRoutePlan, Geofence, LatLngPoint, OptimizationResult, RouteFocus, RouteTrafficSegment, TrafficCongestionLevel } from '../types';

interface MapVisualizationProps {
  data: OptimizationResult | null;
  loading: boolean;
  onGeofencesChange: (geofences: Geofence[]) => void;
  filters: DisplayFilters;
  focus: RouteFocus;
  onFiltersChange: React.Dispatch<React.SetStateAction<DisplayFilters>>;
  onFocusChange: React.Dispatch<React.SetStateAction<RouteFocus>>;
}

type GeoNode = OptimizationResult['nodes'][number] & { lat: number; lng: number };
type TrafficFilter = 'all' | TrafficCongestionLevel;

const DEFAULT_FILTERS: DisplayFilters = { showBaseline: true, showOptimized: true, showLabels: true, showTraffic: false, upcomingStops: null };
const VEHICLE_COLORS = ['#10b981', '#38bdf8', '#f59e0b', '#f472b6', '#a78bfa', '#f97316'];

function buildNodeMap(data: OptimizationResult) {
  return new Map(data.nodes.map(node => [node.id, node]));
}

function vehicleColor(index: number) {
  return VEHICLE_COLORS[index % VEHICLE_COLORS.length];
}

function deriveGeoNodes(data: OptimizationResult): GeoNode[] {
  return data.nodes.filter((node): node is GeoNode => typeof node.lat === 'number' && typeof node.lng === 'number');
}

function idsToGeoPath(path: string[], nodeMap: Map<string, OptimizationResult['nodes'][number]>): [number, number][] {
  return path
    .map(id => nodeMap.get(id))
    .filter((node): node is GeoNode => Boolean(node) && typeof node.lat === 'number' && typeof node.lng === 'number')
    .map(node => [node.lat, node.lng] as [number, number]);
}

function computeBounds(points: [number, number][]): LatLngBoundsExpression | null {
  return points.length > 1 ? (points as LatLngBoundsExpression) : null;
}

function trafficColor(congestion: TrafficCongestionLevel) {
  switch (congestion) {
    case 'low':
      return '#22c55e';
    case 'moderate':
      return '#facc15';
    case 'heavy':
      return '#f97316';
    case 'severe':
      return '#ef4444';
    default:
      return '#94a3b8';
  }
}

function matchesTrafficFilter(congestion: TrafficCongestionLevel, filter: TrafficFilter) {
  return filter === 'all' || congestion === filter;
}

function buildTrafficDisplayLines(segments: RouteTrafficSegment[]) {
  return segments.filter(segment => segment.coordinates.length > 1);
}

function distanceSq(a: [number, number], b: [number, number]) {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return dLat * dLat + dLng * dLng;
}

function lerpPoint(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function projectPointOntoSegment(point: [number, number], start: [number, number], end: [number, number]) {
  const segLat = end[0] - start[0];
  const segLng = end[1] - start[1];
  const segLenSq = segLat * segLat + segLng * segLng;
  if (segLenSq <= Number.EPSILON) {
    return { point: start, t: 0, distanceSq: distanceSq(point, start) };
  }
  const rawT = ((point[0] - start[0]) * segLat + (point[1] - start[1]) * segLng) / segLenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const projected = lerpPoint(start, end, t);
  return { point: projected, t, distanceSq: distanceSq(point, projected) };
}

function snapPointToRoad(click: [number, number], roadCoords: [number, number][]) {
  let best:
    | {
        point: [number, number];
        segmentIndex: number;
        t: number;
        distanceSq: number;
      }
    | null = null;

  for (let i = 0; i < roadCoords.length - 1; i += 1) {
    const candidate = projectPointOntoSegment(click, roadCoords[i], roadCoords[i + 1]);
    if (!best || candidate.distanceSq < best.distanceSq) {
      best = {
        point: candidate.point,
        segmentIndex: i,
        t: candidate.t,
        distanceSq: candidate.distanceSq,
      };
    }
  }

  return best;
}

function roadPositionKey(position: { segmentIndex: number; t: number }) {
  return position.segmentIndex + position.t;
}

function sliceRoadBetween(
  roadCoords: [number, number][],
  start: { point: [number, number]; segmentIndex: number; t: number },
  end: { point: [number, number]; segmentIndex: number; t: number }
): [number, number][] {
  const startKey = roadPositionKey(start);
  const endKey = roadPositionKey(end);
  const from = startKey <= endKey ? start : end;
  const to = startKey <= endKey ? end : start;
  const path: [number, number][] = [from.point];

  for (let i = from.segmentIndex + 1; i <= to.segmentIndex; i += 1) {
    path.push(roadCoords[i]);
  }

  const last = path[path.length - 1];
  if (!last || distanceSq(last, to.point) > 1e-12) {
    path.push(to.point);
  }

  return path;
}

function metersToLatDegrees(meters: number) {
  return meters / 111320;
}

function metersToLngDegrees(meters: number, atLat: number) {
  const scale = Math.cos((atLat * Math.PI) / 180) * 111320;
  return meters / Math.max(Math.abs(scale), 1e-6);
}

function buildBlockedRoadPolygon(path: [number, number][], widthMeters = 18): LatLngPoint[] {
  if (path.length < 2) return path.map(([lat, lng]) => ({ lat, lng }));
  const leftOffsets: LatLngPoint[] = [];
  const rightOffsets: LatLngPoint[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const current = path[i];
    const prev = path[Math.max(i - 1, 0)];
    const next = path[Math.min(i + 1, path.length - 1)];
    const dirLat = next[0] - prev[0];
    const dirLng = next[1] - prev[1];
    const len = Math.hypot(dirLat, dirLng) || 1;
    const normalLat = -dirLng / len;
    const normalLng = dirLat / len;
    const latOffset = metersToLatDegrees(widthMeters) * normalLat;
    const lngOffset = metersToLngDegrees(widthMeters, current[0]) * normalLng;
    leftOffsets.push({ lat: current[0] + latOffset, lng: current[1] + lngOffset });
    rightOffsets.push({ lat: current[0] - latOffset, lng: current[1] - lngOffset });
  }
  return [...leftOffsets, ...rightOffsets.reverse()];
}

function FitMapToData({ bounds, enabled }: { bounds: LatLngBoundsExpression | null; enabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds || !enabled) return;
    map.fitBounds(bounds, { padding: [32, 32] });
  }, [bounds, enabled, map]);
  return null;
}

function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMapEvents({ zoomend() { onZoomChange(map.getZoom()); } });
  useEffect(() => { onZoomChange(map.getZoom()); }, [map, onZoomChange]);
  return null;
}

function GeofenceDrawingLayer({ drawing, onAddPoint }: { drawing: boolean; onAddPoint: (lat: number, lng: number) => void }) {
  useMapEvents({ click(event) { if (drawing) onAddPoint(event.latlng.lat, event.latlng.lng); } });
  return null;
}

function Panel({ title, collapsed, onToggleCollapsed, children, className }: { title: string; collapsed: boolean; onToggleCollapsed: () => void; children?: React.ReactNode; className?: string }) {
  return (
    <div className={`absolute z-[920] rounded-lg border border-slate-700/80 bg-slate-950/85 px-3 py-3 text-[11px] font-mono text-slate-300 shadow-xl backdrop-blur ${className ?? ''}`}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">{title}</div>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[10px] hover:bg-slate-800" onClick={onToggleCollapsed}>
          {collapsed ? 'Open' : 'Min'}
        </button>
      </div>
      {collapsed ? null : children}
    </div>
  );
}

function GeoMap({ data, onGeofencesChange, filters, focus, onFiltersChange, onFocusChange }: MapVisualizationProps & { data: OptimizationResult }) {
  const nodeMap = useMemo(() => buildNodeMap(data), [data]);
  const geoNodes = useMemo(() => deriveGeoNodes(data), [data]);
  const [zoom, setZoom] = useState(12);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [focusCollapsed, setFocusCollapsed] = useState(false);
  const [geofencesCollapsed, setGeofencesCollapsed] = useState(false);
  const [trafficCollapsed, setTrafficCollapsed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [trafficFilter, setTrafficFilter] = useState<TrafficFilter>('all');
  const selectedRouteId = focus.selectedRouteId ?? data.optimizedRoutes[0]?.routeId;

  const visibleBaselineRoutes = filters.showBaseline ? data.baselineRoutes : [];
  const visibleOptimizedRoutes = filters.showOptimized ? data.optimizedRoutes : [];
  const selectedOptimizedRoute = data.optimizedRoutes.find(route => route.routeId === selectedRouteId) ?? data.optimizedRoutes[0];
  const selectedBaselineRoute = data.baselineRoutes.find(route => route.routeId === selectedRouteId) ?? data.baselineRoutes[0];
  const activeRoad = selectedOptimizedRoute?.road?.coordinates?.length ? selectedOptimizedRoute.road.coordinates : selectedBaselineRoute?.road?.coordinates ?? [];

  const allPoints = useMemo(
    () => [
      ...geoNodes.map(node => [node.lat, node.lng] as [number, number]),
      ...visibleBaselineRoutes.flatMap(route => (route.road?.coordinates?.length ? route.road.coordinates : idsToGeoPath(route.path, nodeMap))),
      ...visibleOptimizedRoutes.flatMap(route => (route.road?.coordinates?.length ? route.road.coordinates : idsToGeoPath(route.path, nodeMap))),
    ],
    [geoNodes, nodeMap, visibleBaselineRoutes, visibleOptimizedRoutes]
  );
  const selectedPoints = useMemo(() => {
    const route = selectedOptimizedRoute ?? selectedBaselineRoute;
    if (!route) return [];
    return route.road?.coordinates?.length ? route.road.coordinates : idsToGeoPath(route.path, nodeMap);
  }, [nodeMap, selectedBaselineRoute, selectedOptimizedRoute]);
  const bounds = useMemo(() => computeBounds(allPoints), [allPoints]);
  const selectedBounds = useMemo(() => computeBounds(selectedPoints), [selectedPoints]);
  const mapCenter = geoNodes.length > 0 ? ([geoNodes[0].lat, geoNodes[0].lng] as LatLngExpression) : ([20, 0] as LatLngExpression);

  const clusteredNodes = useMemo(() => {
    if (geoNodes.length < 24 || zoom >= 12) {
      return geoNodes.map(node => ({ key: node.id, lat: node.lat, lng: node.lng, count: 1, nodes: [node] }));
    }
    const cellSize = zoom <= 9 ? 0.08 : zoom <= 10 ? 0.05 : 0.03;
    const buckets = new Map<string, GeoNode[]>();
    for (const node of geoNodes) {
      const key = `${Math.round(node.lat / cellSize)}:${Math.round(node.lng / cellSize)}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(node);
      buckets.set(key, bucket);
    }
    return Array.from(buckets.entries()).map(([key, bucket]) => ({
      key,
      lat: bucket.reduce((sum, node) => sum + node.lat, 0) / bucket.length,
      lng: bucket.reduce((sum, node) => sum + node.lng, 0) / bucket.length,
      count: bucket.length,
      nodes: bucket,
    }));
  }, [geoNodes, zoom]);

  const draftSnaps = useMemo(
    () => draftPoints.map(point => snapPointToRoad(point, activeRoad)).filter(Boolean),
    [draftPoints, activeRoad]
  );
  const draftPath = useMemo(() => {
    if (draftSnaps.length < 2) return draftSnaps[0] ? [draftSnaps[0].point] : [];
    return sliceRoadBetween(activeRoad, draftSnaps[0]!, draftSnaps[1]!);
  }, [activeRoad, draftSnaps]);
  const trafficAvailable = [...data.baselineRoutes, ...data.optimizedRoutes].some(route => route.road?.source === 'mapbox' && (route.road.trafficSegments?.length ?? 0) > 0);

  const finishDraft = () => {
    if (activeRoad.length < 2 || draftSnaps.length < 2 || draftPath.length < 2) return;
    const nextGeofence: Geofence = {
      id: `geofence_${Date.now()}`,
      label: `Blocked road ${(data.geofences?.length ?? 0) + 1}`,
      kind: 'road_block',
      roadSegment: {
        start: { lat: draftPath[0][0], lng: draftPath[0][1] },
        end: { lat: draftPath[draftPath.length - 1][0], lng: draftPath[draftPath.length - 1][1] },
        path: draftPath.map(([lat, lng]) => ({ lat, lng })),
      },
      coordinates: buildBlockedRoadPolygon(draftPath),
    };
    onGeofencesChange([...(data.geofences ?? []), nextGeofence]);
    setDraftPoints([]);
    setDrawing(false);
  };

  const renderRoute = (route: FleetRoutePlan, collection: 'baseline' | 'optimized') => {
    const path = route.road?.coordinates?.length ? route.road.coordinates : idsToGeoPath(route.path, nodeMap);
    if (path.length < 2) return null;
    const selected = !selectedRouteId || route.routeId === selectedRouteId;
    const dimmed = selectedRouteId && route.routeId !== selectedRouteId;
    const baseColor = vehicleColor(route.vehicleIndex);
    const opacity = dimmed ? 0.18 : collection === 'optimized' ? 0.9 : 0.55;
    const weight = dimmed ? 3 : collection === 'optimized' ? 5 : 4;
    const trafficLines = filters.showTraffic && route.road?.source === 'mapbox' ? buildTrafficDisplayLines(route.road.trafficSegments ?? []).filter(line => matchesTrafficFilter(line.congestion, trafficFilter)) : [];
    return (
      <React.Fragment key={`${collection}-${route.routeId}`}>
        <Polyline positions={path} pathOptions={{ color: baseColor, weight, opacity, dashArray: collection === 'baseline' ? '10 10' : undefined }} />
        {trafficLines.map((line, index) => (
          <React.Fragment key={`${collection}-${route.routeId}-${line.congestion}-${index}`}>
            <Polyline positions={line.coordinates} pathOptions={{ color: baseColor, weight: collection === 'optimized' ? 8 : 7, opacity: dimmed ? 0.12 : 0.22 }} />
            <Polyline positions={line.coordinates} pathOptions={{ color: trafficColor(line.congestion), weight: collection === 'optimized' ? 6 : 5, opacity: dimmed ? 0.18 : 0.95 }} />
          </React.Fragment>
        ))}
      </React.Fragment>
    );
  };

  return (
    <div className="relative h-full w-full bg-slate-900">
      <MapContainer center={mapCenter} zoom={12} className="h-full w-full" zoomControl={false} attributionControl>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <ZoomTracker onZoomChange={setZoom} />
        <FitMapToData bounds={focus.fitToActiveRoute ? selectedBounds ?? bounds : bounds} enabled={Boolean(focus.fitToActiveRoute ? selectedBounds ?? bounds : bounds)} />
        <GeofenceDrawingLayer drawing={drawing} onAddPoint={(lat, lng) => setDraftPoints(prev => (prev.length >= 2 ? [[lat, lng] as [number, number]] : [...prev, [lat, lng] as [number, number]]))} />

        <Pane name="baseline" style={{ zIndex: 330 }}>{visibleBaselineRoutes.map(route => renderRoute(route, 'baseline'))}</Pane>
        <Pane name="optimized" style={{ zIndex: 430 }}>{visibleOptimizedRoutes.map(route => renderRoute(route, 'optimized'))}</Pane>

        <Pane name="geofences" style={{ zIndex: 500 }}>
          {(data.geofences ?? []).map(geofence => (
            <React.Fragment key={geofence.id}>
              {geofence.coordinates.length >= 3 && <Polygon positions={geofence.coordinates.map(point => [point.lat, point.lng])} pathOptions={{ color: '#f97316', fillColor: '#f97316', fillOpacity: geofence.kind === 'road_block' ? 0.08 : 0.14, weight: geofence.kind === 'road_block' ? 1 : 2 }}><Tooltip>{geofence.label}</Tooltip></Polygon>}
              {geofence.roadSegment?.path?.length ? <Polyline positions={geofence.roadSegment.path.map(point => [point.lat, point.lng] as [number, number])} pathOptions={{ color: '#dc2626', weight: 7, opacity: 0.92 }}><Tooltip>{geofence.label}</Tooltip></Polyline> : null}
            </React.Fragment>
          ))}
          {drawing && draftPath.length > 0 && (
            <>
              <Polyline positions={draftPath} pathOptions={{ color: '#ef4444', weight: 7, opacity: 0.9, dashArray: draftPath.length > 1 ? undefined : '4 4' }} />
              {draftPath[0] && <CircleMarker center={draftPath[0]} radius={6} pathOptions={{ color: '#7f1d1d', fillColor: '#ef4444', fillOpacity: 1, weight: 2 }} />}
              {draftPath.length > 1 && <CircleMarker center={draftPath[draftPath.length - 1]} radius={6} pathOptions={{ color: '#7f1d1d', fillColor: '#ef4444', fillOpacity: 1, weight: 2 }} />}
            </>
          )}
          {data.disruptions.filter(disruption => typeof disruption.lat === 'number' && typeof disruption.lng === 'number' && typeof disruption.radiusMeters === 'number').map((disruption, index) => (
            <Circle key={`${disruption.description}-${index}`} center={[disruption.lat!, disruption.lng!]} radius={disruption.radiusMeters!} pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.18, weight: 2, dashArray: '6 4' }}>
              <Tooltip>{disruption.description}</Tooltip>
            </Circle>
          ))}
        </Pane>

        <Pane name="stops" style={{ zIndex: 650 }}>
          {clusteredNodes.map(cluster => {
            if (cluster.count > 1) {
              return <CircleMarker key={cluster.key} center={[cluster.lat, cluster.lng]} radius={Math.min(10 + cluster.count, 18)} pathOptions={{ color: '#0f172a', weight: 2, fillColor: '#2563eb', fillOpacity: 0.85 }}><Tooltip>{`${cluster.count} stops in this area`}</Tooltip></CircleMarker>;
            }
            const node = cluster.nodes[0];
            const isSelected = focus.selectedStopId === node.id;
            const showLabel = filters.showLabels && (zoom >= 13 || node.type === 'depot' || isSelected);
            return (
              <CircleMarker
                key={node.id}
                center={[node.lat, node.lng]}
                radius={node.type === 'depot' ? 11 : isSelected ? 9 : 7}
                pathOptions={{ color: isSelected ? '#10b981' : '#0f172a', weight: isSelected ? 3 : 2, fillColor: node.type === 'depot' ? '#3b82f6' : '#e2e8f0', fillOpacity: 1 }}
                eventHandlers={{ click: () => onFocusChange(prev => ({ ...prev, selectedStopId: node.id })) }}
              >
                <Tooltip direction="top" offset={[0, -8]} permanent={showLabel}>{node.label}</Tooltip>
              </CircleMarker>
            );
          })}
        </Pane>
      </MapContainer>
      <Panel title="Map Controls" collapsed={controlsCollapsed} onToggleCollapsed={() => setControlsCollapsed(prev => !prev)} className="left-4 top-4 w-64">
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" className={`rounded border px-2 py-1 ${filters.showBaseline ? 'border-slate-500 text-slate-200' : 'border-slate-800 text-slate-500'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showBaseline: !prev.showBaseline }))}>Baseline</button>
          <button type="button" className={`rounded border px-2 py-1 ${filters.showOptimized ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-800 text-slate-500'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showOptimized: !prev.showOptimized }))}>Optimized</button>
          <button type="button" className={`rounded border px-2 py-1 ${filters.showLabels ? 'border-blue-500/50 text-blue-300' : 'border-slate-800 text-slate-500'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showLabels: !prev.showLabels }))}>Labels</button>
          <button type="button" className={`rounded border px-2 py-1 ${filters.showTraffic ? 'border-red-500/50 text-red-300' : trafficAvailable ? 'border-slate-700 text-slate-300' : 'border-slate-800 text-slate-600'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showTraffic: !prev.showTraffic }))}>Traffic</button>
          <button type="button" className="rounded border border-slate-700 px-2 py-1 text-slate-300" onClick={() => onFiltersChange(DEFAULT_FILTERS)}>Reset</button>
        </div>
      </Panel>
      <Panel title="Route Focus" collapsed={focusCollapsed} onToggleCollapsed={() => setFocusCollapsed(prev => !prev)} className="right-4 top-4 w-72">
        <div className="mt-3 space-y-2">
          <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => onFocusChange(prev => ({ ...prev, fitToActiveRoute: !prev.fitToActiveRoute }))}>
            {focus.fitToActiveRoute ? 'Fit to selected route: on' : 'Fit to selected route: off'}
          </button>
          <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => onFocusChange(prev => ({ ...prev, selectedRouteId: undefined, selectedStopId: undefined }))}>
            Clear route isolation
          </button>
          <div className="rounded border border-slate-800 bg-slate-900/70 px-2 py-2 text-[10px] text-slate-400">
            {selectedOptimizedRoute ? `${selectedOptimizedRoute.vehicleLabel} selected` : 'Showing full fleet'}
          </div>
        </div>
      </Panel>
      {filters.showTraffic && trafficAvailable && (
        <Panel title="Traffic Overlay" collapsed={trafficCollapsed} onToggleCollapsed={() => setTrafficCollapsed(prev => !prev)} className="bottom-56 left-4 w-56">
          <div className="mt-3 grid grid-cols-3 gap-1">
            {(['all', 'low', 'moderate', 'heavy', 'severe', 'unknown'] as TrafficFilter[]).map(filterValue => (
              <button key={filterValue} type="button" className={`rounded border px-2 py-1 text-left ${trafficFilter === filterValue ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`} onClick={() => setTrafficFilter(filterValue)}>
                {filterValue === 'all' ? 'All' : filterValue}
              </button>
            ))}
          </div>
          <div className="mt-2 space-y-1 text-[10px]">
            <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 bg-green-500" />Low</div>
            <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 bg-yellow-400" />Moderate</div>
            <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 bg-orange-500" />Heavy</div>
            <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 bg-red-500" />Severe</div>
            <div className="flex items-center gap-2"><span className="inline-block h-0.5 w-4 bg-slate-400" />Unknown</div>
          </div>
        </Panel>
      )}
      <Panel title="Geofences" collapsed={geofencesCollapsed} onToggleCollapsed={() => setGeofencesCollapsed(prev => !prev)} className="bottom-40 right-4 w-72">
        <div className="mt-3 space-y-2">
          <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => { setDrawing(true); setDraftPoints([]); }}>
            Mark blocked road
          </button>
          {drawing && (
            <>
              <div className="rounded border border-slate-800 bg-slate-900/70 px-2 py-2 text-[10px] text-slate-400">Click near the blocked road start, then near the blocked road end. Both clicks snap onto the selected routed road and the exact segment between them will be blocked.</div>
              <button type="button" className="w-full rounded border border-emerald-500/40 px-2 py-1 text-left text-emerald-300 hover:bg-slate-800" onClick={finishDraft}>Apply blocked segment</button>
              <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => { setDrawing(false); setDraftPoints([]); }}>Cancel drawing</button>
            </>
          )}
          {(data.geofences ?? []).map(geofence => (
            <div key={geofence.id} className="rounded border border-slate-800 bg-slate-900/70 px-2 py-2">
              <div>{geofence.label}</div>
              <button type="button" className="mt-1 text-red-300 hover:text-red-200" onClick={() => onGeofencesChange((data.geofences ?? []).filter(item => item.id !== geofence.id))}>Delete geofence</button>
            </div>
          ))}
        </div>
      </Panel>
      <div className="absolute bottom-40 left-4 z-[900] rounded-lg border border-slate-700/80 bg-slate-950/85 px-3 py-2 text-[11px] font-mono text-slate-300 shadow-xl backdrop-blur">
        Fleet map: {data.optimizedRoutes.length} routes | {data.diagnostics?.provider === 'mapbox' ? 'Mapbox traffic' : 'OSRM'} active{filters.showTraffic && trafficAvailable ? ` | traffic overlay on (${trafficFilter})` : ''}
      </div>
    </div>
  );
}

function DemoMap({ data }: { data: OptimizationResult }) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;
    const padding = 50;
    const xScale = d3.scaleLinear().domain([0, 100]).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain([0, 100]).range([height - padding, padding]);
    const nodeMap = buildNodeMap(data);
    const line = d3.line<string>().x(id => xScale(nodeMap.get(id)?.x ?? 0)).y(id => yScale(nodeMap.get(id)?.y ?? 0)).curve(d3.curveCatmullRom.alpha(0.5));
    data.baselineRoutes.forEach(route => {
      svg.append('path').datum(route.path).attr('fill', 'none').attr('stroke', vehicleColor(route.vehicleIndex)).attr('stroke-width', 2).attr('stroke-dasharray', '5,5').attr('opacity', 0.55).attr('d', line as any);
    });
    data.optimizedRoutes.forEach(route => {
      svg.append('path').datum(route.path).attr('fill', 'none').attr('stroke', vehicleColor(route.vehicleIndex)).attr('stroke-width', 3).attr('opacity', 0.95).attr('d', line as any);
    });
    const nodes = svg.selectAll('.node').data(data.nodes).enter().append('g').attr('transform', d => `translate(${xScale(d.x)}, ${yScale(d.y)})`);
    nodes.append('circle').attr('r', d => (d.type === 'depot' ? 8 : 5)).attr('fill', d => (d.type === 'depot' ? '#3b82f6' : '#e2e8f0')).attr('stroke', '#0f172a').attr('stroke-width', 2);
    nodes.append('text').attr('dy', -12).text(d => d.label).attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px');
  }, [data]);
  return (
    <div className="relative h-full w-full bg-slate-900">
      <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-amber-500/30 bg-slate-950/85 px-3 py-2 text-[11px] font-mono text-amber-200 shadow-xl backdrop-blur">Demo coordinate mode: fleet split visible, road routing disabled until geo input is provided</div>
      <svg ref={svgRef} className="h-full w-full" />
    </div>
  );
}

function LoadingState() {
  return <div className="flex h-full w-full flex-col items-center justify-center bg-slate-900 text-slate-300"><div className="mb-4 h-16 w-16 animate-spin rounded-full border-4 border-emerald-500/20 border-t-emerald-500" /><p className="font-mono text-sm">Preparing fleet routes and road overlays...</p></div>;
}

function EmptyState() {
  return <div className="flex h-full w-full items-center justify-center bg-slate-900/70 text-slate-400"><div className="max-w-sm text-center"><p className="font-mono text-sm text-slate-300">Ready for fleet inputs</p><p className="mt-2 text-xs text-slate-500">Paste `label, lat, lng` to generate multi-vehicle fleet routes.</p></div></div>;
}

const MapVisualization: React.FC<MapVisualizationProps> = ({ data, loading, onGeofencesChange, filters, focus, onFiltersChange, onFocusChange }) => {
  if (loading) return <LoadingState />;
  if (!data) return <EmptyState />;
  const hasGeoNodes = data.coordinateMode === 'geo' && data.nodes.some(node => typeof node.lat === 'number' && typeof node.lng === 'number');
  return <div className="relative h-full w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-900 shadow-2xl">{hasGeoNodes ? <GeoMap data={data} loading={loading} onGeofencesChange={onGeofencesChange} filters={filters} focus={focus} onFiltersChange={onFiltersChange} onFocusChange={onFocusChange} /> : <DemoMap data={data} />}</div>;
};

export default MapVisualization;
