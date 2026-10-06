/* Capitol Hill and Navy Yard, Washington DC, from OpenStreetMap: real streets, buildings, parks, and the
 * Anacostia. Grid (x, y) is 200 m per unit with y north; world is (x - 6, height, 6 - y), north away from
 * the camera. Robots drive the street paths the backend routed for them. */
import { Html, Line, OrbitControls } from '@react-three/drei';
import { MapPin } from 'lucide-react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { api } from '../lib/api';
import type { City as CityData, Contact, MapData, Robot, Route } from '../lib/types';
import { MiniRobot } from './RobotModel';
import { mapLook, STATUS_TOKEN, token, type Light, type MapLook } from './palette';

const LookCtx = createContext<MapLook | null>(null);
const useLook = () => useContext(LookCtx) ?? mapLook('night');

const W = (x: number, y: number, h = 0): [number, number, number] => [x - 6, h, 6 - y];
// Cruising speed in grid units per second. 0.08 is 16 m/s on screen: about a 10x time-lapse of a 1.6 m/s sidewalk robot,
// slow enough to follow one with your eye. Robots ease out of a stop, slow for corners, and pause at each drop-off.
const SPEED = 0.08;
const DWELL_S = 3;         // seconds parked at the door or the Hub before turning back
const TURN_RATE = 5;       // how quickly a robot swings to its new heading (per second)
const HEIGHT_SCALE = 3;    // buildings are drawn three times taller than life so the city reads from above
const M_PER_UNIT = 200;

// The map is ~1 MB; fetch it once per session and share it across screens.
let mapPromise: Promise<MapData> | null = null;
export function useCityMap() {
  const [map, setMap] = useState<MapData | null>(null);
  useEffect(() => {
    mapPromise ??= api.get<MapData>('/api/map');
    let live = true;
    mapPromise.then((m) => live && setMap(m)).catch(() => { mapPromise = null; });
    return () => { live = false; };
  }, []);
  return map;
}

// ---------------------------------------------------------------- static geometry, built once per map

function flatShapes(rings: [number, number][][], h: number): THREE.BufferGeometry | null {
  const geos = rings.filter((r) => r.length >= 3).map((r) => {
    const g = new THREE.ShapeGeometry(new THREE.Shape(r.map(([x, y]) => new THREE.Vector2(x, y))));
    g.rotateX(-Math.PI / 2);
    g.translate(-6, h, 6);
    return g;
  });
  return geos.length ? mergeGeometries(geos) : null;
}

const ROAD_W: Record<string, number> = { freeway: 0.11, major: 0.075, minor: 0.05, service: 0.026, path: 0.018 };
const ROAD_Y: Record<string, number> = { freeway: 0.03, major: 0.006, minor: 0.005, service: 0.004, path: 0.003 };

