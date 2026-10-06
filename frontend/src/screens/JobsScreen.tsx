/* The mechanic's day, built for a tablet on the shop floor: big tiles, big buttons, nothing to read twice. Jobs the
 * repair crew planned and the Repair lead approved, with the part, the bin, and any runner robot already arranged.
 * Start one, finish it, and the robot goes back on the road. With nothing booked, it shows what is probably coming. */
import { motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { PERSONAS, useApp } from '../App';
import { Button, ENTER, Icon, Pill, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { hhmm, human, PART_LABEL } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { Job, Mechanic, WorkOrder } from '../lib/types';

const TONE: Record<string, 'ok' | 'warn' | 'info' | 'muted'> = { scheduled: 'info', in_progress: 'warn', completed: 'ok' };

export default function JobsScreen() {
  const { tick, bump, demoMechanic: who } = useApp();
  const { data: mechs } = useApi<Mechanic[]>('/api/mechanics', tick);
  const { data: jobs, reload } = useApi<Job[]>(`/api/mechanics/${who}/jobs`, tick);
  const { data: queue } = useApi<WorkOrder[]>('/api/repair/queue', tick);
  const [busy, setBusy] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const me = mechs?.find((m) => m.mechanic_id === who);
  const coming = (queue ?? []).filter((w) => (w.status === 'proposed' || w.status === 'open') && w.depot_id === me?.depot_id);
  const open = (jobs ?? []).filter((j) => j.status !== 'completed').length;

  const act = async (wo: string, what: 'start' | 'complete') => {
    setBusy(wo);
    try { await api.post(`/api/repair/${wo}/${what}`); } finally { setBusy(null); reload(); bump(); }
  };

  return (
    <div className="flex flex-col gap-s5 max-w-[1100px] mx-auto pb-s6">
      <header className="flex items-end justify-between gap-s4 flex-wrap">
        <div className="flex flex-col gap-s2">
          <h1 className="font-display text-headline-lg font-semibold text-ink-primary">
            {me ? `${me.name.split(' ')[0]}'s jobs` : 'Your jobs'}
          </h1>
          <p className="text-md text-ink-secondary">
            {me ? `${me.depot} · shift ${hhmm(me.shift_start)}–${hhmm(me.shift_end)} · certified for ${me.skills.split(',').join(', ')}` : ' '}
          </p>
        </div>
        <span className="flex items-baseline gap-s2">
          <span className="font-display text-metric-lg font-semibold text-ink-primary tabular-nums">{open}</span>
          <span className="text-sm text-ink-secondary">to do today</span>
        </span>
      </header>

      {!jobs ? <Skeleton className="h-48 rounded-panel" /> : jobs.length === 0 ? (
        <section className="surface-card rounded-panel p-s6 max-md:p-s4 flex flex-col gap-s4">
          <div className="flex items-center gap-s3">
            <span className="grid place-items-center w-11 h-11 rounded-card bg-surface-raised border border-line text-ink-secondary"><Icon name="wrench" size={20} /></span>
            <div>
              <h2 className="font-display text-lg font-semibold text-ink-primary">Nothing booked yet</h2>
              <p className="text-sm text-ink-secondary">Approved jobs land here with the part already reserved and the bin number on the card.</p>
            </div>
          </div>
          {coming.length > 0 && (
            <div className="flex flex-col gap-s2 pt-s4 border-t border-line">
              <span className="text-sm text-ink-emphasis">
                Probably coming your way: {PERSONAS.repair_lead.name.split(' ')[0]} has {coming.length} repair{coming.length === 1 ? '' : 's'} at {me?.depot} waiting for approval.
              </span>
              <div className="grid grid-cols-2 max-md:grid-cols-1 gap-s2">
                {coming.slice(0, 4).map((w) => (
                  <div key={w.wo_id} className="flex items-center gap-s3 rounded-card border border-dashed border-line-strong px-s4 py-s3">
                    <span className="font-display text-md font-semibold text-ink-primary">{w.robot_id}</span>
                    <span className="text-sm text-ink-secondary truncate">{PART_LABEL[w.part_key] ?? w.part_name} · {w.repair_minutes} min</span>
                    <Pill kind="muted">awaiting approval</Pill>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : (
        <div className="flex flex-col gap-s3">
          {jobs.map((j, i) => (
            <motion.article key={j.wo_id} initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: ENTER, delay: Math.min(i, 6) * 0.05 }}
              className={`surface-card rounded-panel p-s5 max-md:p-s4 grid grid-cols-[1fr_auto] max-md:grid-cols-1 gap-s5 items-center
                          ${j.status === 'in_progress' ? 'border-warn' : ''}`}>
              <div className="flex flex-col gap-s3 min-w-0">
                <div className="flex items-center gap-s3 flex-wrap">
                  <span className="font-display text-headline-md font-semibold text-ink-primary">{j.robot_id}</span>
                  <span className="text-lg text-ink-emphasis">{PART_LABEL[j.part_key] ?? j.part_name}</span>
                  <Pill kind={TONE[j.status] ?? 'muted'}>{human(j.status)}</Pill>
                </div>
                <span className="text-sm text-ink-secondary">{j.reason}</span>
                <div className="grid grid-cols-3 max-md:grid-cols-1 gap-s3">
                  <Fact k="When" v={`${hhmm(j.scheduled_start)}–${hhmm(j.scheduled_end)}`} sub={`${j.repair_minutes} min`} />
                  <Fact k="Part" v={`Bin ${j.source_bin ?? '—'}`} sub={`${j.sku} · ${j.source_location ?? '—'}`} />
                  <Fact k="Delivery" v={j.runner ? `By ${hhmm(j.runner.arrive)}` : 'At the depot'} sub={j.runner ? `runner ${j.runner.runner_id}` : 'no runner needed'} />
                </div>
              </div>
              <div className="flex flex-col gap-s2 min-w-[180px] max-md:min-w-0">
                {j.status === 'scheduled' && (
                  <Button size="lg" onClick={() => act(j.wo_id, 'start')} disabled={busy === j.wo_id}><Icon name="play" size={14} /> Start</Button>
                )}
                {(j.status === 'scheduled' || j.status === 'in_progress') && (
                  <Button variant="primary" size="lg" onClick={() => act(j.wo_id, 'complete')} disabled={busy === j.wo_id}>
                    <Icon name="check" size={16} /> Mark fixed
                  </Button>
                )}
                {j.status === 'completed' && <span className="flex items-center gap-s2 text-md text-ok-text"><Icon name="check" size={16} />Back on the road</span>}
              </div>
            </motion.article>
          ))}
        </div>
      )}

      <p className="text-sm text-ink-secondary leading-relaxed max-w-[80ch]">
        How jobs get here: a complaint or a fault opens a work order, the Diagnostician picks the part (asking the Fleet bot when
        it isn&apos;t sure), the Scheduler fits it around shifts, stock, and the dinner rush, and the Repair lead approves it.
      </p>
    </div>
  );
}

function Fact({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 rounded-card bg-surface-inset border border-line px-s3 py-s2">
      <span className="text-xs text-ink-secondary">{k}</span>
      <span className="text-md font-semibold text-ink-primary truncate tabular-nums" title={v}>{v}</span>
      {sub && <span className="text-xs text-ink-secondary truncate tabular-nums">{sub}</span>}
    </div>
  );
}
