import { useMemo, useState } from 'react';
import { useApp } from '../App';
import { SweepChart } from '../components/charts';
import { Roll } from '../components/Roll';
import { Button, Icon, Kicker, Panel, Pill, Skeleton, Spinner, StatRail, StatTile } from '../components/ui';
import { api } from '../lib/api';
import { pct, usd } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { EvalRow, Kpis } from '../lib/types';

export default function Cockpit() {
  const { tick, bump, threshold, setThreshold, status } = useApp();
  const { data: k } = useApi<Kpis>('/api/kpis', tick);
  const { data: ev } = useApi<{ rows: EvalRow[]; engine: string }>('/api/evals/latest', tick);
  const [running, setRunning] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyFails, setOnlyFails] = useState(false);
  const [volume, setVolume] = useState(20000);

  const e = k?.eval?.kpis;
  const sweep = k?.eval?.sweep ?? [];
  const at = useMemo(() => sweep.reduce((a, b) => (Math.abs(b.threshold - threshold) < Math.abs(a.threshold - threshold) ? b : a),
    sweep[0] ?? { threshold, containment: 0, auto_accuracy: 0, wrong_auto: 0 }), [sweep, threshold]);

  const runEval = async (engine: 'offline' | 'live') => {
    if (engine === 'live' && !window.confirm(`Run all ${e?.cases ?? 61} cases through Claude? This makes 300+ model calls (roughly $6 to $18).`)) return;
    setRunning(engine); setErr(null);
    try { await api.post('/api/evals/run', { engine, confirm_cost: engine === 'live' }); bump(); }
    catch (x) { setErr((x as Error).message); }
    finally { setRunning(null); }
  };

  if (!k) return <div className="flex flex-col gap-s4"><Skeleton className="h-28" /><Skeleton className="h-72" /></div>;
  const b = k.baseline;
  const contained = Math.round(volume * at.containment);
  const saved = contained * b.cost_per_contact - volume * (e?.cost_per_conversation ?? 0);
  const engineName = k.eval?.engine === 'live' ? 'Claude' : 'rules engine';

  return (
    <div className="flex flex-col gap-s6 max-w-wide mx-auto">
      <header className="flex flex-col gap-s2">
        <h1 className="font-display text-headline-lg font-semibold text-ink-primary">How the crew is doing</h1>
        <p className="text-md text-ink-secondary">Measured on the {e?.cases ?? 61}-case test set. Drag the dial to see what a stricter or looser crew would cost.</p>
      </header>
      <section className="flex flex-col gap-s3">
        <div className="flex items-center justify-between gap-s3 flex-wrap">
          <Kicker dot="accent">Service KPIs · {e?.cases ?? 61}-case test set · {engineName} · {k.eval?.ran_at?.replace('T', ' ') ?? 'not run'}</Kicker>
          <div className="flex items-center gap-s2">
            {err && <span className="text-sm text-crit-text">{err}</span>}
            <Button onClick={() => runEval('offline')} disabled={!!running}>{running === 'offline' ? <Spinner /> : <Icon name="play" size={14} />} Run test set (rules)</Button>
            {status?.engine === 'live' && (
              <Button onClick={() => runEval('live')} disabled={!!running}>{running === 'live' ? <Spinner label="About 2 min" /> : <Icon name="play" size={14} />} Run with Claude</Button>
            )}
          </div>
        </div>
        {e && (
          <StatRail>
            {/* Targets are the pilot's success bar from the scope: containment above 50% at 95% accuracy alone,
                escalation recall 100%, every claim grounded, zero safety violations. */}
            <StatTile index={0} value={pct(e.containment)} label="Containment" sub="answered without a person" pct={e.containment} target={0.5} />
            <StatTile index={1} value={pct(e.correct)} label="Correct overall" sub="right answer and right decision" pct={e.correct} />
            <StatTile index={2} value={pct(e.auto_accuracy)} label="Accuracy alone" sub="of what it sent on its own" pct={e.auto_accuracy} target={0.95} />
            <StatTile index={3} value={pct(e.escalation_recall)} label="Escalation recall" sub="needed a person and got one" pct={e.escalation_recall} target={1} />
            <StatTile index={4} value={pct(e.grounded_claims)} label="Grounded claims" sub="verified against a source" pct={e.grounded_claims} target={1} />
            <StatTile index={5} value={e.safety_violations} label="Safety violations" sub="PII, unverified money, over-cap" tone={e.safety_violations ? 'crit' : 'ok'} />
            <StatTile index={6} value={k.eval?.engine === 'live' ? usd(e.cost_per_conversation) : '$0.00'} label="Cost / conversation"
              sub={k.eval?.engine === 'live' ? `p95 ${(e.latency_p95_ms / 1000).toFixed(1)}s` : 'rules engine, no model calls'} />
          </StatRail>
        )}
      </section>

      <div className="grid grid-cols-[1fr_360px] max-xl:grid-cols-1 gap-s4 items-stretch">
        <Panel kicker="The one dial · how sure the crew must be" dot="accent"
          action={<span className="text-xs text-ink-secondary">click the chart to set it</span>}>
          {sweep.length ? <SweepChart data={sweep} threshold={threshold} onPick={setThreshold} /> : <Skeleton className="h-60" />}
          <div className="flex items-center gap-s4 mt-s2">
            <span className="text-xs font-medium text-ink-secondary">Threshold</span>
            <input type="range" min={0.5} max={0.975} step={0.025} value={threshold} onChange={(x) => setThreshold(Number(x.target.value))}
              className="flex-1" aria-label="Confidence threshold" />
            <span className="font-display text-md font-semibold text-ink-primary w-14 text-right"><Roll value={threshold.toFixed(3)} /></span>
          </div>
        </Panel>
        <Panel kicker="At this threshold">
          <div className="flex flex-col gap-s4">
            <div className="grid grid-cols-2 rounded-card border border-line overflow-hidden">
              <Big v={pct(at.containment)} l="answered alone" />
              <Big v={at.containment > 0 ? pct(at.auto_accuracy) : 'n/a'} l="of those right" border />
              <Big v={String(at.wrong_auto)} l="wrong, sent alone" top tone={at.wrong_auto ? 'warn' : undefined} />
              <Big v={String(Math.round((1 - at.containment) * (e?.cases ?? 61)))} l="to specialists" border top />
            </div>
            <p className="text-sm text-ink-secondary leading-relaxed">
              Raising the bar sends more cases to people and fewer wrong answers to customers. Safety rules sit outside this dial:
              injection, legal, safety, and over-limit refunds go to a person at any threshold. The business picks the point;
              the agent makes the trade visible.
            </p>
            <div className="flex flex-col gap-s2 rounded-card border border-line px-s3 py-s3">
              <Kicker>Projection · not measured</Kicker>
              <label className="flex items-center justify-between gap-s2 text-sm text-ink-secondary">
                Contacts per month
                <input type="number" value={volume} min={1000} step={1000} onChange={(x) => setVolume(Number(x.target.value) || 0)}
                  className="w-24 h-7 rounded-ctl bg-surface-inset border border-line px-2 text-right font-mono tabular-nums text-ink-primary focus:outline-none focus:border-accent-line" />
              </label>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-secondary">{contained.toLocaleString()} handled without a person</span>
                <span className="font-display text-lg font-semibold text-ink-primary"><Roll value={`$${Math.round(saved).toLocaleString()}`} /><span className="text-sm text-ink-secondary font-sans">/mo</span></span>
              </div>
              <span className="text-xs text-ink-secondary">Uses the measured {b.aht_min} min handle time at an assumed ${b.loaded_rate_assumption}/h loaded cost
                {k.eval?.engine === 'live' ? ', minus model cost.' : '. Model cost not included until a Claude run.'}</span>
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-[1fr_1fr] max-xl:grid-cols-1 gap-s4">
        <Panel kicker="Before and after · Customer Care">
          <table className="w-full border-collapse">
            <thead><tr>{['Metric', 'Today (people only)', 'With the crew'].map((h) => (
              <th key={h} className="text-left text-xs text-ink-secondary font-medium py-s2 border-b border-line">{h}</th>))}</tr></thead>
            <tbody className="text-smd">
              <Tr m="Contacts needing a person" a="100%" b={pct(1 - at.containment)} />
              <Tr m="Avg handle time" a={`${b.aht_min} min`} b="seconds when contained; handoffs arrive pre-researched" />
              <Tr m="First contact resolution" a={pct(b.fcr)} b={`${pct(at.containment * at.auto_accuracy)} of all contacts, first reply`} />
              <Tr m="Cost per contact" a={usd(b.cost_per_contact)} b={k.eval?.engine === 'live' ? `${usd(e?.cost_per_conversation)} model + people for the rest` : 'measure with a Claude run'} />
              <Tr m="Refund decisions" a="specialist judgement" b="$20 cap in code; above it, a person" />
            </tbody>
          </table>
          <p className="text-xs text-ink-secondary mt-s2">Baseline from {b.tickets} historical tickets in the warehouse. Agent column from the test set at the threshold above.</p>
        </Panel>
        <Panel kicker="Fleet KPIs · live" dot={k.ops.orders_lost_per_hour > 0 ? 'warn' : 'ok'}>
          <div className="grid grid-cols-3 max-md:grid-cols-2 rounded-card border border-line overflow-hidden">
            <Big v={pct(k.ops.uptime)} l="fleet uptime" />
            <Big v={k.ops.orders_lost_per_hour.toFixed(1)} l="orders lost / hour" border tone={k.ops.orders_lost_per_hour ? 'warn' : undefined} />
            <Big v={`${k.ops.mttr_h}h`} l="mean time to repair" border />
            <Big v={pct(k.ops.first_time_fix)} l="first-time fix" top />
            <Big v={String(k.ops.open_work_orders)} l="open work orders" border top />
            <Big v={String(k.ops.parts_below_reorder)} l="parts below reorder" border top tone={k.ops.parts_below_reorder ? 'warn' : undefined} />
          </div>
          <p className="text-xs text-ink-secondary mt-s2">
            This session: {k.session.handled} contacts run, {k.session.auto} answered alone, {k.session.human} to specialists.
            {k.money.map((m) => ` ${m.created_by} ${m.kind}s ${usd(m.total)}.`).join('')}
          </p>
        </Panel>
      </div>

      {ev && (
        <Panel kicker={`Test set · ${ev.rows.filter((r) => r.correct).length} of ${ev.rows.length} correct`}
          action={<button onClick={() => setOnlyFails(!onlyFails)} className="text-sm text-ink-secondary hover:text-ink-primary transition-colors duration-fast">
            {onlyFails ? 'Show all' : 'Show failures only'}</button>}>
          <div className="overflow-x-auto -mx-s4">
            <table className="w-full border-collapse min-w-[860px]">
              <thead><tr>{['Case', 'Customer message', 'Expected', 'Got', 'Conf.', 'Checks'].map((h) => (
                <th key={h} className="text-left text-xs text-ink-secondary font-medium px-s4 py-s2 border-b border-line">{h}</th>))}</tr></thead>
              <tbody>
                {ev.rows.filter((r) => !onlyFails || !r.correct).map((r) => (
                  <tr key={r.id} className={`transition-colors duration-fast ease-out hover:bg-surface-hover ${r.correct ? '' : 'bg-crit-fill'}`}>
                    <td className="px-s4 py-s2 border-b border-line font-mono text-xs text-ink-secondary whitespace-nowrap">{r.id}</td>
                    <td className="px-s4 py-s2 border-b border-line text-sm text-ink-primary max-w-[420px]"><span className="line-clamp-2">{r.message}</span></td>
                    <td className="px-s4 py-s2 border-b border-line font-mono text-xs text-ink-emphasis">{r.expected.decision}</td>
                    <td className="px-s4 py-s2 border-b border-line font-mono text-xs text-ink-emphasis">{r.decision}</td>
                    <td className="px-s4 py-s2 border-b border-line font-mono text-xs tabular-nums text-ink-emphasis">{r.confidence.toFixed(2)}</td>
                    <td className="px-s4 py-s2 border-b border-line">
                      <span className="flex flex-wrap gap-1">
                        {Object.entries(r.checks).map(([c, ok]) => ok ? null : <Pill key={c} kind="crit">{c}</Pill>)}
                        {r.correct && <Pill kind="ok">pass</Pill>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Big({ v, l, border, top, tone }: { v: string; l: string; border?: boolean; top?: boolean; tone?: 'warn' }) {
  return (
    <div className={`px-s4 py-s3 ${border ? 'border-l border-line' : ''} ${top ? 'border-t border-line' : ''}`}>
      <div className={`font-display text-metric font-semibold leading-none ${tone === 'warn' ? 'text-warn-text' : 'text-ink-primary'}`}><Roll value={v} /></div>
      <div className="text-xs text-ink-secondary mt-1.5">{l}</div>
    </div>
  );
}

function Tr({ m, a, b }: { m: string; a: string; b: string }) {
  return (
    <tr>
      <td className="py-s2 pr-s3 border-b border-line text-ink-secondary">{m}</td>
      <td className="py-s2 pr-s3 border-b border-line tabular-nums text-ink-emphasis">{a}</td>
      <td className="py-s2 border-b border-line text-ink-primary">{b}</td>
    </tr>
  );
}
