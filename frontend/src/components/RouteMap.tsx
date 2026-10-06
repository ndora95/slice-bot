/* The customer's live tracker: a daytime street plan cropped to their delivery, the route their robot is driving, the robot
 * itself creeping toward the door, and a pin on their home. The part of the route already driven fades to crust; the rest
 * stays tomato. Colors are the --minimap-* tokens, read from this element, so it follows the light theme it sits in. */
import { useEffect, useRef } from 'react';
import type { MapData } from '../lib/types';
import { useCityMap } from '../three/City';

type Pt = [number, number];

export function RouteMap({ path, progress, label, className = '' }: { path: Pt[]; progress: number; label?: string; className?: string }) {
  const map = useCityMap();
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ path, progress, label });
  live.current = { path, progress, label };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !map) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const css = (n: string) => getComputedStyle(canvas).getPropertyValue(n).trim();
    let raf = 0;
    let shown = live.current.progress; // the robot's drawn position, easing toward the real one
    const draw = (t: number) => {
      const { path, progress, label } = live.current;
      const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = {
        bg: css('--minimap-bg'), road: css('--minimap-road'), major: css('--minimap-road-major'), water: css('--minimap-water'),
        park: css('--minimap-park'), route: css('--minimap-route'), done: css('--minimap-route-done'), home: css('--minimap-home'),
        hub: css('--minimap-hub'), text: css('--text-primary'), panel: css('--surface-panel'),
      };
      ctx.fillStyle = c.bg; ctx.fillRect(0, 0, w, h);
      if (path.length < 2) return;
      // fit the route with a margin, north up
      const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const s = Math.min((w - 80) / Math.max(0.4, x1 - x0), (h - 70) / Math.max(0.4, y1 - y0));
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const px = ([x, y]: Pt): Pt => [w / 2 + (x - cx) * s, h / 2 - (y - cy) * s + 6];
      const poly = (pts: Pt[]) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = px(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); };
      ctx.fillStyle = c.water; (map as MapData).water.forEach((p) => { poly(p as Pt[]); ctx.fill(); });
      ctx.fillStyle = c.park; map.parks.forEach((p) => { poly(p as Pt[]); ctx.fill(); });
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [kinds, color, width] of [[['service', 'minor'], c.road, 3.5], [['major', 'freeway'], c.major, 6]] as const) {
        ctx.strokeStyle = color; ctx.lineWidth = width;
        map.roads.forEach((r) => { if ((kinds as readonly string[]).includes(r.k)) { poly(r.p as Pt[]); ctx.stroke(); } });
      }
      // where along the route the robot is
      const seg = [0];
      for (let i = 1; i < path.length; i++) seg.push(seg[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
      const total = seg[seg.length - 1] || 1;
      shown += reduce ? progress - shown : (progress - shown) * 0.04;
      const d = shown * total;
      let i = 1;
      while (i < seg.length - 1 && seg[i] < d) i++;
      const f = Math.min(1, Math.max(0, (d - seg[i - 1]) / ((seg[i] - seg[i - 1]) || 1)));
      const at: Pt = [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f];
      // driven, then still to go
      ctx.strokeStyle = c.done; ctx.lineWidth = 5; poly([...path.slice(0, i), at]); ctx.stroke();
      ctx.strokeStyle = c.route; ctx.lineWidth = 5; poly([at, ...path.slice(i)]); ctx.stroke();
      // start
      const [sx, sy] = px(path[0]);
      ctx.fillStyle = c.panel; ctx.strokeStyle = c.done; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // home pin
      const [hx, hy] = px(path[path.length - 1]);
      ctx.fillStyle = c.home;
      ctx.beginPath(); ctx.arc(hx, hy - 16, 9, Math.PI, 0); ctx.lineTo(hx, hy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = c.panel; ctx.beginPath(); ctx.arc(hx, hy - 16, 3.5, 0, Math.PI * 2); ctx.fill();
      // the robot: a soft pulse and a solid puck
      const [rx, ry] = px(at);
      const ph = reduce ? 0.3 : (t / 1600) % 1;
      ctx.globalAlpha = 0.35 * (1 - ph); ctx.fillStyle = c.route;
      ctx.beginPath(); ctx.arc(rx, ry, 9 + ph * 16, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = c.panel; ctx.beginPath(); ctx.arc(rx, ry, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.route; ctx.beginPath(); ctx.arc(rx, ry, 7, 0, Math.PI * 2); ctx.fill();
      if (label) {
        ctx.font = '600 12px "Inter Variable", Inter, system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        const bx = Math.min(w - tw - 22, Math.max(6, rx - tw / 2 - 8)), by = ry - 36;
        ctx.fillStyle = c.panel; ctx.strokeStyle = c.done; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(bx, by, tw + 16, 22, 11); ctx.fill(); ctx.stroke();
        ctx.fillStyle = c.text; ctx.fillText(label, bx + 8, by + 15);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [map]);

  return <canvas ref={ref} aria-hidden className={`block w-full ${className}`} />;
}
