import { useState } from 'react';
import { useApp } from '../App';
import { Gantt } from '../components/charts';
import { Button, Icon, Panel, Pill, Skeleton, StatRail, StatTile } from '../components/ui';
import { api } from '../lib/api';
import { hhmm, hoursOf, pct, PART_LABEL } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { TimelineItem } from '../lib/types';

interface Sched {
  mechanics: { mechanic_id: string; name: string; depot_id: string; skills: string; shift_start: string; shift_end: string }[];
  jobs: { wo_id: string; robot_id: string; part_key: string; status: string; scheduled_start: string; scheduled_end: string;
          mechanic_id: string; runner: { runner_id: string; pickup: string; arrive: string; to: string } | null }[];
  peaks: { lunch: [number, number]; dinner: [number, number] }; clock: string;
}

export default function ScheduleScreen() {
  const { tick, bump } = useApp();
  const { data } = useApi<Sched>('/api/schedule', tick);
  const [ff, setFf] = useState<{ completed: string[]; uptime_before: number; uptime_after: number } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className="h-96" />;
  const name = (id: string) => data.mechanics.find((m) => m.mechanic_id === id)?.name ?? id;
  const shifts: TimelineItem[] = data.mechanics.map((m) => ({ lane: m.name, label: 'On shift', start: m.shift_start, end: m.shift_end, kind: 'transit' }));
  const jobs: TimelineItem[] = data.jobs.filter((j) => j.mechanic_id).map((j) => ({
    lane: name(j.mechanic_id), label: `${j.robot_id} · ${PART_LABEL[j.part_key]}`, start: j.scheduled_start, end: j.scheduled_end,
    kind: j.status === 'completed' ? 'done' : 'repair' }));
  const runs = new Map<string, TimelineItem>();
  data.jobs.forEach((j) => j.runner && runs.set(`${j.runner.runner_id}${j.runner.pickup}`,
    { lane: `Runner ${j.runner.runner_id}`, label: `Parts to ${j.runner.to}`, start: j.runner.pickup, end: j.runner.arrive, kind: 'pickup' }));
  const lanes = [...data.mechanics.map((m) => m.name), ...Array.from(new Set([...runs.values()].map((r) => r.lane)))];
  const scheduled = data.jobs.filter((j) => j.status === 'scheduled' || j.status === 'in_progress').length;
  const forward = async () => {
    setBusy(true);
    setFf(await api.post('/api/repair/fast-forward'));
    setBusy(false); bump();
  };
  return (
    <div className="flex flex-col gap-s4">
      <StatRail>
        <StatTile index={0} value={data.mechanics.length} label="Mechanics today" sub="North and South depots" />
        <StatTile index={1} value={scheduled} label="Repairs booked" sub="ahead of the clock" />
        <StatTile index={2} value={data.jobs.filter((j) => j.status === 'completed').length} label="Completed today" />
        <StatTile index={3} value={hhmm(data.clock)} label="Clock" sub={ff ? 'fast-forwarded' : 'simulation time'} />
      </StatRail>
      <Panel kicker="Mechanic schedule · today" dot="accent"
        action={<Button variant="primary" onClick={forward} disabled={busy || scheduled === 0}><Icon name="forward" size={14} /> Fast-forward to 17:00</Button>}>
        <Gantt items={[...shifts, ...jobs, ...runs.values()]} laneOrder={lanes} from={8} to={22} now={hoursOf(data.clock)}
          peaks={[{ label: 'lunch peak', range: data.peaks.lunch }, { label: 'dinner rush', range: data.peaks.dinner }]} />
        <div className="flex items-center gap-s4 mt-s2 text-xs text-ink-secondary">
          <span className="inline-flex items-center gap-2"><span className="w-3 h-1.5 rounded-pill bg-[var(--hairline-strong)]" />On shift</span>
          <span className="inline-flex items-center gap-2"><span className="w-3 h-2.5 rounded-ctl bg-accent" />Repair</span>
          <span className="inline-flex items-center gap-2"><span className="w-3 h-2.5 rounded-ctl bg-[var(--viz-1)]" />Runner trip</span>
          <span className="inline-flex items-center gap-2"><span className="w-3 h-2.5 rounded-ctl bg-[var(--viz-band)] border border-warn" />Peak, no planned downtime</span>
        </div>
      </Panel>
      {ff && (
        <Panel kicker="Fast-forward result" dot="ok">
          <p className="text-smd text-ink-primary">
            {ff.completed.length} repairs completed before the dinner rush. Fleet uptime {pct(ff.uptime_before, 1)} → <span className="text-ok-text">{pct(ff.uptime_after, 1)}</span>.
          </p>
          <div className="flex flex-wrap gap-1 mt-s2">{ff.completed.map((w) => <Pill key={w} kind="ok">{w}</Pill>)}</div>
        </Panel>
      )}
    </div>
  );
}
