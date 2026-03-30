import React, { useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { Circle, CircleMarker, MapContainer, Pane, Polygon, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { LatLngBoundsExpression, LatLngExpression } from 'leaflet';
import { DisplayFilters, Geofence, OptimizationResult, RouteFocus } from '../types';

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

interface ClusteredNode {
  key: string;
  lat: number;
  lng: number;
  count: number;
  nodes: GeoNode[];
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 1e-10) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a: [number, number], b: [number, number], c: [number, number]): boolean {
  return (
    b[1] <= Math.max(a[1], c[1]) + 1e-10 &&
    b[1] + 1e-10 >= Math.min(a[1], c[1]) &&
    b[0] <= Math.max(a[0], c[0]) + 1e-10 &&
    b[0] + 1e-10 >= Math.min(a[0], c[0])
  );
}

function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

function draftWouldSelfIntersect(points: [number, number][]): boolean {
  if (points.length < 4) return false;
  const a1 = points[points.length - 2];
  const a2 = points[points.length - 1];
  for (let i = 0; i < points.length - 3; i += 1) {
    const b1 = points[i];
    const b2 = points[i + 1];
    if (segmentsIntersect(a1, a2, b1, b2)) return true;
  }
  return false;
}

function closingWouldSelfIntersect(points: [number, number][]): boolean {
  if (points.length < 4) return false;
  const a1 = points[points.length - 1];
  const a2 = points[0];
  for (let i = 1; i < points.length - 2; i += 1) {
    const b1 = points[i];
    const b2 = points[i + 1];
    if (segmentsIntersect(a1, a2, b1, b2)) return true;
  }
  return false;
}

const DEFAULT_FILTERS: DisplayFilters = {
  showBaseline: true,
  showOptimized: true,
  showLabels: true,
  upcomingStops: null,
};

function buildNodeMap(data: OptimizationResult): Map<string, OptimizationResult['nodes'][number]> {
  return new Map(data.nodes.map(node => [node.id, node]));
}

function clampUpcomingStops(value: number | null, maxStops: number): number | null {
  if (value === null) return null;
  return Math.max(1, Math.min(value, Math.max(maxStops, 1)));
}

function getRoutePathIds(data: OptimizationResult): string[] {
  if (data.activeRouteLabel === 'manual' && data.manualRouteOrder?.length) {
    return data.manualRouteOrder;
  }
  return data.optimizedPath;
}

function deriveGeoNodes(data: OptimizationResult): GeoNode[] {
  return data.nodes.filter(
    (node): node is GeoNode => typeof node.lat === 'number' && typeof node.lng === 'number'
  );
}

function idsToGeoPath(path: string[], nodeMap: Map<string, OptimizationResult['nodes'][number]>): [number, number][] {
  return path
    .map(id => nodeMap.get(id))
    .filter((node): node is GeoNode => Boolean(node) && typeof node.lat === 'number' && typeof node.lng === 'number')
    .map(node => [node.lat, node.lng] as [number, number]);
}

function computeVisibleActivePath(data: OptimizationResult, filters: DisplayFilters): string[] {
  const activePath = getRoutePathIds(data);
  if (!filters.upcomingStops || activePath.length <= 2) return activePath;
  const interior = activePath.slice(1, activePath[activePath.length - 1] === activePath[0] ? -1 : undefined);
  const limited = interior.slice(0, filters.upcomingStops);
  return activePath[0] && activePath[activePath.length - 1] === activePath[0]
    ? [activePath[0], ...limited, activePath[0]]
    : [activePath[0], ...limited];
}

function computeBounds(points: [number, number][]): LatLngBoundsExpression | null {
  return points.length > 1 ? (points as LatLngBoundsExpression) : null;
}

function clusterGeoNodes(nodes: GeoNode[], zoom: number): ClusteredNode[] {
  if (nodes.length < 24 || zoom >= 12) {
    return nodes.map(node => ({
      key: node.id,
      lat: node.lat,
      lng: node.lng,
      count: 1,
      nodes: [node],
    }));
  }

  const cellSize = zoom <= 9 ? 0.08 : zoom <= 10 ? 0.05 : 0.03;
  const buckets = new Map<string, GeoNode[]>();

  for (const node of nodes) {
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
  const map = useMapEvents({
    zoomend() {
      onZoomChange(map.getZoom());
    },
  });

  useEffect(() => {
    onZoomChange(map.getZoom());
  }, [map, onZoomChange]);

  return null;
}

function GeofenceDrawingLayer({
  drawing,
  draftPoints,
  onAddPoint,
}: {
  drawing: boolean;
  draftPoints: LatLngExpression[];
  onAddPoint: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(event) {
      if (!drawing) return;
      onAddPoint(event.latlng.lat, event.latlng.lng);
    },
  });

  return draftPoints.length >= 2 ? <Polygon positions={draftPoints} pathOptions={{ color: '#f97316', fillOpacity: 0.16, dashArray: '5 4' }} /> : null;
}

function FiltersPanel({
  filters,
  onFiltersChange,
  stopCount,
  collapsed,
  onToggleCollapsed,
}: {
  filters: DisplayFilters;
  onFiltersChange: React.Dispatch<React.SetStateAction<DisplayFilters>>;
  stopCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className="absolute top-4 left-4 z-[920] w-64 rounded-lg border border-slate-700/80 bg-slate-950/85 px-3 py-3 text-[11px] font-mono text-slate-300 shadow-xl backdrop-blur space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Map Controls</div>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[10px] hover:bg-slate-800" onClick={onToggleCollapsed}>
          {collapsed ? 'Open' : 'Min'}
        </button>
      </div>
      {collapsed ? null : (
        <>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={`rounded border px-2 py-1 ${filters.showBaseline ? 'border-slate-500 text-slate-200' : 'border-slate-800 text-slate-500'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showBaseline: !prev.showBaseline }))}>
          Baseline
        </button>
        <button type="button" className={`rounded border px-2 py-1 ${filters.showOptimized ? 'border-emerald-500/50 text-emerald-300' : 'border-slate-800 text-slate-500'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showOptimized: !prev.showOptimized }))}>
          Active route
        </button>
        <button type="button" className={`rounded border px-2 py-1 ${filters.showLabels ? 'border-blue-500/50 text-blue-300' : 'border-slate-800 text-slate-500'}`} onClick={() => onFiltersChange(prev => ({ ...prev, showLabels: !prev.showLabels }))}>
          Labels
        </button>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 text-slate-300" onClick={() => onFiltersChange(DEFAULT_FILTERS)}>
          Reset
        </button>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
          <span>Upcoming stops</span>
          <span>{filters.upcomingStops ?? 'All'}</span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(stopCount, 1)}
          step={1}
          value={filters.upcomingStops ?? 0}
          onChange={event => onFiltersChange(prev => ({ ...prev, upcomingStops: clampUpcomingStops(Number(event.target.value) || null, stopCount) }))}
          className="w-full accent-emerald-500"
        />
      </div>
        </>
      )}
    </div>
  );
}

