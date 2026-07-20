import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphEdge,
  GraphNode,
  Preferences,
  ResortGraph,
  Route,
  RouteObjective,
} from './types/domain';
import type { GeoFeatureCollection, ResortIndexEntry } from './data/resortData';
import { loadResortGeo, loadResortGraph, loadResortIndex } from './data/resortData';
import { loadPreferences, savePreferences } from './state/preferences';
import { loadCustomEdges, saveCustomEdges } from './state/customEdges';
import { nearestNode, nearestResort } from './utils/nearest';
import { distance3dM, haversineM } from './utils/geo';
import { planRoutes, findLongestRuns, type PlanResult, type LongestRun } from './routing/plan';
import { MapView, type LonLat, type RouteFeatureCollection } from './components/MapView';
import { PointPicker } from './components/PointPicker';
import { PreferencesPanel } from './components/PreferencesPanel';
import { RouteOptions } from './components/RouteOptions';
import { CustomLinkPanel, type LinkColor, type LinkDirection } from './components/CustomLinkPanel';
import { LongestRunPanel } from './components/LongestRunPanel';
import { Legend } from './components/Legend';
import { Logo } from './components/Logo';
import './App.css';

const DEFAULT_RESORT_ID = 'madonna-di-campiglio';

function nowLocalDatetime(offsetMinutes = 60): string {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function App() {
  const [index, setIndex] = useState<ResortIndexEntry[] | null>(null);
  const [resortId, setResortId] = useState<string>(DEFAULT_RESORT_ID);
  const [graph, setGraph] = useState<ResortGraph | null>(null);
  const [geo, setGeo] = useState<GeoFeatureCollection | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  const [customEdges, setCustomEdges] = useState<GraphEdge[]>([]);

  const [fromNodeId, setFromNodeId] = useState<string | null>(null);
  const [toNodeId, setToNodeId] = useState<string | null>(null);
  const [fromCustom, setFromCustom] = useState<string | null>(null);
  const [toCustom, setToCustom] = useState<string | null>(null);
  const [pinMode, setPinMode] = useState<'from' | 'to' | null>(null);

  const [objective, setObjective] = useState<RouteObjective>('fastest');
  const [timingMode, setTimingMode] = useState<'now' | 'arrive_by'>('now');
  const [arriveTime, setArriveTime] = useState<string>(() => nowLocalDatetime());

  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [selectedRoute, setSelectedRoute] = useState(0);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [popup, setPopup] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading resorts…');
  const [focusGeometry, setFocusGeometry] = useState<[number, number][] | null>(null);
  const [longestRuns, setLongestRuns] = useState<(LongestRun & { startName: string; endName: string })[] | null>(null);
  const [longestIdx, setLongestIdx] = useState(0);

  const geolocated = useRef(false);

  useEffect(() => savePreferences(prefs), [prefs]);

  // Load resort index + pick default (by geolocation, else Madonna).
  useEffect(() => {
    loadResortIndex()
      .then((entries) => {
        setIndex(entries);
        const hasDefault = entries.some((e) => e.id === DEFAULT_RESORT_ID);
        setResortId(hasDefault ? DEFAULT_RESORT_ID : entries[0]?.id ?? DEFAULT_RESORT_ID);
        setStatus('');
        if (!geolocated.current && 'geolocation' in navigator) {
          geolocated.current = true;
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              const near = nearestResort(entries, pos.coords.longitude, pos.coords.latitude);
              if (near) setResortId(near.id);
            },
            () => {},
            { timeout: 5000 },
          );
        }
      })
      .catch((e) => setStatus(`Could not load resorts: ${String(e)}`));
  }, []);

  // Load graph + geo + custom edges when resort changes.
  useEffect(() => {
    if (!resortId) return;
    setGraph(null);
    setGeo(null);
    setPlan(null);
    setSelectedStep(null);
    setLongestRuns(null);
    setLongestIdx(0);
    setFocusGeometry(null);
    setFromNodeId(null);
    setToNodeId(null);
    setCustomEdges(loadCustomEdges(resortId));
    setStatus('Loading resort data…');
    Promise.all([loadResortGraph(resortId), loadResortGeo(resortId)])
      .then(([g, ge]) => {
        setGraph(g);
        setGeo(ge);
        setStatus('');
      })
      .catch((e) => setStatus(`Could not load resort: ${String(e)}`));
  }, [resortId]);

  // Graph + geo including any user-added custom links.
  const effectiveGraph = useMemo<ResortGraph | null>(() => {
    if (!graph) return null;
    if (customEdges.length === 0) return graph;
    return { ...graph, edges: [...graph.edges, ...customEdges] };
  }, [graph, customEdges]);

  const effectiveGeo = useMemo<GeoFeatureCollection | null>(() => {
    if (!geo) return null;
    if (customEdges.length === 0) return geo;
    const extra = customEdges.map((e) => ({
      type: 'Feature' as const,
      properties: {
        kind: e.kind,
        color: e.color ?? null,
        liftType: null,
        name: e.pisteName ?? 'Custom link',
        connectorKind: e.connectorKind ?? null,
        synthetic: true,
        custom: true,
      },
      geometry: { type: 'LineString' as const, coordinates: e.geometry.map((p) => [p.lon, p.lat] as [number, number]) },
    }));
    return { type: 'FeatureCollection', features: [...geo.features, ...extra] };
  }, [geo, customEdges]);

  const resortEntry = index?.find((e) => e.id === resortId);
  const center: LonLat = resortEntry
    ? { lon: resortEntry.center.lon, lat: resortEntry.center.lat }
    : { lon: 10.826, lat: 46.23 };

  const nodeMap = useMemo(() => {
    const m = new Map<string, GraphNode>();
    effectiveGraph?.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [effectiveGraph]);

  const edgeMap = useMemo(() => {
    const m = new Map<string, GraphEdge>();
    effectiveGraph?.edges.forEach((e) => m.set(e.id, e));
    return m;
  }, [effectiveGraph]);

  const pointFor = (nodeId: string | null): LonLat | null => {
    if (!nodeId) return null;
    const n = nodeMap.get(nodeId);
    return n ? { lon: n.point.lon, lat: n.point.lat } : null;
  };

  const labelFor = (nodeId: string | null, custom: string | null): string | null => {
    if (!nodeId) return null;
    if (custom) return custom;
    const p = graph?.points.find((x) => x.nodeId === nodeId);
    return p?.name ?? nodeMap.get(nodeId)?.name ?? 'Selected point';
  };

  const selected: Route | undefined = plan?.routes[selectedRoute];
  const routeFC: RouteFeatureCollection = useMemo(() => {
    if (!selected) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: selected.legs
        .map((l, i) => {
          const edge = edgeMap.get(l.edgeId);
          if (!edge) return null;
          return {
            type: 'Feature' as const,
            properties: {
              color: l.color ?? null,
              kind: l.kind,
              stepIndex: i,
              synthetic: edge.synthetic ?? false,
              custom: edge.custom ?? false,
            },
            geometry: {
              type: 'LineString' as const,
              coordinates: edge.geometry.map((p) => [p.lon, p.lat] as [number, number]),
            },
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null),
    };
  }, [selected, edgeMap]);

  const handleMapClick = useCallback(
    (p: LonLat) => {
      if (!pinMode || !effectiveGraph) return;
      const n = nearestNode(effectiveGraph, p.lon, p.lat);
      if (!n) return;
      if (pinMode === 'from') {
        setFromNodeId(n.id);
        setFromCustom(n.name ?? 'Pinned location');
      } else {
        setToNodeId(n.id);
        setToCustom(n.name ?? 'Pinned location');
      }
      setPinMode(null);
    },
    [pinMode, effectiveGraph],
  );

  const pickLocationFor = (which: 'from' | 'to') => {
    if (!effectiveGraph || !('geolocation' in navigator)) {
      setPopup('Geolocation is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const n = nearestNode(effectiveGraph, pos.coords.longitude, pos.coords.latitude);
        if (!n) return;
        if (which === 'from') { setFromNodeId(n.id); setFromCustom('My location'); }
        else { setToNodeId(n.id); setToCustom('My location'); }
      },
      () => setPopup('Could not get your location. Pick a point or pin on the map instead.'),
      { timeout: 5000 },
    );
  };

  const doPlan = (fromId: string | null = fromNodeId, toId: string | null = toNodeId) => {
    if (!effectiveGraph || !fromId || !toId) {
      setPopup('Pick both a start and a destination first.');
      return;
    }
    const result = planRoutes(effectiveGraph, {
      resortId,
      fromNodeId: fromId,
      toNodeId: toId,
      objective,
      timing:
        timingMode === 'arrive_by'
          ? { mode: 'arrive_by', time: new Date(arriveTime).toISOString() }
          : { mode: 'now' },
      prefs,
    });
    setPlan(result);
    setSelectedRoute(0);
    setSelectedStep(null);
    if (result.error) {
      setPopup(result.error);
      return;
    }
    const codes = new Set(result.routes.flatMap((r) => r.warnings.map((w) => w.code)));
    const notes: string[] = [];
    if (codes.has('missing_opening_hours')) notes.push('Some lifts have no opening-hours data — closing-time warnings may be missing.');
    if (codes.has('using_default_wait')) notes.push('Default lift wait times were used (no measured data).');
    if (codes.has('using_default_speed')) notes.push('Default ski speeds were used for some runs (unknown difficulty).');
    if (notes.length) setPopup(notes.join('\n'));
  };

  const addCustomLink = (color: LinkColor, direction: LinkDirection) => {
    if (!fromNodeId || !toNodeId || !nodeMap.size) return;
    const a = nodeMap.get(fromNodeId);
    const b = nodeMap.get(toNodeId);
    if (!a || !b || a.id === b.id) {
      setPopup('Pick two different points (A and B) for the link.');
      return;
    }
    const len = distance3dM(a.point, b.point);
    const stamp = Date.now();
    const mk = (from: GraphNode, to: GraphNode, tag: string): GraphEdge => ({
      id: `cust-${stamp}-${tag}`,
      from: from.id,
      to: to.id,
      kind: color === 'none' ? 'connector' : 'piste',
      geometry: [from.point, to.point],
      lengthM: len,
      dropM: (to.point.ele ?? 0) - (from.point.ele ?? 0),
      color: color === 'none' ? undefined : color,
      pisteName: color === 'none' ? undefined : 'Custom link',
      connectorKind: color === 'none' ? 'flat_traverse' : undefined,
      synthetic: true,
      custom: true,
    });
    const added: GraphEdge[] = [];
    if (direction === 'ab' || direction === 'both') added.push(mk(a, b, 'ab'));
    if (direction === 'ba' || direction === 'both') added.push(mk(b, a, 'ba'));
    const next = [...customEdges, ...added];
    setCustomEdges(next);
    saveCustomEdges(resortId, next);
    setPopup(`Added a ${color === 'none' ? 'flat' : color} link (${direction === 'both' ? 'both ways' : direction.toUpperCase()}). Press "Find routes" to use it.`);
  };

  const clearCustomLinks = () => {
    setCustomEdges([]);
    saveCustomEdges(resortId, []);
  };

  const deleteCustomLinks = (ids: string[]) => {
    const dead = new Set(ids);
    const next = customEdges.filter((e) => !dead.has(e.id));
    setCustomEdges(next);
    saveCustomEdges(resortId, next);
  };

  const nodeLabelFor = (nodeId: string): string => {
    const p = graph?.points.find((x) => x.nodeId === nodeId);
    if (p) return p.name;
    const n = nodeMap.get(nodeId);
    if (n?.name) return n.name;
    // Fall back to the nearest named point ("near X") so unnamed graph nodes read meaningfully.
    if (n && graph) {
      let best: (typeof graph.points)[number] | undefined;
      let bestD = Infinity;
      for (const q of graph.points) {
        const d = haversineM(n.point, q.point);
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      if (best && bestD <= 250) {
        const ele = n.point.ele != null ? ` · ${Math.round(n.point.ele)} m` : '';
        // Same spot (different node id) reads better without the "near" qualifier.
        return bestD <= 20 ? `${best.name}${ele}` : `near ${best.name}${ele}`;
      }
    }
    if (n?.point.ele != null) return `Point at ${Math.round(n.point.ele)} m`;
    return nodeId;
  };

  const computeLongestRun = () => {
    if (!effectiveGraph) return;
    const res = findLongestRuns(effectiveGraph, prefs, 3);
    if (!res.length) {
      setLongestRuns(null);
      setPopup('No lift-free run found for your level. Try raising your max difficulty.');
      return;
    }
    const named = res.map((r) => ({
      ...r,
      startName: nodeLabelFor(r.startNodeId),
      endName: nodeLabelFor(r.endNodeId),
    }));
    setLongestRuns(named);
    setLongestIdx(0);
    setFocusGeometry(named[0].coords);
  };

  const stepLongest = (delta: number) => {
    if (!longestRuns || longestRuns.length === 0) return;
    const next = (longestIdx + delta + longestRuns.length) % longestRuns.length;
    setLongestIdx(next);
    setFocusGeometry(longestRuns[next].coords);
  };

  const currentLongest = longestRuns && longestRuns.length ? longestRuns[longestIdx] : null;

  const navigateToLongestStart = () => {
    if (!currentLongest) return;
    setToNodeId(currentLongest.startNodeId);
    setToCustom(currentLongest.startName);
    setFocusGeometry(null);
    setPopup(
      `Destination set to the start of the longest run (${currentLongest.startName}). Pick your start point A (or tap "My location"), then press Find routes.`,
    );
  };

  const navigateToLongestEnd = () => {
    if (!currentLongest) return;
    // Assume the user is already at the top: auto-fill A = start, B = end and route it now.
    setFromNodeId(currentLongest.startNodeId);
    setFromCustom(currentLongest.startName);
    setToNodeId(currentLongest.endNodeId);
    setToCustom(currentLongest.endName);
    setFocusGeometry(null);
    doPlan(currentLongest.startNodeId, currentLongest.endNodeId);
  };

  const handleStepClick = (routeIndex: number, legIndex: number) => {
    if (routeIndex !== selectedRoute) {
      setSelectedRoute(routeIndex);
      setSelectedStep(legIndex);
    } else {
      setSelectedStep((cur) => (cur === legIndex ? null : legIndex));
    }
  };

  const points = graph?.points ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">
          <Logo className="logo-mark" />
        </h1>
        <select value={resortId} onChange={(e) => setResortId(e.target.value)} className="resort-select">
          {(index ?? []).map((r) => (
            <option key={r.id} value={r.id}>{r.name} ({r.country})</option>
          ))}
        </select>
        {status && <span className="status">{status}</span>}
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="panel">
            <h3>Plan a route</h3>
            <PointPicker
              label="From (A)"
              accent="#2e7d32"
              points={points}
              valueNodeId={fromNodeId}
              customLabel={fromCustom}
              onPick={(id) => { setFromNodeId(id); setFromCustom(null); }}
              onUseLocation={() => pickLocationFor('from')}
              onPinMode={() => setPinMode(pinMode === 'from' ? null : 'from')}
              pinActive={pinMode === 'from'}
            />
            <PointPicker
              label="To (B)"
              accent="#c62828"
              points={points}
              valueNodeId={toNodeId}
              customLabel={toCustom}
              onPick={(id) => { setToNodeId(id); setToCustom(null); }}
              onUseLocation={() => pickLocationFor('to')}
              onPinMode={() => setPinMode(pinMode === 'to' ? null : 'to')}
              pinActive={pinMode === 'to'}
            />

            <label className="field">
              <span>Objective</span>
              <select value={objective} onChange={(e) => setObjective(e.target.value as RouteObjective)}>
                <option value="fastest">Fastest route</option>
                <option value="longest_streak">Longest skiable streak</option>
              </select>
            </label>

            <div className="field">
              <span>When</span>
              <div className="timing">
                <label><input type="radio" checked={timingMode === 'now'} onChange={() => setTimingMode('now')} /> Now</label>
                <label><input type="radio" checked={timingMode === 'arrive_by'} onChange={() => setTimingMode('arrive_by')} /> Arrive by</label>
              </div>
              {timingMode === 'arrive_by' && (
                <input type="datetime-local" value={arriveTime} onChange={(e) => setArriveTime(e.target.value)} />
              )}
            </div>

            <button type="button" className="primary" onClick={() => doPlan()} disabled={!graph}>
              Find routes
            </button>
          </div>

          {plan && plan.noLiftFreeRoute && (
            <div className="ski-note">
              <strong>No lift-free route to this point at your level.</strong>
              {plan.nearestSkiDestination ? (
                <>
                  {' '}Nearest ski-down destination:{' '}
                  <button
                    type="button"
                    className="link-btn inline"
                    onClick={() => {
                      setToNodeId(plan.nearestSkiDestination!.nodeId);
                      setToCustom(null);
                    }}
                  >
                    {plan.nearestSkiDestination.name}
                  </button>{' '}
                  (tap to set as destination, then Find routes).
                </>
              ) : (
                ' Try a lower difficulty or a different destination.'
              )}
            </div>
          )}

          {plan && plan.routes.length > 0 && (
            <RouteOptions
              routes={plan.routes}
              selectedIndex={selectedRoute}
              onSelect={(i) => { setSelectedRoute(i); setSelectedStep(null); }}
              selectedStep={selectedStep}
              onStepClick={handleStepClick}
            />
          )}

          <LongestRunPanel
            runs={longestRuns}
            index={longestIdx}
            onFind={computeLongestRun}
            onPrev={() => stepLongest(-1)}
            onNext={() => stepLongest(1)}
            onShowOnMap={() => currentLongest && setFocusGeometry(currentLongest.coords)}
            onNavigateStart={navigateToLongestStart}
            onNavigateEnd={navigateToLongestEnd}
          />

          <CustomLinkPanel
            fromLabel={labelFor(fromNodeId, fromCustom)}
            toLabel={labelFor(toNodeId, toCustom)}
            links={customEdges}
            nodeLabel={nodeLabelFor}
            onAdd={addCustomLink}
            onDelete={deleteCustomLinks}
            onLocate={setFocusGeometry}
            onClear={clearCustomLinks}
          />

          <PreferencesPanel prefs={prefs} onChange={setPrefs} />

          {graph && (
            <p className="datanote">
              {effectiveGraph?.nodes.length} nodes · {effectiveGraph?.edges.length} edges · {points.length} named points
            </p>
          )}
        </aside>

        <main className="map-wrap">
          <MapView
            center={center}
            zoom={12}
            geo={effectiveGeo}
            routeFC={routeFC}
            selectedStep={selectedStep}
            from={pointFor(fromNodeId)}
            to={pointFor(toNodeId)}
            focusGeometry={focusGeometry}
            onMapClick={handleMapClick}
          />
          {pinMode && <div className="pin-hint">Click the map to set point {pinMode === 'from' ? 'A' : 'B'}</div>}
          <Legend />
        </main>
      </div>

      {popup && (
        <div className="popup-overlay" onClick={() => setPopup(null)}>
          <div className="popup" onClick={(e) => e.stopPropagation()}>
            <h4>Heads up</h4>
            {popup.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            <button type="button" className="primary" onClick={() => setPopup(null)}>Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}
