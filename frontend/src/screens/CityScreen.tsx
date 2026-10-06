import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useApp } from '../App';
import { Button, ENTER, Icon, KV, Panel, Pill, Skeleton } from '../components/ui';
import { useApi } from '../lib/hooks';
import type { City, Contact, Robot } from '../lib/types';
import { CityScene, useCityMap, whereIs } from '../three/City';
import { lightAt } from '../three/palette';
import { hhmm, human, PART_LABEL } from '../lib/format';

const TONE: Record<string, 'crit' | 'warn' | 'ok' | 'info' | 'muted'> = {
  active: 'ok', fault: 'crit', grounded: 'crit', in_repair: 'warn', charging: 'info',
};

export default function CityScreen() {
  const { tick, openCase, openWorkOrder, cue, setCue } = useApp();
  const { sky, rain, status: appStatus } = useApp();
  const light = sky === 'live' ? lightAt(appStatus?.clock) : sky;
  const wet = rain || (appStatus?.weather?.precip_prob ?? 0) >= 0.5;
  const { data } = useApi<City>('/api/city', tick);
  const map = useCityMap();
  const [sel, setSel] = useState<Robot | null>(null);
  const [fly, setFly] = useState<{ x: number; y: number; key: string } | null>(null);
  const reduce = useReducedMotion();
  const waiting = data?.contacts.filter((c) => !c.decision || (c.decision === 'human' && !c.resolved_by)) ?? [];
  const counts = (data?.robots ?? []).reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  const k = data?.kitchen;
  const w = data?.weather;

  const focusRobot = (r: Robot) => { setSel(r); setFly({ ...whereIs(r), key: `${r.robot_id}-${Date.now()}` }); };
  // The copilot asked to show a robot: select it and fly the camera there once the city has loaded.
  useEffect(() => {
    if (cue?.kind !== 'robot' || !data) return;
    const r = data.robots.find((x) => x.robot_id === cue.id);
    if (r) focusRobot(r);
    setCue(null);
  }, [cue, data]);
  const focusContact = (c: Contact & { home?: { x: number; y: number } | null }) => {
    const r = data?.robots.find((x) => x.robot_id === c.robot_id);
    if (r) focusRobot(r);
    else if (c.home) setFly({ ...c.home, key: `${c.contact_id}-${Date.now()}` });
  };

  return (
    <div className="grid grid-cols-[1fr_340px] max-xl:grid-cols-1 gap-s4 xl:h-full min-h-[560px]">
      <section className="relative rounded-panel border border-line-shell overflow-hidden bg-surface-panel min-h-[480px] max-xl:h-[62vh]">
        {data && map ? (
          <CityScene data={data} map={map} selected={sel?.robot_id ?? null} onSelect={setSel} onContact={(c) => openCase(c.contact_id)} flyTo={fly} light={light} rain={wet} />
        ) : <Skeleton className="absolute inset-4" />}
        <div className="absolute z-[60] left-s4 top-s4 flex flex-wrap gap-s2 pointer-events-none rounded-chip bg-surface-panel border border-line shadow-overlay px-s2 py-1.5">
          {Object.entries(counts).map(([s, n]) => <Pill key={s} kind={TONE[s] ?? 'muted'}>{n} {human(s)}</Pill>)}
        </div>

        <AnimatePresence mode="wait">
          {sel && (
            <motion.div key={sel.robot_id} initial={reduce ? false : { opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={reduce ? undefined : { opacity: 0, x: 12 }}
              transition={{ duration: 0.25, ease: ENTER }}
              className="absolute z-[60] right-s4 top-s4 w-[280px] max-md:left-s4 max-md:w-auto rounded-card bg-surface-panel border border-line-strong shadow-overlay p-s4 flex flex-col gap-s2">
              <div className="flex items-center justify-between gap-s2">
                <span className="text-md font-semibold text-ink-primary font-mono">{sel.robot_id}</span>
                <span className="flex items-center gap-s2">
                  <Pill kind={TONE[sel.status] ?? 'muted'}>{human(sel.status)}</Pill>
                  <button onClick={() => setSel(null)} aria-label="Close" className="text-ink-secondary hover:text-ink-primary transition-colors duration-fast"><Icon name="x" size={14} /></button>
                </span>
              </div>
              <div className="flex flex-col">
                <KV k="Doing" v={human(sel.activity)} mono={false} />
                {sel.route && <KV k="Route" v={`${human(sel.route.kind)} · ${sel.route.km?.toFixed(1)} km${sel.route.arrive_at ? ` · ${hhmm(sel.route.arrive_at)}` : ''}`} />}
                <KV k="Battery" v={`${sel.battery_pct}%`} />
                <KV k="Zone" v={sel.zone} mono={false} />
                {sel.fault_code && <KV k="Fault" v={sel.fault_code} />}
              </div>
              {sel.work_order && (
                <Button onClick={() => openWorkOrder(sel.work_order!.wo_id)}>
                  {PART_LABEL[sel.work_order.part_key]} · {human(sel.work_order.status)} <Icon name="arrow" size={14} />
                </Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <Legend />
        <span className="absolute z-[60] left-s4 bottom-s4 pointer-events-none rounded-chip bg-surface-panel border border-line px-s2 py-1 text-xs text-ink-secondary max-md:hidden">
          Drag to orbit · right-drag to pan · scroll to zoom · © OpenStreetMap
        </span>
      </section>

      <div className="flex flex-col gap-s4 min-h-0">
        <Panel kicker={`Needs attention · ${waiting.length}`} dot={waiting.length ? 'warn' : 'ok'} bodyClass="flex flex-col">
          {waiting.length === 0 && <p className="text-sm text-ink-secondary py-s2">Every message has a decision and nobody is waiting on a person.</p>}
          {waiting.map((c) => (
            <div key={c.contact_id} className="flex items-start gap-s2 px-s2 py-s3 -mx-s2 rounded-ctl border-t border-line first:border-t-0 hover:bg-surface-hover transition-colors duration-fast ease-out">
              <button onClick={() => focusContact(c)} className="flex-1 min-w-0 text-left" title={c.robot_id ? `Show ${c.robot_id} on the map` : 'Show on the map'}>
                <span className="flex items-center gap-s2">
                  <span className={`w-1.5 h-1.5 rounded-pill shrink-0 ${c.decision === 'human' ? 'bg-warn' : 'bg-ai'}`} />
                  <span className="text-smd font-medium text-ink-primary truncate">{c.customer_name ?? 'Web chat visitor'}</span>
                  {c.robot_id && <span className="flex items-center gap-1 text-xs font-mono text-ink-secondary"><Icon name="target" size={12} />{c.robot_id}</span>}
                </span>
                <span className="block text-sm text-ink-secondary mt-0.5 line-clamp-2">{c.message}</span>
              </button>
              <Button variant="ghost" onClick={() => openCase(c.contact_id)} title="Open in the Case Room">Open <Icon name="arrow" size={14} /></Button>
            </div>
          ))}
        </Panel>

        <Panel kicker="Kitchen Hub" dot="accent"
          action={w && <span className="text-xs font-mono text-ink-secondary tabular-nums" title={`${w.source}, ${w.kind} fetched ${w.fetched}`}>
            {Math.round(w.temp_f)}°F · {w.summary}</span>}>
          {!k ? <Skeleton className="h-16" /> : (
            <div className="grid grid-cols-3 rounded-card border border-line overflow-hidden">
              <Stat n={k.preparing.length} label="in the oven" title={k.preparing.map((o) => `${o.name} · ${o.zone}`).join('\n')} />
              <Stat n={k.ready.length} label="boxed, waiting" border title={k.ready.map((o) => `${o.name} · ${o.zone}`).join('\n')} />
              <Stat n={k.on_road.length} label="on the road" border
                title={k.on_road.map((r) => `${r.robot_id} · ETA ${hhmm(r.arrive_at)}`).join('\n')} />
            </div>
          )}
        </Panel>

        {!sel && (
          <p className="text-sm text-ink-secondary px-s2">Click a robot on the map, or a case above, to see where it is and what it&apos;s doing.</p>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label, border, title }: { n: number; label: string; border?: boolean; title?: string }) {
  return (
    <div title={title} className={`px-s3 py-s3 ${border ? 'border-l border-line' : ''}`}>
      <div className="font-display text-metric font-semibold tabular-nums leading-none text-ink-primary">{n}</div>
      <div className="text-xs text-ink-secondary mt-1">{label}</div>
    </div>
  );
}

function Legend() {
  const [open, setOpen] = useState(true);
  const dot = (c: string) => <span className="w-2.5 h-2.5 rounded-pill shrink-0" style={{ background: `var(${c})` }} />;
  const line = (c: string, dashed?: boolean) => (
    <span className="w-4 h-0 shrink-0 border-t-2" style={{ borderColor: `var(${c})`, borderStyle: dashed ? 'dashed' : 'solid' }} />
  );
  return (
    <div className="absolute z-[60] right-s4 bottom-s4 rounded-chip bg-surface-panel border border-line shadow-overlay text-xs text-ink-secondary">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-s3 px-s3 py-1.5 text-ink-emphasis font-medium">
        Legend <Icon name="chevron" size={12} className={open ? 'rotate-180' : ''} />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-s4 gap-y-1.5 px-s3 pb-s3">
          <span className="flex items-center gap-1.5">{dot('--map-robot')}Robot</span>
          <span className="flex items-center gap-1.5">{line('--map-route')}Delivery</span>
          <span className="flex items-center gap-1.5">{dot('--status-crit')}Fault</span>
          <span className="flex items-center gap-1.5">{line('--map-route-backup')}Backup</span>
          <span className="flex items-center gap-1.5">{dot('--status-warn')}In repair</span>
          <span className="flex items-center gap-1.5">{line('--map-route-runner')}Parts run</span>
          <span className="flex items-center gap-1.5">{dot('--status-info')}Charging</span>
          <span className="flex items-center gap-1.5">{line('--status-crit', true)}Stalled</span>
          <span className="flex items-center gap-1.5">{dot('--scene-hub')}Kitchen</span>
          <span className="flex items-center gap-1.5">{dot('--map-depot')}Depot</span>
        </div>
      )}
    </div>
  );
}