function FocusPanel({
  data,
  focus,
  onFocusChange,
  activePath,
  collapsed,
  onToggleCollapsed,
}: {
  data: OptimizationResult;
  focus: RouteFocus;
  onFocusChange: React.Dispatch<React.SetStateAction<RouteFocus>>;
  activePath: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const nodeMap = useMemo(() => buildNodeMap(data), [data]);
  const maxLegIndex = Math.max(activePath.length - 2, 0);
  const selectedStop = focus.selectedStopId ? nodeMap.get(focus.selectedStopId) : undefined;

  return (
    <div className="absolute top-4 right-4 z-[920] w-64 rounded-lg border border-slate-700/80 bg-slate-950/85 px-3 py-3 text-[11px] font-mono text-slate-300 shadow-xl backdrop-blur space-y-3">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="h-1 w-4 bg-amber-500 opacity-90" />
          <span>Baseline</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 w-4 bg-emerald-500" />
          <span className="text-emerald-300">{data.activeRouteLabel === 'manual' ? 'Manual' : 'Optimized'}</span>
        </div>
        </div>
        <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[10px] hover:bg-slate-800" onClick={onToggleCollapsed}>
          {collapsed ? 'Open' : 'Min'}
        </button>
      </div>
      {collapsed ? (
        <div className="border-t border-slate-700 pt-2 text-[10px] uppercase tracking-wider text-slate-500">
          {selectedStop ? selectedStop.label : 'Route focus'}
        </div>
      ) : (
        <>
      <div className="border-t border-slate-700 pt-2 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Route Focus</div>
        <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => onFocusChange(prev => ({ ...prev, fitToActiveRoute: !prev.fitToActiveRoute }))}>
          {focus.fitToActiveRoute ? 'Fit to active route: on' : 'Fit to active route: off'}
        </button>
        <div className="flex items-center gap-2">
          <button type="button" className="flex-1 rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => onFocusChange(prev => ({ ...prev, selectedLegIndex: Math.max((prev.selectedLegIndex ?? 0) - 1, 0) }))}>
            Prev leg
          </button>
          <button type="button" className="flex-1 rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => onFocusChange(prev => ({ ...prev, selectedLegIndex: Math.min((prev.selectedLegIndex ?? 0) + 1, maxLegIndex) }))}>
            Next leg
          </button>
        </div>
        <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => onFocusChange(prev => ({ ...prev, selectedLegIndex: undefined, selectedStopId: undefined }))}>
          Clear selection
        </button>
      </div>
      <div className="border-t border-slate-700 pt-2 text-[10px] uppercase tracking-wider text-slate-500">
        {selectedStop ? `Selected stop: ${selectedStop.label}` : focus.selectedLegIndex !== undefined ? `Selected leg: ${focus.selectedLegIndex + 1}` : data.coordinateMode === 'geo' ? 'Geo mode' : 'Demo mode'}
      </div>
        </>
      )}
    </div>
  );
}

