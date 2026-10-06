import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { City, MapData, Role } from '../lib/types';

/**
 * The delivery area's real streets, full-bleed behind the sign-in, with the fleet driving them. Two layers:
 *   ambient  thirty time-lapse dots wandering the grid, so the city always feels busy;
 *   live     the real robots, routes, depots, and customer pins from /api/city.
 * Hovering a seat focuses the live layer on what that person watches, and a 2D camera glides there:
 *   customer    her robot's route to her door        specialist  the homes of cases waiting on a person
 *   head        every route at once                  repair_lead robots off the road, and the depots
 *   mechanic    a slow push in on Navy Yard Depot
 * `leaving` dives the camera into the city as the console takes over. Drawing is plain canvas, every frame.
 */
const HUB: Pt = [7.71, 4.688];
const HOME_VIEW = { gx: 7.1, gy: 5.5, z: 1 };
const ROBOTS = 30;
const TRAIL = 34;      // trail points, one per 3 px travelled
const SPEED = 0.18;    // grid units per second (200 m per unit): an unhurried time-lapse

type Pt = [number, number];
interface Road { p: Pt[]; len: number; seg: number[] }
interface Bot { road: number; dir: 1 | -1; d: number; trail: Pt[]; head?: Pt; speed: number }
interface Cam { gx: number; gy: number; z: number }
type Focus = Role | null;
/** How strongly each live layer shows, per focus. Values ease toward these every frame. */
type Emph = { ambient: number; routes: number; routesHot: number; mine: number; homes: number; faults: number; depots: number; depotHot: number };

const EMPH: Record<Role | 'none', Emph> = {
  none:        { ambient: 1,    routes: 0.45, routesHot: 0, mine: 0, homes: 0.25, faults: 0.25, depots: 0.45, depotHot: 0 },
  customer:    { ambient: 0.35, routes: 0.15, routesHot: 0, mine: 1, homes: 0,    faults: 0,    depots: 0.2,  depotHot: 0 },
  specialist:  { ambient: 0.45, routes: 0.25, routesHot: 0, mine: 0, homes: 1,    faults: 0.2,  depots: 0.2,  depotHot: 0 },
  head:        { ambient: 0.6,  routes: 0.4,  routesHot: 1, mine: 0, homes: 0.5,  faults: 0.5,  depots: 0.5,  depotHot: 0 },
  repair_lead: { ambient: 0.35, routes: 0.15, routesHot: 0, mine: 0, homes: 0,    faults: 1,    depots: 1,    depotHot: 0.6 },
  mechanic:    { ambient: 0.35, routes: 0.15, routesHot: 0, mine: 0, homes: 0,    faults: 0.5,  depots: 0.6,  depotHot: 1 },
};

const key = ([x, y]: Pt) => `${Math.round(x * 50)},${Math.round(y * 50)}`;

function prepare(map: MapData) {
  const roads: Road[] = map.roads.filter((r) => r.k !== 'path' && r.p.length > 1).map((r) => {
    const seg = [0];
    for (let i = 1; i < r.p.length; i++) seg.push(seg[i - 1] + Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]));
    return { p: r.p, len: seg[seg.length - 1], seg };
  });
  const ends = new Map<string, number[]>();
  roads.forEach((r, i) => [r.p[0], r.p[r.p.length - 1]].forEach((e) => {
    const k = key(e); ends.set(k, [...(ends.get(k) ?? []), i]);
  }));
  return { roads, ends };
}