function roadGeometry(roads: MapData['roads'], kinds: string[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (const r of roads) {
    if (!kinds.includes(r.k)) continue;
    const w = ROAD_W[r.k] / 2, y = ROAD_Y[r.k];
    for (let i = 0; i < r.p.length - 1; i++) {
      const [x1, y1] = r.p[i], [x2, y2] = r.p[i + 1];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * w, ny = (dx / len) * w;
      quad(W(x1 + nx, y1 + ny, y), W(x2 + nx, y2 + ny, y), W(x2 - nx, y2 - ny, y), W(x1 - nx, y1 - ny, y));
      // A square at each joint so corners don't show gaps.
      quad(W(x2 - w, y2 - w, y), W(x2 + w, y2 - w, y), W(x2 + w, y2 + w, y), W(x2 - w, y2 + w, y));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Deterministic 0..1 from a building's first corner, so unknown heights vary but never flicker. */
const jitter = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function buildingGeometry(buildings: MapData['buildings'], look: MapLook): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const base = new THREE.Color(look.building);
  const tall = new THREE.Color(look.buildingTall);
  const mark = new THREE.Color(look.landmark);
  for (const b of buildings) {
    const pts = b.p;
    if (pts.length < 3) continue;
    const meters = b.h > 0 ? b.h : 9 + jitter(pts[0][0], pts[0][1]) * 5; // DC rowhouses run two to three storeys
    // Exaggerate low buildings so rowhouse blocks read; compress tall ones so the Capitol stays a landmark, not a tower.
    const h = ((Math.min(meters, 24) + Math.max(0, meters - 24) * 0.25) / M_PER_UNIT) * HEIGHT_SCALE;
    const c = b.landmark ? mark : base.clone().lerp(tall, Math.min(1, meters / 45));
    const push = (p: number[]) => { pos.push(...p); col.push(c.r, c.g, c.b); };
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      const a = W(x1, y1, 0), bb = W(x2, y2, 0), cc = W(x2, y2, h), d = W(x1, y1, h);
      [a, bb, cc, a, cc, d].forEach(push);
    }
    const contour = pts.map(([x, y]) => new THREE.Vector2(x, y));
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      [pts[i], pts[j], pts[k]].forEach(([x, y]) => push(W(x, y, h)));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function CityBase({ map }: { map: MapData }) {
  const look = useLook();
  const g = useMemo(() => ({
    water: flatShapes(map.water, 0.001),
    parks: flatShapes([...map.parks, ...map.stadiums], 0.002),
    minor: roadGeometry(map.roads, ['minor', 'service', 'path']),
    major: roadGeometry(map.roads, ['major']),
    freeway: roadGeometry(map.roads, ['freeway']),
    buildings: buildingGeometry(map.buildings, look),
  }), [map, look]);
  useEffect(() => () => Object.values(g).forEach((x) => x?.dispose()), [g]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[14, 14]} /><meshStandardMaterial color={look.ground} />
      </mesh>
      {g.water && <mesh geometry={g.water}><meshStandardMaterial color={look.water} roughness={0.25} metalness={0.1} /></mesh>}
      {g.parks && <mesh geometry={g.parks} receiveShadow><meshStandardMaterial color={look.park} /></mesh>}
      <mesh geometry={g.minor} receiveShadow><meshStandardMaterial color={look.roadMinor} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={g.major} receiveShadow><meshStandardMaterial color={look.roadMajor} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={g.freeway}><meshStandardMaterial color={look.freeway} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={g.buildings} castShadow receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- places

function Label({ at, children, tone = 'faint', z = 4 }: { at: [number, number, number]; children: React.ReactNode;
  tone?: 'faint' | 'secondary' | 'primary'; z?: number }) {
  const look = useLook();
  const color = tone === 'primary' ? look.labelStrong : look.label;
  const weight = tone === 'faint' ? '' : 'font-semibold';
  return (
    <Html position={at} center zIndexRange={[z, 0]}>
      <div className={`pointer-events-none whitespace-nowrap text-2xs font-medium tracking-wide ${weight}`}
        style={{ color, textShadow: `0 0 4px ${look.bg}, 0 0 8px ${look.bg}` }}>{children}</div>
    </Html>
  );
}

function Hub({ data, compact }: { data: CityData; compact?: boolean }) {
  const hub = data.depots.find((d) => d.depot_id === 'HUB');
  const ring = useRef<THREE.Mesh>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useFrame(({ clock }) => {
    if (!ring.current || reduce) return;
    const t = (clock.elapsedTime % 2.4) / 2.4;
    ring.current.scale.setScalar(1 + t * 2.2);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t);
  });
  if (!hub) return null;
  const k = data.kitchen;
  return (
    <group position={W(hub.x, hub.y)}>
      <mesh position={[0, 0.09, 0]} castShadow>
        <boxGeometry args={[0.42, 0.18, 0.32]} />
        <meshStandardMaterial color={token('scene-hub')} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.75, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 1.3, 8]} />
        <meshBasicMaterial color={token('scene-hub')} />
      </mesh>
      <mesh position={[0, 1.42, 0]}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshBasicMaterial color={token('scene-hub')} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <circleGeometry args={[0.55, 48]} />
        <meshBasicMaterial color={token('scene-hub')} transparent opacity={0.16} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <ringGeometry args={[0.3, 0.34, 48]} />
        <meshBasicMaterial color={token('scene-hub')} transparent opacity={0.5} />
      </mesh>
      <Html position={[0, 1.62, 0]} center zIndexRange={[40, 20]}>
        <div className="pointer-events-none whitespace-nowrap rounded-chip bg-surface-solid border border-line-strong shadow-overlay px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-xs text-ink-primary font-semibold">
            <span className="w-2 h-2 rounded-pill" style={{ background: 'var(--scene-hub)' }} />SliceBot Kitchen Hub
          </div>
          {!compact && (
            <div className="text-xs text-ink-secondary mt-0.5 tabular-nums">
              {hub.address} · {k.preparing.length} in oven · {k.ready.length} waiting · {k.on_road.length} on the road
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

function Depots({ data }: { data: CityData }) {
  return (
    <group>
      {data.depots.filter((d) => d.kind !== 'warehouse').map((d) => (
        <group key={d.depot_id} position={W(d.x, d.y)}>
          <mesh position={[0, 0.07, 0]} castShadow>
            <boxGeometry args={[0.3, 0.14, 0.24]} />
            <meshStandardMaterial color={token('map-depot')} roughness={0.7} />
          </mesh>
          <Label at={[0, 0.34, 0]} tone="secondary" z={6}>{d.name}</Label>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- routes and robots

// Deliveries glow blue; runners and stalled robots glow gold. No red: a stall is a delay, not an alarm.
const routeColor = (look: MapLook, kind: Route['kind']) =>
  kind === 'backup' ? look.backup : kind === 'runner' ? look.runner : kind === 'stalled' ? look.stalled : look.route;

/** A street route drawn as one smooth curve: a wide soft glow under a bright core, ending in a drop pin. */
function RouteLine({ route, emphasis }: { route: Route; emphasis: boolean }) {
  const look = useLook();
  const pts = useMemo(() => {
    const raw = route.path.map(([x, y]) => new THREE.Vector3(...W(x, y, 0.04)));
    if (raw.length < 3) return raw;
    // Centripetal Catmull-Rom rounds the corners without swinging wide of the street.
    return new THREE.CatmullRomCurve3(raw, false, 'centripetal').getPoints(Math.min(400, raw.length * 6));
  }, [route.path]);
  if (pts.length < 2) return null;
  const end = route.path[route.path.length - 1];
  const dest = route.kind === 'return' ? null : end;
  const color = routeColor(look, route.kind);
  const faint = route.kind === 'return';
  return (
    <group>
      <Line points={pts} color={color} lineWidth={emphasis ? 8 : 5} transparent opacity={faint ? 0.05 : emphasis ? 0.2 : 0.1}
        toneMapped={false} depthWrite={false} />
      <Line points={pts} color={color} lineWidth={emphasis ? 2.6 : 1.8} transparent opacity={faint ? 0.35 : emphasis ? 1 : 0.7}
        toneMapped={false} dashed={route.kind === 'stalled' || faint} dashSize={0.08} gapSize={0.06} />
      {dest && <DropPin at={dest} color={color} size={emphasis ? 1 : 0.75} />}
    </group>
  );
}

/** A map pin: a glossy head on a tapered stem, with a soft glow ring where it meets the street. */
function DropPin({ at, color, size = 1 }: { at: [number, number]; color: string; size?: number }) {
  const ring = useRef<THREE.Mesh>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useFrame(({ clock }) => {
    if (!ring.current || reduce) return;
    const t = (clock.elapsedTime % 2) / 2;
    ring.current.scale.setScalar(1 + t * 1.6);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - t);
  });
  return (
    <group position={W(at[0], at[1])} scale={size}>
      <mesh position={[0, 0.11, 0]} rotation={[Math.PI, 0, 0]} castShadow>
        <coneGeometry args={[0.035, 0.16, 20]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.22, 0]} castShadow>
        <sphereGeometry args={[0.055, 24, 24]} />
        <meshStandardMaterial color={color} roughness={0.3} metalness={0.1} emissive={color} emissiveIntensity={0.35} />
      </mesh>
      <mesh position={[0, 0.22, 0.045]}>
        <sphereGeometry args={[0.02, 12, 12]} />
        <meshBasicMaterial color={token('bot-shine')} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <circleGeometry args={[0.06, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.35} />
      </mesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <ringGeometry args={[0.06, 0.08, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

/** Position and heading along a polyline at distance `d` from its start. */
function along(path: [number, number][], cum: number[], d: number) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  const [x1, y1] = path[i - 1], [x2, y2] = path[i];
  // How far to the nearest corner, so the robot can slow down for it.
  const corner = Math.min(d - cum[i - 1], cum[i] - d);
  return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, heading: Math.atan2(y2 - y1, x2 - x1), corner };
}

function RobotAgent({ robot, contact, selected, highlight, onSelect, onContact, slot }: {
  robot: Robot; contact?: Contact; selected: boolean; highlight: boolean; onSelect: (r: Robot) => void;
  onContact: (c: Contact) => void; slot: number;
}) {
  const g = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const route = robot.route;
  const moving = !!route && route.kind !== 'stalled' && robot.status === 'active' && route.path.length > 1;
  const cum = useMemo(() => {
    const c = [0];
    route?.path.forEach((p, i) => i && c.push(c[i - 1] + Math.hypot(p[0] - route.path[i - 1][0], p[1] - route.path[i - 1][1])));
    return c;
  }, [route]);
  const total = cum[cum.length - 1] ?? 0;
  // Deliveries run out and back; a robot heading home starts on its way back.
  const nav = useRef({ d: (route?.progress ?? 0) * total, dir: 1, wait: 0, yaw: NaN });
  useEffect(() => { nav.current = { d: (route?.progress ?? 0) * total, dir: 1, wait: 0, yaw: NaN }; }, [route, total]);

  useFrame(({ clock }, dt) => {
    const n = nav.current;
    const step = Math.min(dt, 0.1);
    const p = route && route.path.length > 1 ? along(route.path, cum, n.d) : null;
    if (moving && !reduce && p) {
      if (n.wait > 0) n.wait -= step;
      else {
        // Ease out of a stop and into the next one, and take corners at walking pace.
        const toEnd = n.dir > 0 ? total - n.d : n.d;
        const fromStart = n.dir > 0 ? n.d : total - n.d;
        const ends = Math.min(1, 0.2 + Math.min(toEnd, fromStart) / 0.25);
        const corners = Math.min(1, 0.45 + p.corner / 0.1);
        n.d += n.dir * SPEED * Math.min(ends, corners) * step;
        if (n.d >= total) { n.d = total; n.dir = -1; n.wait = DWELL_S; }
        if (n.d <= 0) { n.d = 0; n.dir = 1; n.wait = DWELL_S; }
      }
    }
    if (g.current) {
      if (p) {
        g.current.position.set(...W(p.x, p.y));
        const target = n.dir > 0 ? p.heading : p.heading + Math.PI;
        if (Number.isNaN(n.yaw) || reduce) n.yaw = target;
        else {
          const diff = Math.atan2(Math.sin(target - n.yaw), Math.cos(target - n.yaw));
          n.yaw += diff * Math.min(1, step * TURN_RATE);
        }
        g.current.rotation.y = n.yaw;
      } else {
        // Parked at a depot or the Hub: fan out so robots don't stack.
        const ox = (slot % 3 - 1) * 0.16, oy = -0.2 - Math.floor(slot / 3) * 0.16;
        g.current.position.set(...W(robot.x + ox, robot.y + oy));
      }
    }
    if (ring.current) {
      const s = reduce ? 1 : 1 + 0.25 * Math.sin(clock.elapsedTime * 2.5);
      ring.current.scale.set(s, s, s);
    }
  });
  const look = useLook();
  const fault = robot.status === 'fault' || robot.status === 'grounded';
  const color = selected ? look.route : highlight ? token('status-warn') : robot.status === 'active' ? look.robot : token(STATUS_TOKEN[robot.status] ?? 'map-robot');
  const dot = contact?.decision === 'auto' ? 'bg-ok' : contact?.decision === 'human' ? 'bg-warn' : 'bg-accent';
  return (
    <group ref={g}
      onClick={(e) => { e.stopPropagation(); onSelect(robot); }}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}>
      <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.085, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} />
      </mesh>
      <group scale={0.95}><MiniRobot color={color} /></group>
      {(fault || selected || highlight) && (
        <mesh ref={ring} position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.13, 0.16, 32]} />
          <meshBasicMaterial color={selected ? look.route : token(highlight ? 'status-warn' : 'status-crit')} transparent opacity={0.9} />
        </mesh>
      )}
      {(selected || highlight) && <Label at={[0, 0.36, 0]} tone="primary" z={20}>{robot.robot_id}</Label>}
      {contact && (
        <Html position={[0, 0.42, 0]} center zIndexRange={[30, 10]}>
          <button onClick={() => onContact(contact)}
            className="block w-[200px] text-left rounded-chip bg-surface-solid border border-line-strong hover:border-line-hover
                       transition-colors duration-fast ease-out shadow-overlay px-3 py-2">
            <span className="flex items-center gap-1.5 text-2xs font-semibold text-ink-secondary tabular-nums">
              <span className={`w-1.5 h-1.5 rounded-pill ${dot}`} />{contact.contact_id} · {robot.robot_id}
            </span>
            <span className="block text-sm text-ink-primary leading-snug line-clamp-2">{contact.message}</span>
          </button>
        </Html>
      )}
    </group>
  );
}

/** A customer's message, pinned over their home. */
function HomeBubble({ contact, onContact }: { contact: CityData['contacts'][number]; onContact: (c: Contact) => void }) {
  if (!contact.home) return null;
  const dot = contact.decision === 'auto' ? 'bg-ok' : contact.decision === 'human' ? 'bg-warn' : 'bg-accent';
  return (
    <group>
      <DropPin at={[contact.home.x, contact.home.y]} color={token('map-pin-customer')} size={1.9} />
      <group position={W(contact.home.x, contact.home.y)}>
      <Html position={[0, 0.62, 0]} center zIndexRange={[35, 15]}>
        <button onClick={() => onContact(contact)}
          className="relative block w-[260px] text-left rounded-card bg-surface-solid
                     border border-accent-line shadow-overlay px-3 py-2.5
                     hover:border-accent transition-colors duration-fast ease-out">
          <span className="flex items-center gap-1.5 mb-1">
            <span className="inline-flex items-center gap-1 text-2xs font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-pill bg-accent text-[var(--accent-ink)]">
              <MapPin size={10} strokeWidth={2.5} />Customer
            </span>
            <span className="flex items-center gap-1.5 text-2xs font-semibold text-ink-secondary tabular-nums">
              <span className={`w-1.5 h-1.5 rounded-pill ${dot}`} />{contact.customer_name?.split(' ')[0] ?? 'Customer'} · {contact.contact_id}
            </span>
          </span>
          <span className="block text-sm text-ink-primary leading-snug line-clamp-2">{contact.message}</span>
          {/* the card's pointer, down to the pin */}
          <span className="absolute left-1/2 -bottom-[6px] -translate-x-1/2 w-3 h-3 rotate-45 bg-[var(--surface-solid)] border-r border-b border-accent-line" />
        </button>
      </Html>
      </group>
    </group>
  );
}

export interface CityFocus { robots?: string[]; contactId?: string | null }

/** Where a robot is now: partway along its route, or parked. */
export function whereIs(r: Robot) {
  const p = r.route?.path;
  if (!p || p.length < 2) return { x: r.x, y: r.y };
  const seg = p.slice(1).map((q, i) => Math.hypot(q[0] - p[i][0], q[1] - p[i][1]));
  let d = (r.route!.progress ?? 0) * seg.reduce((a, b) => a + b, 0);
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i]) { const t = seg[i] ? d / seg[i] : 0; return { x: p[i][0] + (p[i + 1][0] - p[i][0]) * t, y: p[i][1] + (p[i + 1][1] - p[i][1]) * t }; }
    d -= seg[i];
  }
  return { x: p[p.length - 1][0], y: p[p.length - 1][1] };
}

/** Rain over the city: a few thousand short streaks falling through a box around the view. */
function Rain({ count = 2600 }: { count?: number }) {
  const ref = useRef<THREE.LineSegments>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 16, y = Math.random() * 7, z = (Math.random() - 0.5) * 16;
      pos.set([x, y, z, x + 0.02, y - 0.16, z], i * 6);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }, [count]);
  useEffect(() => () => geo.dispose(), [geo]);
  useFrame((_, dt) => {
    if (reduce) return;
    const a = geo.attributes.position as THREE.BufferAttribute;
    const p = a.array as Float32Array;
    const fall = Math.min(dt, 0.05) * 7;
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      p[o + 1] -= fall; p[o + 4] -= fall; p[o] += fall * 0.12; p[o + 3] += fall * 0.12;
      if (p[o + 4] < 0) { const y = 6 + Math.random(); p[o + 1] = y; p[o + 4] = y - 0.16; p[o] = (Math.random() - 0.5) * 16; p[o + 3] = p[o] + 0.02; }
    }
    a.needsUpdate = true;
  });
  return (
    <lineSegments ref={ref} geometry={geo}>
      <lineBasicMaterial color={token('map-route-glow')} transparent opacity={0.32} depthWrite={false} />
    </lineSegments>
  );
}

/** The first time the city opens this session, the camera drops in from high over the Capitol and settles on the view. */
let introPlayed = false;
function CameraIntro() {
  const { camera, controls } = useThree() as unknown as { camera: THREE.Camera; controls: { target: THREE.Vector3; update: () => void;
    addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } | null };
  const t = useRef<number | null>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const from = useMemo(() => new THREE.Vector3(-2.6, 15, 1.2), []);
  const to = useMemo(() => camera.position.clone(), [camera]);
  useEffect(() => {
    if (introPlayed || reduce || !controls) return;
    introPlayed = true;
    camera.position.copy(from); controls.update();
    t.current = 0;
    const stop = () => { t.current = null; };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);
  useFrame((_, dt) => {
    if (t.current == null || !controls) return;
    t.current = Math.min(1, t.current + dt / 2.6);
    const k = 1 - Math.pow(1 - t.current, 3);
    camera.position.lerpVectors(from, to, k);
    controls.update();
    if (t.current >= 1) t.current = null;
  });
  return null;
}

/** Glides the camera to a point on the map (grid x, y) when `to` changes; letting go of it is as easy as dragging. */
function CameraRig({ to }: { to?: { x: number; y: number; key: string } | null }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.Camera; controls: { target: THREE.Vector3; update: () => void;
    addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } | null };
  const goal = useRef<{ target: THREE.Vector3; pos: THREE.Vector3 } | null>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useEffect(() => {
    if (!to || !controls) return;
    const target = new THREE.Vector3(...W(to.x, to.y));
    // Keep the current viewing angle, closer in.
    const dir = camera.position.clone().sub(controls.target).normalize();
    goal.current = { target, pos: target.clone().add(dir.multiplyScalar(5.5)) };
    const cancel = () => { goal.current = null; };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [to?.key, controls]);
  useFrame((_, dt) => {
    const g = goal.current;
    if (!g || !controls) return;
    const k = reduce ? 1 : Math.min(1, dt * 3);
    controls.target.lerp(g.target, k);
    camera.position.lerp(g.pos, k);
    controls.update();
    if (camera.position.distanceTo(g.pos) < 0.01) goal.current = null;
  });
  return null;
}

export function CityScene({ data, map, selected, onSelect, onContact, focus, compact, flyTo, light = 'night', rain = false }: {
  data: CityData; map: MapData; selected: string | null; onSelect: (r: Robot | null) => void; onContact: (c: Contact) => void;
  focus?: CityFocus; compact?: boolean; flyTo?: { x: number; y: number; key: string } | null; light?: Light; rain?: boolean;
}) {
  const look = mapLook(light);
  const byRobot = useMemo(() => {
    const m = new Map<string, Contact>();
    if (focus) return m;
    for (const c of data.contacts) if (c.robot_id && !m.has(c.robot_id) && c.decision == null) m.set(c.robot_id, c);
    return m;
  }, [data.contacts, focus]);
  const parked = useMemo(() => {
    const slots = new Map<string, number>(), seen = new Map<string, number>();
    for (const r of data.robots) {
      if (r.route) continue;
      const key = `${r.x.toFixed(1)},${r.y.toFixed(1)}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      slots.set(r.robot_id, n);
    }
    return slots;
  }, [data.robots]);
  const hot = new Set(focus?.robots ?? []);
  const focusContact = focus?.contactId ? data.contacts.find((c) => c.contact_id === focus.contactId) : undefined;
  return (
    <LookCtx.Provider value={look}>
    <Canvas shadows flat dpr={[1, 2]} camera={{ position: [1.2, 6.6, 10.6], fov: 40 }} onPointerMissed={() => onSelect(null)}
      style={{ background: look.bg, transition: 'background-color 600ms' }}>
      {/* the city fades into the sky at the far edge, which sells the perspective */}
      <fog attach="fog" args={[look.bg, 11, 24]} />
      <hemisphereLight args={[look.sky, look.ground, look.hemiI]} />
      <ambientLight intensity={look.ambientI} />
      <directionalLight position={look.sunPos} intensity={look.sunI} color={look.sun} castShadow shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-8} shadow-camera-right={8} shadow-camera-top={8} shadow-camera-bottom={-8} shadow-bias={-0.0005} />
      <directionalLight position={[-8, 6, -4]} intensity={light === 'day' ? 0.35 : 0.55} color={look.fill} />
      <CityBase map={map} />
      {rain && <Rain />}
      <CameraIntro />
      {map.landmarks.map((l) => <Label key={l.name} at={W(l.x, l.y, 0.5)}>{l.name}</Label>)}
      {!compact && Object.entries(data.zones).map(([name, [x0, x1, y0, y1]]) => (
        <Label key={name} at={W((x0 + x1) / 2, y1 - 0.45 - (y0 === 0 ? 0 : 0), 0.05)} tone="secondary">{name}</Label>
      ))}
      <Hub data={data} compact={compact} />
      <Depots data={data} />
      {data.robots.map((r) => r.route && (
        <RouteLine key={`route-${r.robot_id}`} route={r.route} emphasis={hot.has(r.robot_id) || selected === r.robot_id} />
      ))}
      {data.robots.map((r) => (
        <RobotAgent key={r.robot_id} robot={r} slot={parked.get(r.robot_id) ?? 0} contact={byRobot.get(r.robot_id)}
          selected={selected === r.robot_id} highlight={hot.has(r.robot_id)} onSelect={onSelect} onContact={onContact} />
      ))}
      {focusContact && <HomeBubble contact={focusContact} onContact={onContact} />}
      <CameraRig to={flyTo} />
      <OrbitControls makeDefault target={[0.4, 0, 0.4]} enablePan screenSpacePanning={false} minDistance={2.5} maxDistance={16}
        maxPolarAngle={1.25} minPolarAngle={0.25} />
    </Canvas>
    </LookCtx.Provider>
  );
}
