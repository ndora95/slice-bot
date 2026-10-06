/* Charts, per the dataviz specs: 2px lines, recessive hairline grid, one axis,
 * legend for 2+ series, crosshair + tooltip on hover, text in text tokens. */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SweepPoint, TimelineItem } from '../lib/types';
import { hoursOf } from '../lib/format';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-s4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-2 text-sm text-ink-secondary">
          <span className="w-3 h-0.5 rounded-pill" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Containment and auto-answer accuracy across confidence thresholds. */
export function SweepChart({ data, threshold, onPick, height = 300 }: {
  data: SweepPoint[]; threshold: number; onPick?: (t: number) => void; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<SweepPoint | null>(null);
  const h = height, pl = 40, pr = 16, pt = 12, pb = 28;
  const pts = data.filter((d) => d.threshold < 1);
  const x0 = pts[0]?.threshold ?? 0.5, x1 = pts[pts.length - 1]?.threshold ?? 0.975;
  const X = (t: number) => pl + ((t - x0) / (x1 - x0)) * (w - pl - pr);
  const Y = (v: number) => pt + (1 - v) * (h - pt - pb);
  // Accuracy is undefined where nothing is answered alone, so that line stops there instead of diving to 0.
  const line = (k: 'containment' | 'auto_accuracy') => pts.filter((d) => k === 'containment' || d.containment > 0)
    .map((d, i) => `${i ? 'L' : 'M'}${X(d.threshold)},${Y(d[k])}`).join('');
  const area = (k: 'containment' | 'auto_accuracy') => `${line(k)}L${X(x1)},${Y(0)}L${X(x0)},${Y(0)}Z`;
  const near = (px: number) => pts.reduce((a, b) => (Math.abs(X(b.threshold) - px) < Math.abs(X(a.threshold) - px) ? b : a), pts[0]);
  const cur = pts.reduce((a, b) => (Math.abs(b.threshold - threshold) < Math.abs(a.threshold - threshold) ? b : a), pts[0]);
  const show = hover ?? cur;
  return (
    <div className="flex flex-col gap-s3">
      <Legend items={[{ label: 'Containment (answered alone)', color: 'var(--viz-1)' },
                      { label: 'Accuracy of what it answered alone', color: 'var(--viz-2)' }]} />
      <div ref={ref} className="relative" style={{ height: h }}>
        <svg width={w} height={h} className="block select-none"
          onMouseMove={(e) => setHover(near(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onMouseLeave={() => setHover(null)}
          onClick={() => hover && onPick?.(hover.threshold)}
          role="img" aria-label="Containment and accuracy by confidence threshold">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={pl} x2={w - pr} y1={Y(v)} y2={Y(v)} stroke="var(--viz-grid)" strokeWidth={1} />
              <text x={pl - 8} y={Y(v) + 3} textAnchor="end" className="fill-ink-secondary font-mono" fontSize={10}>{v * 100}%</text>
            </g>
          ))}
          {pts.filter((_, i) => i % 4 === 0).map((d) => (
            <text key={d.threshold} x={X(d.threshold)} y={h - 8} textAnchor="middle" className="fill-ink-secondary font-mono" fontSize={10}>
              {d.threshold.toFixed(2)}
            </text>
          ))}
          <path d={area('containment')} fill="var(--viz-1)" opacity={0.08} />
          <path d={line('containment')} fill="none" stroke="var(--viz-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={line('auto_accuracy')} fill="none" stroke="var(--viz-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <line x1={X(threshold)} x2={X(threshold)} y1={pt} y2={h - pb} stroke="var(--accent-line)" strokeDasharray="3 3" />
          <line x1={X(show.threshold)} x2={X(show.threshold)} y1={pt} y2={h - pb} stroke="var(--hairline-strong)" />
          {(['containment', 'auto_accuracy'] as const).filter((k) => k === 'containment' || show.containment > 0).map((k, i) => (
            <circle key={k} cx={X(show.threshold)} cy={Y(show[k])} r={4.5} fill={i ? 'var(--viz-2)' : 'var(--viz-1)'}
              stroke="var(--surface-panel)" strokeWidth={2} />
          ))}
          <rect x={pl} y={pt} width={w - pl - pr} height={h - pt - pb} fill="transparent" />
        </svg>
        {hover && <div className="absolute pointer-events-none rounded-chip bg-surface-raised border border-line shadow-overlay px-s3 py-s2 text-sm"
          style={{ left: Math.min(w - 190, Math.max(0, X(show.threshold) + 12)), top: 8, width: 178 }}>
          <div className="font-mono text-xs text-ink-secondary uppercase tracking-wider mb-1">Threshold {show.threshold.toFixed(3)}</div>
          <Row c="var(--viz-1)" k="Containment" v={`${Math.round(show.containment * 100)}%`} />
          <Row c="var(--viz-2)" k="Accuracy alone" v={show.containment > 0 ? `${Math.round(show.auto_accuracy * 100)}%` : 'n/a'} />
          <div className="text-xs text-ink-secondary mt-1 font-mono">{show.wrong_auto} wrong answers sent alone</div>
        </div>}
      </div>
    </div>
  );
}

function Row({ c, k, v }: { c: string; k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-s2">
      <span className="inline-flex items-center gap-1.5 text-ink-secondary"><span className="w-2 h-2 rounded-pill" style={{ background: c }} />{k}</span>
      <span className="font-mono tabular-nums text-ink-primary">{v}</span>
    </div>
  );
}

/** Single-series line for telemetry. Optional reference line (e.g. the 57°C cold-food line). */
export function Sparkline({ values, labels, refLine, refLabel, unit = '', height = 64, color = 'var(--viz-1)' }: {
  values: number[]; labels?: string[]; refLine?: number; refLabel?: string; unit?: string; height?: number; color?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  if (!values.length) return null;
  const all = refLine != null ? [...values, refLine] : values;
  const lo = Math.min(...all), hiV = Math.max(...all);
  const pad = (hiV - lo) * 0.12 || 1;
  const X = (i: number) => 4 + (i / Math.max(1, values.length - 1)) * (w - 8);
  const Y = (v: number) => 6 + (1 - (v - lo + pad) / (hiV - lo + 2 * pad)) * (height - 12);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`).join('');
  const last = values.length - 1;
  const show = hi ?? last;
  return (
    <div ref={ref} className="relative">
      <svg width={w} height={height} className="block"
        onMouseMove={(e) => {
          const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
          setHi(Math.max(0, Math.min(last, Math.round(((px - 4) / (w - 8)) * last))));
        }}
        onMouseLeave={() => setHi(null)}>
        {refLine != null && (
          <>
            <line x1={0} x2={w} y1={Y(refLine)} y2={Y(refLine)} stroke="var(--status-crit)" strokeOpacity={0.5} strokeDasharray="3 3" />
            {refLabel && <text x={w - 4} y={Y(refLine) - 4} textAnchor="end" fontSize={9} className="fill-ink-secondary font-mono">{refLabel}</text>}
          </>
        )}
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={X(show)} cy={Y(values[show])} r={4} fill={color} stroke="var(--surface-panel)" strokeWidth={2} />
      </svg>
      <div className="absolute top-0 left-1 text-xs font-mono tabular-nums text-ink-primary">
        {values[show].toFixed(1)}{unit}
        {labels?.[show] && <span className="text-ink-secondary"> · {labels[show]}</span>}
      </div>
    </div>
  );
}

/** Lanes on a clock. Peak windows are shaded so the scheduler's choices are visible. */
export function Gantt({ items, from, to, peaks, now, laneOrder, renderLabel }: {
  items: TimelineItem[]; from: number; to: number; peaks?: { label: string; range: [number, number] }[];
  now?: number; laneOrder?: string[]; renderLabel?: (lane: string) => ReactNode;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const lanes = laneOrder ?? Array.from(new Set(items.map((i) => i.lane)));
  const labelW = 132, rowH = 30, axisH = 22;
  const X = (hr: number) => labelW + ((hr - from) / (to - from)) * (w - labelW - 24);
  const h = axisH + lanes.length * rowH + 4;
  const ticks = [];
  for (let t = Math.ceil(from); t <= to; t++) ticks.push(t);
  const fill: Record<string, string> = { repair: 'var(--accent)', transit: 'var(--hairline-strong)', pickup: 'var(--viz-1)' };
  return (
    <div ref={ref} className="relative overflow-x-auto">
      <svg width={w} height={h} className="block">
        {peaks?.map((p) => (
          <g key={p.label}>
            <rect x={X(Math.max(from, p.range[0]))} y={axisH} width={Math.max(0, X(Math.min(to, p.range[1])) - X(Math.max(from, p.range[0])))}
              height={h - axisH} fill="var(--viz-band)" />
            {p.range[0] < to && p.range[1] > from && (
              <text x={X(Math.max(from, p.range[0])) + 4} y={axisH + 11} fontSize={9} className="fill-warn-text font-mono uppercase">{p.label}</text>
            )}
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={X(t)} x2={X(t)} y1={axisH - 4} y2={h} stroke="var(--viz-grid)" />
            <text x={X(t)} y={12} textAnchor="middle" fontSize={10} className="fill-ink-secondary font-mono">{String(t).padStart(2, '0')}:00</text>
          </g>
        ))}
        {lanes.map((lane, i) => (
          <g key={lane}>
            <line x1={0} x2={w} y1={axisH + i * rowH} y2={axisH + i * rowH} stroke="var(--hairline)" />
            <foreignObject x={0} y={axisH + i * rowH} width={labelW - 8} height={rowH}>
              <div className="h-full flex items-center text-sm text-ink-emphasis truncate font-mono">{renderLabel ? renderLabel(lane) : lane}</div>
            </foreignObject>
          </g>
        ))}
        {items.map((it, k) => {
          const li = lanes.indexOf(it.lane);
          if (li < 0) return null;
          const a = X(Math.max(from, hoursOf(it.start))), b = X(Math.min(to, hoursOf(it.end)));
          const thin = it.kind === 'transit';
          return (
            <g key={k}>
              <title>{`${it.label} · ${it.start.slice(11, 16)}–${it.end.slice(11, 16)}`}</title>
              <rect x={a} y={axisH + li * rowH + (thin ? 12 : 6)} width={Math.max(3, b - a)} height={thin ? 6 : rowH - 12}
                rx={thin ? 3 : 4} fill={fill[it.kind] ?? 'var(--accent)'} opacity={it.kind === 'done' ? 0.45 : 1} />
            </g>
          );
        })}
        {now != null && now >= from && now <= to && (
          <g>
            <line x1={X(now)} x2={X(now)} y1={axisH - 6} y2={h} stroke="var(--accent-bright)" strokeWidth={1.5} />
            <circle cx={X(now)} cy={axisH - 6} r={3} fill="var(--accent-bright)" />
          </g>
        )}
      </svg>
    </div>
  );
}