function at(r: { p: Pt[]; seg: number[] }, d: number): Pt {
  let i = 1;
  while (i < r.seg.length - 1 && r.seg[i] < d) i++;
  const span = r.seg[i] - r.seg[i - 1] || 1, t = Math.min(1, Math.max(0, (d - r.seg[i - 1]) / span));
  const [a, b] = [r.p[i - 1], r.p[i]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

const withSeg = (p: Pt[]) => {
  const seg = [0];
  for (let i = 1; i < p.length; i++) seg.push(seg[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  return { p, seg, len: seg[seg.length - 1] };
};

function css(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Where the camera goes for a seat, from the live data. */
function camFor(focus: Focus, city: City | null, mine: string | null): Cam {
  if (!city || !focus) return HOME_VIEW;
  const robot = (id: string | null) => city.robots.find((r) => r.robot_id === id);
  const fit = (pts: Pt[], zMax: number): Cam => {
    if (!pts.length) return HOME_VIEW;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * 1.45, 1.2);
    return { gx: (Math.min(...xs) + Math.max(...xs)) / 2, gy: (Math.min(...ys) + Math.max(...ys)) / 2 - 0.1, z: Math.min(zMax, Math.max(0.85, 5.6 / span)) };
  };
  if (focus === 'customer') { const r = robot(mine); return r?.route ? fit(r.route.path, 2.2) : HOME_VIEW; }
  if (focus === 'specialist') {
    const homes = city.contacts.filter((c) => c.home && c.decision === 'human' && !c.resolved_by).map((c) => [c.home!.x, c.home!.y] as Pt);
    return fit([...homes, HUB], 1.6);
  }
  if (focus === 'head') return { ...HOME_VIEW, z: 0.82 };
  if (focus === 'repair_lead') {
    const down = city.robots.filter((r) => ['fault', 'grounded', 'in_repair'].includes(r.status)).map((r) => [r.x, r.y] as Pt);
    return fit([...down, ...city.depots.filter((d) => d.kind === 'repair').map((d) => [d.x, d.y] as Pt)], 1.4);
  }
  const yard = city.depots.find((d) => d.depot_id === 'SOUTH');
  return yard ? { gx: yard.x - 0.2, gy: yard.y + 0.35, z: 1.9 } : HOME_VIEW;
}

export default function StreetField({ reduce, focus = null, city = null, mine = null, mineLabel = 'Customer', leaving = false, anchorX }: {
  reduce: boolean; focus?: Focus; city?: City | null; mine?: string | null; mineLabel?: string; leaving?: boolean;
  /** Where on screen (0..1 of width) the camera centre sits; the sign-in panel covers the left. */
  anchorX?: (w: number) => number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ focus, city, mine, mineLabel, leaving, anchorX });
  live.current = { focus, city, mine, mineLabel, leaving, anchorX };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0, alive = true, cleanup = () => {};

    api.get<MapData>('/api/map').then((map) => {
      if (!alive) return;
      const { roads, ends } = prepare(map);
      let driveable: number[] = [];
      let w = 0, h = 0, dpr = 1, S = 1, ax = 0, ay = 0;
      const cam: Cam = { ...HOME_VIEW };
      const emph: Emph = { ...EMPH.none };
      const toPx = ([x, y]: Pt): Pt => [ax + (x - cam.gx) * S * cam.z, ay - (y - cam.gy) * S * cam.z];

      const colors = () => ({
        bg: css(canvas, '--map-bg'), minor: css(canvas, '--map-road-minor'), major: css(canvas, '--map-road-major'),
        water: css(canvas, '--map-water'), park: css(canvas, '--map-park'), bot: css(canvas, '--accent-bright'),
        hub: css(canvas, '--accent'), glow: css(canvas, '--map-route-glow'), route: css(canvas, '--map-route'),
        backup: css(canvas, '--map-route-backup'), runner: css(canvas, '--map-route-runner'), crit: css(canvas, '--status-crit'),
        warn: css(canvas, '--status-warn'), depot: css(canvas, '--map-depot'), label: css(canvas, '--map-label'),
        strong: css(canvas, '--map-label-strong'), robot: css(canvas, '--map-robot'),
      });
      let c = colors();

      const resize = () => {
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        w = canvas.clientWidth; h = canvas.clientHeight;
        canvas.width = w * dpr; canvas.height = h * dpr;
        ax = live.current.anchorX ? live.current.anchorX(w) : w / 2; ay = h * 0.5;
        S = Math.max(Math.min(w - (w > 900 ? 480 : 0), 1400) / 8.5, h / 7.2);
        const inView = ([x, y]: Pt) => x > -20 && x < w + 20 && y > -20 && y < h + 20;
        driveable = roads.map((r, i) => (r.len > 0.15 && r.p.some((q) => inView(toPx(q))) ? i : -1)).filter((i) => i >= 0);
        if (!driveable.length) driveable = roads.map((_, i) => i);
      };
      const offScreen = ([x, y]: Pt) => x < -60 || x > w + 60 || y < -60 || y > h + 60;

      // ambient bots live in grid space, so they ride the camera like everything else
      const spawn = (b?: Bot): Bot => {
        const road = driveable[Math.floor(Math.random() * driveable.length)];
        const dir = Math.random() < 0.5 ? 1 : -1;
        return { road, dir, d: dir === 1 ? 0 : roads[road].len, trail: b?.trail.slice(-1) ?? [], speed: SPEED * (0.7 + Math.random() * 0.6) };
      };
      const bots: Bot[] = [];
      const step = (b: Bot, dt: number) => {
        const r = roads[b.road];
        b.d += b.dir * b.speed * dt;
        if (b.d < 0 || b.d > r.len) {
          const end = b.dir === 1 ? r.p[r.p.length - 1] : r.p[0];
          const next = (ends.get(key(end)) ?? []).filter((i) => i !== b.road && roads[i].len > 0.05);
          if (!next.length) { Object.assign(b, spawn(), { trail: [] }); return; }
          const n = next[Math.floor(Math.random() * next.length)];
          const startsHere = key(roads[n].p[0]) === key(end);
          b.road = n; b.dir = startsHere ? 1 : -1; b.d = startsHere ? 0 : roads[n].len;
        }
        const g = at(roads[b.road], b.d), prev = b.trail[b.trail.length - 1];
        if (offScreen(toPx(g))) { Object.assign(b, spawn(), { trail: [] }); return; }
        b.head = g;
        if (!prev || Math.hypot(g[0] - prev[0], g[1] - prev[1]) * S >= 3) b.trail.push(g);
        if (b.trail.length > TRAIL) b.trail.shift();
      };

      // real routes, with their own runner position so the live robots drive too
      let routes: { id: string; kind: string; path: ReturnType<typeof withSeg>; d: number; dir: number }[] = [];
      let routesFor: City | null = null;
      const syncRoutes = (city: City | null) => {
        if (city === routesFor) return;
        routesFor = city;
        routes = (city?.robots ?? []).filter((r) => r.route && r.route.path.length > 1 && r.route.kind !== 'stalled').map((r) => {
          const path = withSeg(r.route!.path as Pt[]);
          return { id: r.robot_id, kind: r.route!.kind, path, d: (r.route!.progress ?? 0) * path.len, dir: 1 };
        });
      };

      const line = (pts: Pt[], color: string, width: number, alpha: number, blur = 0) => {
        if (alpha <= 0.01 || pts.length < 2) return;
        ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if (blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
        ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = toPx(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
        ctx.restore();
      };
      const ring = (p: Pt, color: string, r: number, alpha: number, t: number, period = 2) => {
        if (alpha <= 0.01) return;
        const [x, y] = toPx(p);
        const ph = reduce ? 0.4 : (t / (period * 1000)) % 1;
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.globalAlpha = alpha * (1 - ph); ctx.beginPath(); ctx.arc(x, y, r + ph * r * 3, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(x, y, r * 0.75, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
      const label = (p: Pt, text: string, alpha: number, color = c.strong, dy = -14) => {
        if (alpha <= 0.05) return;
        const [x, y] = toPx(p);
        ctx.save(); ctx.globalAlpha = alpha; ctx.font = '600 11px "Inter Variable", Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = c.bg; ctx.strokeText(text, x, y + dy); ctx.fillStyle = color; ctx.fillText(text, x, y + dy);
        ctx.restore();
      };

      const draw = (t: number) => {
        const L = live.current;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const poly = (pts: Pt[]) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = toPx(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); };
        ctx.fillStyle = c.water; map.water.forEach((p) => { poly(p as Pt[]); ctx.fill(); });
        ctx.fillStyle = c.park; map.parks.forEach((p) => { poly(p as Pt[]); ctx.fill(); });
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.save(); ctx.globalAlpha = 0.12; ctx.strokeStyle = c.glow; ctx.lineWidth = 6 * Math.sqrt(cam.z);
        map.roads.forEach((r) => { if (r.k === 'major' || r.k === 'freeway') { poly(r.p as Pt[]); ctx.stroke(); } });
        ctx.restore();
        for (const [kinds, color, width] of [[['service', 'minor'], c.minor, 1.1], [['major', 'freeway'], c.major, 1.9]] as const) {
          ctx.strokeStyle = color; ctx.lineWidth = width * Math.sqrt(cam.z);
          map.roads.forEach((r) => { if ((kinds as readonly string[]).includes(r.k)) { poly(r.p as Pt[]); ctx.stroke(); } });
        }

        // ambient trails
        ctx.lineCap = 'butt';
        for (const b of bots) {
          const tr = b.trail;
          for (let i = 1; i < tr.length; i++) {
            ctx.globalAlpha = (i / tr.length) * 0.5 * emph.ambient;
            ctx.strokeStyle = c.bot; ctx.lineWidth = 2;
            const [x0, y0] = toPx(tr[i - 1]), [x1, y1] = toPx(tr[i]);
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          }
          if (b.head) {
            const [x, y] = toPx(b.head);
            ctx.globalAlpha = 0.9 * emph.ambient; ctx.fillStyle = c.bot; ctx.shadowColor = c.bot; ctx.shadowBlur = 10;
            ctx.beginPath(); ctx.arc(x, y, 2.3, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
          }
        }
        ctx.globalAlpha = 1;

        // live routes and robots
        const city = L.city;
        for (const r of routes) {
          const isMine = r.id === L.mine;
          const color = isMine ? c.hub : r.kind === 'backup' ? c.backup : r.kind === 'runner' ? c.runner : c.glow;
          const a = isMine ? Math.max(emph.routes, emph.mine) : emph.routes + emph.routesHot * 0.6;
          const hot = isMine ? emph.mine : emph.routesHot;
          line(r.path.p, color, 2 + hot * 1.8, Math.min(1, a), hot * 14);
          const pos = at(r.path, r.d);
          const [x, y] = toPx(pos);
          ctx.save(); ctx.globalAlpha = Math.min(1, 0.5 + a); ctx.fillStyle = isMine && emph.mine > 0.3 ? c.hub : c.robot;
          ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8 + hot * 10;
          ctx.beginPath(); ctx.arc(x, y, 3.2 + hot * 1.6, 0, Math.PI * 2); ctx.fill(); ctx.restore();
          if (isMine) {
            const end = r.path.p[r.path.p.length - 1];
            ring(end, c.hub, 5, emph.mine, t, 1.6);
            label(end, L.mineLabel, emph.mine, c.strong, -16);
            label(pos, `${r.id} · her pizza`, emph.mine, c.strong, -12);
          } else if (emph.routesHot > 0.3) label(pos, r.id, emph.routesHot * 0.8, c.label, -10);
        }
        if (city) {
          for (const ct of city.contacts) {
            if (!ct.home) continue;
            const waiting = ct.decision === 'human' && !ct.resolved_by;
            ring([ct.home.x, ct.home.y], waiting ? c.warn : c.label, waiting ? 5 : 3, waiting ? emph.homes : emph.homes * 0.35, t, 1.4);
            if (waiting) label([ct.home.x, ct.home.y], `${ct.contact_id} · needs a person`, emph.homes);
          }
          for (const r of city.robots) {
            if (!['fault', 'grounded', 'in_repair'].includes(r.status)) continue;
            ring([r.x, r.y], r.status === 'in_repair' ? c.warn : c.crit, 4.5, emph.faults, t, 1.8);
            label([r.x, r.y], `${r.robot_id} · ${r.status.replace('_', ' ')}`, emph.faults > 0.6 ? emph.faults : 0, c.strong, 22);
          }
          for (const d of city.depots) {
            if (d.kind !== 'repair') continue;
            const hot = d.depot_id === 'SOUTH' ? emph.depotHot : emph.depotHot * 0.3;
            const [x, y] = toPx([d.x, d.y]);
            const s = 5 + hot * 4;
            ctx.save(); ctx.globalAlpha = Math.min(1, emph.depots + hot); ctx.fillStyle = c.depot; ctx.shadowColor = c.depot; ctx.shadowBlur = 6 + hot * 18;
            ctx.fillRect(x - s / 2, y - s / 2, s, s); ctx.restore();
            ring([d.x, d.y], c.depot, 6, hot, t, 2.2);
            label([d.x, d.y], d.name, Math.max(emph.depots > 0.8 ? emph.depots : 0, hot), c.strong, -14 - hot * 4);
          }
        }

        // the Kitchen Hub: a fixed point and one slow ring every 4 s
        const [hx, hy] = toPx(HUB);
        const phase = reduce ? 0 : (t / 4000) % 1;
        ctx.strokeStyle = c.hub; ctx.lineWidth = 1;
        if (!reduce) { ctx.globalAlpha = 0.5 * (1 - phase); ctx.beginPath(); ctx.arc(hx, hy, 6 + phase * 38, 0, Math.PI * 2); ctx.stroke(); }
        ctx.globalAlpha = 1; ctx.fillStyle = c.hub; ctx.shadowColor = c.hub; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(hx, hy, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
        label(HUB, 'SliceBot Kitchen', 0.85, c.strong, -12);
        ctx.globalAlpha = 1;
      };

      resize();
      for (let i = 0; i < ROBOTS; i++) { const b = spawn(); b.d = Math.random() * roads[b.road].len; bots.push(b); }
      for (let i = 0; i < 240; i++) bots.forEach((b) => step(b, 1 / 30));

      canvas.style.opacity = '1';
      let last = performance.now();
      const loop = (t: number) => {
        const dt = Math.min(0.05, (t - last) / 1000); last = t;
        const L = live.current;
        syncRoutes(L.city);
        // camera and emphasis ease toward the focus; a dive on leaving
        const goal = camFor(L.focus, L.city, L.mine);
        if (L.leaving) { goal.gx = HUB[0]; goal.gy = HUB[1]; goal.z = 3.4; }
        const k = reduce ? 1 : 1 - Math.exp(-dt * (L.leaving ? 3.2 : 2.6));
        cam.gx += (goal.gx - cam.gx) * k; cam.gy += (goal.gy - cam.gy) * k; cam.z += (goal.z - cam.z) * k;
        const target = EMPH[L.focus ?? 'none'];
        const ke = reduce ? 1 : 1 - Math.exp(-dt * 5);
        (Object.keys(emph) as (keyof Emph)[]).forEach((n) => { emph[n] += (target[n] - emph[n]) * ke; });
        if (!reduce) {
          bots.forEach((b) => step(b, dt));
          for (const r of routes) {
            r.d += r.dir * 0.12 * dt;
            if (r.d > r.path.len) { r.d = r.path.len; r.dir = -1; } else if (r.d < 0) { r.d = 0; r.dir = 1; }
          }
        }
        draw(t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      const ro = new ResizeObserver(() => {
        resize();
        bots.forEach((b) => { b.trail = b.head ? [b.head] : []; });
      });
      ro.observe(canvas);
      const scheme = window.matchMedia('(prefers-color-scheme: dark)');
      const recolor = () => { c = colors(); };
      scheme.addEventListener('change', recolor);
      cleanup = () => { ro.disconnect(); scheme.removeEventListener('change', recolor); };
    }).catch(() => { /* no map: the plain surface stands on its own */ });

    return () => { alive = false; cancelAnimationFrame(raf); cleanup(); };
  }, [reduce]);

  return <canvas ref={ref} aria-hidden className="absolute inset-0 w-full h-full opacity-0 transition-opacity duration-reveal ease-out" />;
}