function GeoMap({
  data,
  onGeofencesChange,
  filters,
  focus,
  onFiltersChange,
  onFocusChange,
}: {
  data: OptimizationResult;
  onGeofencesChange: (geofences: Geofence[]) => void;
  filters: DisplayFilters;
  focus: RouteFocus;
  onFiltersChange: React.Dispatch<React.SetStateAction<DisplayFilters>>;
  onFocusChange: React.Dispatch<React.SetStateAction<RouteFocus>>;
}) {
  const nodeMap = useMemo(() => buildNodeMap(data), [data]);
  const geoNodes = useMemo(() => deriveGeoNodes(data), [data]);
  const [drawing, setDrawing] = useState(false);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [selectedGeofenceId, setSelectedGeofenceId] = useState<string | null>(data.geofences?.[0]?.id ?? null);
  const [zoom, setZoom] = useState(12);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [focusCollapsed, setFocusCollapsed] = useState(false);
  const [geofencesCollapsed, setGeofencesCollapsed] = useState(false);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!data.geofences?.length) {
      setSelectedGeofenceId(null);
      return;
    }
    if (!selectedGeofenceId || !data.geofences.some(geofence => geofence.id === selectedGeofenceId)) {
      setSelectedGeofenceId(data.geofences[0].id);
    }
  }, [data.geofences, selectedGeofenceId]);

  const baselinePath =
    data.baselineRoad?.coordinates?.length
      ? data.baselineRoad.coordinates
      : idsToGeoPath(data.baselinePath, nodeMap);

  const activePathIds = useMemo(() => computeVisibleActivePath(data, filters), [data, filters]);
  const activePath =
    data.optimizedRoad?.coordinates?.length && !filters.upcomingStops
      ? data.optimizedRoad.coordinates
      : idsToGeoPath(activePathIds, nodeMap);

  const rawActivePathIds = useMemo(() => getRoutePathIds(data), [data]);
  const activeGeoPathIds = rawActivePathIds.filter(id => {
    const node = nodeMap.get(id);
    return typeof node?.lat === 'number' && typeof node?.lng === 'number';
  });

  const activeBounds = useMemo(() => computeBounds(activePath), [activePath]);
  const allPoints = useMemo(() => [...baselinePath, ...activePath, ...geoNodes.map(node => [node.lat, node.lng] as [number, number])], [baselinePath, activePath, geoNodes]);
  const bounds = useMemo(() => computeBounds(allPoints), [allPoints]);
  const mapCenter = geoNodes.length > 0 ? ([geoNodes[0].lat, geoNodes[0].lng] as LatLngExpression) : ([20, 0] as LatLngExpression);
  const clusteredNodes = useMemo(() => clusterGeoNodes(geoNodes, zoom), [geoNodes, zoom]);
  const selectedLegNodes =
    focus.selectedLegIndex !== undefined && focus.selectedLegIndex >= 0 && focus.selectedLegIndex < activeGeoPathIds.length - 1
      ? [nodeMap.get(activeGeoPathIds[focus.selectedLegIndex]), nodeMap.get(activeGeoPathIds[focus.selectedLegIndex + 1])].filter(Boolean) as GeoNode[]
      : [];
  const selectedLegLine = selectedLegNodes.length === 2 ? selectedLegNodes.map(node => [node.lat, node.lng] as [number, number]) : null;

  const finishDraft = () => {
    if (draftPoints.length < 3) return;
    if (closingWouldSelfIntersect(draftPoints)) {
      setDraftWarning('This blocked area crosses itself. Draw a simple loop instead.');
      return;
    }
    const nextGeofence: Geofence = {
      id: `geofence_${Date.now()}`,
      label: `Blocked area ${((data.geofences?.length ?? 0) + 1).toString().padStart(2, '0')}`,
      coordinates: draftPoints.map(([lat, lng]) => ({ lat, lng })),
    };
    onGeofencesChange([...(data.geofences ?? []), nextGeofence]);
    setSelectedGeofenceId(nextGeofence.id);
    setDraftPoints([]);
    setDraftWarning(null);
    setDrawing(false);
  };

  const removeGeofence = (id: string) => {
    onGeofencesChange((data.geofences ?? []).filter(geofence => geofence.id !== id));
  };

  const renameGeofence = (id: string, label: string) => {
    onGeofencesChange((data.geofences ?? []).map(geofence => (geofence.id === id ? { ...geofence, label } : geofence)));
  };

  return (
    <div className="relative w-full h-full bg-slate-900">
      <MapContainer center={mapCenter} zoom={12} className="h-full w-full" zoomControl={false} attributionControl={true}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomTracker onZoomChange={setZoom} />
        <FitMapToData bounds={focus.fitToActiveRoute ? activeBounds ?? bounds : bounds} enabled={Boolean(focus.fitToActiveRoute ? activeBounds ?? bounds : bounds)} />
        <GeofenceDrawingLayer
          drawing={drawing}
          draftPoints={draftPoints}
          onAddPoint={(lat, lng) =>
            setDraftPoints(prev => {
              const next = [...prev, [lat, lng] as [number, number]];
              if (draftWouldSelfIntersect(next)) {
                setDraftWarning('That point would make the blocked area self-intersect. Try a simple box or loop.');
                return prev;
              }
              setDraftWarning(null);
              return next;
            })
          }
        />

        <Pane name="baseline" style={{ zIndex: 350 }}>
          {filters.showBaseline && baselinePath.length > 1 && (
            <Polyline pathOptions={{ color: '#f59e0b', dashArray: '8 8', weight: 4, opacity: 0.72 }} positions={baselinePath} />
          )}
        </Pane>

        <Pane name="optimized" style={{ zIndex: 450 }}>
          {filters.showOptimized && activePath.length > 1 && (
            <Polyline pathOptions={{ color: '#10b981', weight: 5, opacity: 0.95 }} positions={activePath} />
          )}
          {selectedLegLine && (
            <Polyline pathOptions={{ color: '#f59e0b', weight: 7, opacity: 0.9 }} positions={selectedLegLine} />
          )}
        </Pane>

        <Pane name="geofences" style={{ zIndex: 500 }}>
          {(data.geofences ?? []).map(geofence => (
            <Polygon
              key={geofence.id}
              positions={geofence.coordinates.map(point => [point.lat, point.lng])}
              pathOptions={{
                color: geofence.id === selectedGeofenceId ? '#fb923c' : '#f97316',
                fillColor: '#f97316',
                fillOpacity: geofence.id === selectedGeofenceId ? 0.2 : 0.14,
                weight: geofence.id === selectedGeofenceId ? 3 : 2,
              }}
              eventHandlers={{ click: () => setSelectedGeofenceId(geofence.id) }}
            >
              <Tooltip>{geofence.label}</Tooltip>
            </Polygon>
          ))}
          {data.disruptions
            .filter(disruption => typeof disruption.lat === 'number' && typeof disruption.lng === 'number' && typeof disruption.radiusMeters === 'number')
            .map((disruption, index) => (
              <Circle
                key={`${disruption.description}-${index}`}
                center={[disruption.lat!, disruption.lng!]}
                radius={disruption.radiusMeters!}
                pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.18, weight: 2, dashArray: '6 4' }}
              >
                <Tooltip>{disruption.description}</Tooltip>
              </Circle>
            ))}
        </Pane>

        <Pane name="stops" style={{ zIndex: 650 }}>
          {clusteredNodes.map(cluster => {
            if (cluster.count > 1) {
              return (
                <CircleMarker
                  key={cluster.key}
                  center={[cluster.lat, cluster.lng]}
                  radius={Math.min(10 + cluster.count, 18)}
                  pathOptions={{ color: '#0f172a', weight: 2, fillColor: '#2563eb', fillOpacity: 0.85 }}
                >
                  <Tooltip direction="top" offset={[0, -8]}>
                    {`${cluster.count} stops in this area`}
                  </Tooltip>
                </CircleMarker>
              );
            }

            const node = cluster.nodes[0];
            const activeOrderIndex = activeGeoPathIds.indexOf(node.id);
            const isSelected = focus.selectedStopId === node.id;
            const showPermanentLabel = filters.showLabels && (zoom >= 13 || node.type === 'depot' || node.type === 'hub' || isSelected);

            return (
              <CircleMarker
                key={node.id}
                center={[node.lat, node.lng]}
                radius={node.type === 'depot' || node.type === 'hub' ? 11 : isSelected ? 9 : 7}
                pathOptions={{
                  color: isSelected ? '#10b981' : '#0f172a',
                  weight: isSelected ? 3 : 2,
                  fillColor: node.type === 'depot' || node.type === 'hub' ? '#3b82f6' : '#e2e8f0',
                  fillOpacity: 1,
                }}
                eventHandlers={{
                  click: () => onFocusChange(prev => ({
                    ...prev,
                    selectedStopId: node.id,
                    selectedLegIndex: activeOrderIndex > 0 ? activeOrderIndex - 1 : undefined,
                  })),
                }}
              >
                <Tooltip direction="top" offset={[0, -8]} permanent={showPermanentLabel}>
                  <div className="space-y-1">
                    <div>{node.label}</div>
                    {activeOrderIndex >= 0 && <div className="text-[10px] text-emerald-200">Stop #{activeOrderIndex}</div>}
                  </div>
                </Tooltip>
              </CircleMarker>
            );
          })}
        </Pane>
      </MapContainer>

      <FiltersPanel
        filters={filters}
        onFiltersChange={onFiltersChange}
        stopCount={Math.max(geoNodes.length - 1, 1)}
        collapsed={controlsCollapsed}
        onToggleCollapsed={() => setControlsCollapsed(prev => !prev)}
      />
      <FocusPanel
        data={data}
        focus={focus}
        onFocusChange={onFocusChange}
        activePath={rawActivePathIds}
        collapsed={focusCollapsed}
        onToggleCollapsed={() => setFocusCollapsed(prev => !prev)}
      />

      <div className="absolute left-4 bottom-4 z-[900] rounded-lg border border-slate-700/80 bg-slate-950/85 px-3 py-2 text-[11px] font-mono text-slate-300 shadow-xl backdrop-blur">
        {data.optimizedRoad?.source === 'osrm'
          ? `Road-snapped mode: OSRM active | cache ${data.optimizedRoad.cacheStatus ?? 'none'} | fallback legs ${data.optimizedRoad.fallbackLegCount ?? 0}`
          : 'Road mode active with fallback warnings'}
      </div>

      <div className="absolute bottom-4 right-4 z-[900] w-72 rounded-lg border border-slate-700/80 bg-slate-950/85 px-3 py-3 text-[11px] font-mono text-slate-300 shadow-xl backdrop-blur space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Geofences</div>
          <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[10px] hover:bg-slate-800" onClick={() => setGeofencesCollapsed(prev => !prev)}>
            {geofencesCollapsed ? 'Open' : 'Min'}
          </button>
        </div>
        {geofencesCollapsed ? null : (
          <>
            <button
              type="button"
              className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800"
              onClick={() => {
                setDrawing(true);
                setDraftPoints([]);
                setDraftWarning(null);
              }}
            >
              Draw blocked area
            </button>
            {drawing && (
              <div className="space-y-1">
                <button type="button" className="w-full rounded border border-emerald-500/40 px-2 py-1 text-left text-emerald-300 hover:bg-slate-800" onClick={finishDraft}>
                  Finish polygon
                </button>
                <button type="button" className="w-full rounded border border-slate-700 px-2 py-1 text-left hover:bg-slate-800" onClick={() => { setDrawing(false); setDraftPoints([]); setDraftWarning(null); }}>
                  Cancel drawing
                </button>
              </div>
            )}
            {draftWarning && (
              <div className="rounded border border-amber-500/30 bg-amber-950/20 px-2 py-1 text-[10px] text-amber-200">
                {draftWarning}
              </div>
            )}
            {(data.geofences ?? []).map(geofence => (
              <div key={geofence.id} className={`rounded border px-2 py-2 ${geofence.id === selectedGeofenceId ? 'border-orange-400/50 bg-orange-950/20' : 'border-slate-800 bg-slate-900/70'}`}>
                <button type="button" className="mb-1 w-full text-left truncate" onClick={() => setSelectedGeofenceId(geofence.id)}>
                  {geofence.label}
                </button>
                {geofence.id === selectedGeofenceId && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={geofence.label}
                      onChange={event => renameGeofence(geofence.id, event.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                    />
                    <button type="button" className="text-red-300 hover:text-red-200" onClick={() => removeGeofence(geofence.id)}>
                      Delete geofence
                    </button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}
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

    const baselineLine = d3
      .line<string>()
      .x(id => {
        const node = nodeMap.get(id);
        return node ? xScale(node.x) : 0;
      })
      .y(id => {
        const node = nodeMap.get(id);
        return node ? yScale(node.y) : 0;
      })
      .curve(d3.curveLinear);

    const optimizedLine = d3
      .line<string>()
      .x(id => {
        const node = nodeMap.get(id);
        return node ? xScale(node.x) : 0;
      })
      .y(id => {
        const node = nodeMap.get(id);
        return node ? yScale(node.y) : 0;
      })
      .curve(d3.curveCatmullRom.alpha(0.5));

    svg.append('path').datum(data.baselinePath).attr('fill', 'none').attr('stroke', '#f59e0b').attr('stroke-width', 2).attr('stroke-dasharray', '5,5').attr('opacity', 0.78).attr('d', baselineLine);
    svg.append('path').datum(data.optimizedPath).attr('fill', 'none').attr('stroke', '#10b981').attr('stroke-width', 3).attr('d', optimizedLine);

    const nodes = svg.selectAll('.node').data(data.nodes).enter().append('g').attr('transform', d => `translate(${xScale(d.x)}, ${yScale(d.y)})`);
    nodes.append('circle').attr('r', d => (d.type === 'hub' || d.type === 'depot' ? 8 : 5)).attr('fill', d => (d.type === 'hub' || d.type === 'depot' ? '#3b82f6' : '#e2e8f0')).attr('stroke', '#0f172a').attr('stroke-width', 2);
    nodes.append('text').attr('dy', -12).text(d => d.label).attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px').attr('font-family', 'sans-serif');
  }, [data]);

  return (
    <div className="relative w-full h-full bg-slate-900 rounded-lg overflow-hidden">
      <div className="absolute left-4 bottom-4 z-10 rounded-lg border border-amber-500/30 bg-slate-950/85 px-3 py-2 text-[11px] font-mono text-amber-200 shadow-xl backdrop-blur">
        Demo coordinate mode: road routing disabled until valid geo input is provided
      </div>
      <svg ref={svgRef} className="h-full w-full" />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-slate-900 text-slate-300">
      <div className="mb-4 h-16 w-16 rounded-full border-4 border-emerald-500/20 border-t-emerald-500 animate-spin" />
      <p className="font-mono text-sm">Preparing road routing and map overlays...</p>
      <p className="mt-2 text-xs text-slate-500">Basemap - roads - metrics - overrides</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-900/70 text-slate-400">
      <div className="max-w-sm text-center">
        <svg className="mx-auto mb-4 h-16 w-16 opacity-25" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 7m0 13V7" />
        </svg>
        <p className="font-mono text-sm text-slate-300">Ready for route inputs</p>
        <p className="mt-2 text-xs text-slate-500">Paste `label, lat, lng` to enable real road routing and map overrides.</p>
      </div>
    </div>
  );
}

const MapVisualization: React.FC<MapVisualizationProps> = ({ data, loading, onGeofencesChange, filters, focus, onFiltersChange, onFocusChange }) => {
  if (loading) return <LoadingState />;
  if (!data) return <EmptyState />;

  const hasGeoNodes = data.coordinateMode === 'geo' && data.nodes.some(node => typeof node.lat === 'number' && typeof node.lng === 'number');

  return (
    <div className="relative h-full w-full rounded-lg overflow-hidden border border-slate-800 bg-slate-900 shadow-2xl">
      {hasGeoNodes ? (
        <GeoMap
          data={data}
          onGeofencesChange={onGeofencesChange}
          filters={filters}
          focus={focus}
          onFiltersChange={onFiltersChange}
          onFocusChange={onFocusChange}
        />
      ) : (
        <DemoMap data={data} />
      )}
    </div>
  );
};

export default MapVisualization;
