/* One service-crew run, drawn the same way wherever it appears: the events fold into a chain of hands (customer, the seven
 * bots, the Gate, the outcome), and the step card shows what the selected hand got, what it looked up, and what it passed
 * on. The Agent Floor and the Case Room both render it, so a case reads the same in either place. */
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PERSONAS } from '../App';
import { hhmm, human, BOTS, usd } from '../lib/format';
import type { CaseEvent, Contact, Evidence, WorkOrder } from '../lib/types';
import type { BackEdge, ChainNode, NodeState } from './Chain';
import { Button, CodeBlock, EngineMark, ENTER, Glyph, Icon, Pill, Spinner } from './ui';

type Step = Extract<CaseEvent, { type: 'step' }>;
type Tool = Extract<CaseEvent, { type: 'tool' }>;
type Rev = Extract<CaseEvent, { type: 'revision' }>;

export const SERVICE = ['dispatcher', 'orders', 'fleet', 'menu', 'librarian', 'resolver', 'checker'];
export const nameOf = (id: string) => BOTS[id]?.name ?? (id === 'gate' ? 'Gate' : id === 'repair_lead' ? 'Repair lead' : human(id));
export const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
export const shortSay = (s?: string) => (s ?? '').split(/(?<=\.)\s/)[0];

// ---------------------------------------------------------------- playback

/** How long each event holds the stage before the next one shows, so a fast run (or a replay) reads step by step. */
const GAP: Partial<Record<CaseEvent['type'] | 'step_start', number>> = {
  step_start: 450, step: 1000, tool: 320, evidence: 60, revision: 1100, decision: 1100, action: 500, handoff: 600,
};

/** Releases streamed events one at a time at a readable pace, and says when it has caught up. */
export function usePlayer() {
  const [shown, setShown] = useState<CaseEvent[]>([]);
  const queue = useRef<CaseEvent[]>([]);
  const timer = useRef<number | null>(null);
  const drained = useRef<(() => void) | null>(null);
  const pump = useRef<() => void>(() => undefined);
  pump.current = () => {
    if (timer.current != null) return;
    const next = queue.current.shift();
    if (!next) { const d = drained.current; drained.current = null; d?.(); return; }
    setShown((xs) => [...xs, next]);
    const key = next.type === 'step' && next.status === 'start' ? 'step_start' : next.type;
    timer.current = window.setTimeout(() => { timer.current = null; pump.current(); }, GAP[key] ?? 150);
  };
  const stop = () => { if (timer.current != null) clearTimeout(timer.current); timer.current = null; queue.current = []; drained.current = null; };
  useEffect(() => stop, []);
  return {
    shown,
    push: (e: CaseEvent) => { queue.current.push(e); pump.current(); },
    load: (all: CaseEvent[]) => { stop(); setShown(all); },
    clear: () => { stop(); setShown([]); },
    whenDrained: (cb: () => void) => {
      if (!queue.current.length && timer.current == null) cb(); else drained.current = cb;
    },
  };
}

// ---------------------------------------------------------------- folding events into a chain

export interface BotRun { bot: string; round: number; start?: Step; done?: Step; tools: Tool[]; prior: Step[] }
export interface ServiceView {
  start?: Extract<CaseEvent, { type: 'case_start' }>; runs: BotRun[]; revStart?: Rev; revDone?: Rev; evidence: Evidence[]; brief?: string;
  decision?: Extract<CaseEvent, { type: 'decision' }>; actions: Extract<CaseEvent, { type: 'action' }>[];
  handoff?: Extract<CaseEvent, { type: 'handoff' }>; final?: Extract<CaseEvent, { type: 'final' }>; error?: string;
}

export function foldService(events: CaseEvent[]): ServiceView {
  const v: ServiceView = { runs: [], actions: [], evidence: [] };
  const done: Step[] = [];
  for (const e of events) {
    if (e.type === 'case_start') v.start = e;
    if (e.type === 'step') {
      const round = e.round ?? 1;
      let r = v.runs.find((x) => x.bot === e.bot && x.round === round);
      if (!r) { r = { bot: e.bot, round, tools: [], prior: [...done] }; v.runs.push(r); }
      if (e.status === 'start') r.start = e; else { r.done = e; done.push(e); }
    }
    if (e.type === 'tool') [...v.runs].reverse().find((x) => x.bot === e.bot)?.tools.push(e);
    if (e.type === 'revision') { if (e.status === 'start') v.revStart = e; else v.revDone = e; }
    if (e.type === 'evidence' && !v.evidence.some((x) => x.source_id === e.source_id)) v.evidence.push(e);
    if (e.type === 'brief') v.brief = e.markdown;
    if (e.type === 'decision') v.decision = e;
    if (e.type === 'action') v.actions.push(e);
    if (e.type === 'handoff') v.handoff = e;
    if (e.type === 'final') v.final = e;
    if (e.type === 'error') v.error = e.message;
  }
  return v;
}

/** The part of a note addressed to `name`: "@Orders pull the account. @Fleet check…" gives Orders "pull the account." */
export function briefFor(name: string, notes: { bot: string; note?: string }[]) {
  const re = new RegExp(`@${name}\\s+(.+?)(?=\\s@[A-Z][a-z]|$)`);
  for (let i = notes.length - 1; i >= 0; i--) {
    const m = (notes[i].note ?? '').match(re);
    if (m) return { from: notes[i].bot, text: m[1] };
  }
  return null;
}

export function serviceChain(v: ServiceView, running: boolean, resolved: boolean, customerName: string): { nodes: ChainNode[]; back: BackEdge | null } {
  const finished = !!v.final || (!running && v.runs.length > 0);
  const furthest = Math.max(-1, ...v.runs.map((r) => SERVICE.indexOf(r.bot)));
  const inRevision = !!v.revStart && (!v.revDone || v.revDone.round < v.revStart.round);
  const nodes: ChainNode[] = [{
    id: 'customer', name: customerName.split(' ')[0], glyph: initials(customerName), tone: 'customer',
    state: v.start ? 'done' : 'pending', status: v.start ? `wrote in ${hhmm(v.start.contact.received_at)}` : 'writes in',
  }];
  for (const b of SERVICE) {
    const rs = v.runs.filter((r) => r.bot === b);
    const last = rs[rs.length - 1];
    const state = last ? (last.done ? 'done' : 'active') : finished || SERVICE.indexOf(b) < furthest ? 'skipped' : 'pending';
    nodes.push({
      id: b, name: BOTS[b].name, glyph: BOTS[b].glyph, tone: (last?.done?.kind ?? last?.start?.kind) === 'ai' ? 'ai' : 'bot', state,
      status: state === 'skipped' ? 'not needed' : state === 'pending' ? BOTS[b].role : shortSay(last?.done?.say),
      badge: rs.length > 1 ? (b === 'resolver' ? `draft ${rs.length}` : `×${rs.length}`) : undefined,
    });
  }
  const lastRun = v.runs[v.runs.length - 1];
  const gateActive = running && !v.decision && !inRevision && lastRun?.bot === 'checker' && !!lastRun.done;
  nodes.push({
    id: 'gate', name: 'Gate', glyph: 'GT', tone: 'code',
    state: v.decision ? 'done' : gateActive ? 'active' : 'pending',
    status: v.decision ? `${v.decision.confidence.toFixed(2)} vs bar ${v.decision.threshold.toFixed(2)}` : 'checks confidence',
  });
  const d = v.decision?.decision;
  const first = customerName.split(' ')[0];
  nodes.push(d === 'auto'
    ? { id: 'outcome', name: 'Reply sent', icon: 'send', tone: 'customer', state: 'ok', status: `${first} has the answer` }
    : d === 'human'
      ? resolved
        ? { id: 'outcome', name: 'Approved', icon: 'person', tone: 'person', state: 'ok', status: `by ${PERSONAS.specialist.name.split(' ')[0]}` }
        : { id: 'outcome', name: 'You', glyph: PERSONAS.specialist.glyph, tone: 'person', state: 'waiting', status: 'needs your approval' }
      : { id: 'outcome', name: 'Outcome', icon: 'dot', tone: 'code', state: 'pending', status: 'sent, or to a person' });

  let back: BackEdge | null = null;
  if (v.revStart) {
    const resolverRound2 = v.runs.find((r) => r.bot === 'resolver' && r.round === v.revStart!.round);
    back = { from: SERVICE.indexOf('checker') + 1, to: SERVICE.indexOf('resolver') + 1,
      live: inRevision && !resolverRound2?.done, label: 'sent back' };
  }
  return { nodes, back };
}

/** The node to show when nobody has clicked one: whoever is working now, else where the case ended up. */
export function followNode(nodes: ChainNode[]): string {
  const last = nodes[nodes.length - 1];
  const n = nodes.find((x) => x.state === 'active')
    ?? (last.state !== 'pending' ? last : [...nodes].reverse().find((x) => x.state === 'done'));
  return n?.id ?? nodes[0].id;
}

// ---------------------------------------------------------------- the step card

export function StepNav({ sel, steps, onPick }: { sel: string; steps: { key: string; name: string; state: NodeState }[]; onPick: (key: string) => void }) {
  const all = steps.filter((n) => n.state !== 'pending' && n.state !== 'skipped');
  const i = all.findIndex((n) => n.key === sel);
  if (all.length < 2) return null;
  return (
    <div className="flex items-center justify-between gap-s2 pt-s3 mt-s3 border-t border-line">
      <Button variant="ghost" onClick={() => i > 0 && onPick(all[i - 1].key)} disabled={i <= 0}>
        <Icon name="arrow" size={14} className="rotate-180" /> {i > 0 ? all[i - 1].name : 'Back'}
      </Button>
      <span className="text-xs font-medium text-ink-secondary tabular-nums px-2.5 py-1 rounded-pill bg-surface-inset border border-line">{i + 1} / {all.length}</span>
      <Button variant="ghost" onClick={() => i < all.length - 1 && onPick(all[i + 1].key)} disabled={i < 0 || i >= all.length - 1}>
        {i < all.length - 1 && i >= 0 ? all[i + 1].name : 'Next'} <Icon name="arrow" size={14} />
      </Button>
    </div>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-s2">
      <span className="text-xs font-semibold text-ink-secondary">{label}</span>
      {children}
    </div>
  );
}

export function Brief({ from, text }: { from: string; text: string }) {
  const b = BOTS[from];
  return (
    <div className="flex items-start gap-s3 rounded-card border border-line bg-surface-inset px-s3 py-2.5">
      <span className="shrink-0 text-2xs font-semibold px-2 py-1 rounded-pill bg-surface-raised border border-line text-ink-emphasis">{b?.name ?? from}</span>
      <span className="text-smd text-ink-emphasis leading-relaxed">{text}</span>
    </div>
  );
}

export function Handoff({ to, note }: { to: string[]; note?: string }) {
  if (!to.length && !note) return null;
  return (
    <Section label="Hands off to">
      <div className="flex flex-col gap-s2 rounded-card border border-accent-line bg-accent-fill px-s3 py-2.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <Icon name="arrow" size={13} className="text-accent-bright" />
          {to.map((t) => <span key={t} className="text-xs font-semibold px-2 py-0.5 rounded-pill bg-[var(--surface-solid)] border border-accent-line text-accent-bright">{nameOf(t)}</span>)}
        </span>
        {note && <span className="text-smd text-ink-primary leading-relaxed">{note.replace(/@(Care specialist|Repair lead|Mechanic|[A-Z][a-z]+)\s/g, '')}</span>}
      </div>
    </Section>
  );
}

/** The plain-language summary of a bot's job, under its name in the detail panel. */
export function WhatItDoes({ id }: { id: string }) {
  const does = BOTS[id]?.does;
  if (!does) return null;
  return (
    <div className="rounded-card border border-line bg-surface-inset px-s3 py-2.5 flex flex-col gap-1">
      <span className="text-xs font-semibold text-ink-secondary">What this bot does</span>
      <span className="text-smd text-ink-emphasis leading-relaxed">{does}</span>
    </div>
  );
}

export function Header({ glyph, tone, name, sub, right }: { glyph: string; tone: 'neutral' | 'ai' | 'accent'; name: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start gap-s3">
      <Glyph text={glyph} tone={tone} size={44} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-s2 flex-wrap">
          <span className="text-lg font-semibold tracking-[-0.01em] text-ink-primary">{name}</span>
          {right}
        </div>
        {sub && <span className="text-sm text-ink-secondary">{sub}</span>}
      </div>
    </div>
  );
}

export function RawOutput({ data }: { data: unknown }) {
  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-xs font-medium text-ink-secondary hover:text-ink-primary transition-colors duration-fast
                          inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-line bg-surface-inset">
        <Icon name="db" size={12} /> Raw output <Icon name="chevron" size={12} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-s2"><CodeBlock code={JSON.stringify(data, null, 2)} label="Raw output · JSON" /></div>
    </details>
  );
}

export function ConfidenceBar({ value, threshold, label }: { value: number; threshold?: number; label: string }) {
  const ok = threshold == null || value >= threshold;
  return (
    <div className="flex flex-col gap-s2">
      <span className="flex items-baseline gap-s2">
        <span className="font-display text-metric font-semibold tabular-nums leading-none text-ink-primary">{Math.round(value * 100)}%</span>
        <span className="text-sm text-ink-secondary">{label}</span>
      </span>
      <span className="relative h-2 rounded-pill bg-surface-inset border border-line">
        <motion.span className={`absolute left-0 top-0 h-full rounded-pill ${ok ? 'bg-ok' : 'bg-warn'}`}
          initial={{ width: 0 }} animate={{ width: `${value * 100}%` }} transition={{ duration: 0.7, ease: ENTER }} />
        {threshold != null && <span className="absolute -top-1 -bottom-1 w-0.5 bg-ink-primary rounded-pill" style={{ left: `${threshold * 100}%` }} />}
      </span>
    </div>
  );
}

/** What one hand on the service chain got, did, and passed on. Approve and repair buttons show only where the caller
 *  passes the handler: the Case Room keeps its decision in the bar at the top of the case. */
export function ServiceDetail({ nodeId, view, customerName, contact, resolved, canAct = true, onApproveHandoff, pendingWos = [], onRepair }: {
  nodeId: string; view: ServiceView; customerName: string; contact?: Contact; resolved: boolean; canAct?: boolean;
  onApproveHandoff?: () => void; pendingWos?: WorkOrder[]; onRepair?: () => void;
}) {
  const first = customerName.split(' ')[0];

  if (nodeId === 'customer') {
    const s = view.start;
    return (
      <div className="flex flex-col gap-s4">
        <Header glyph={initials(customerName)} tone="accent" name={customerName}
          sub={`${contact?.contact_id ?? ''} · ${contact?.verified ? 'verified, in the app' : 'unverified, web chat'}`}
          right={<Pill kind="accent">Customer</Pill>} />
        <Section label={`Wrote in at ${hhmm(s?.contact.received_at ?? contact?.received_at)}`}>
          <p className="text-lg text-ink-primary leading-relaxed rounded-card bg-surface-raised border border-line border-l-2 border-l-[var(--accent)] px-s4 py-s3">“{s?.contact.message ?? contact?.message}”</p>
        </Section>
        <Handoff to={['dispatcher']} note="Every message goes to the Dispatcher first. It reads it, decides who is needed, and briefs them." />
      </div>
    );
  }

  if (nodeId === 'gate') {
    const d = view.decision;
    if (!d) return <p className="text-sm text-ink-secondary">The Gate scores the Checker&apos;s verdict against the Head of Care&apos;s bar.</p>;
    const auto = d.decision === 'auto';
    const brief = briefFor('Gate', view.runs.flatMap((r) => (r.done ? [r.done] : [])));
    return (
      <div className="flex flex-col gap-s4">
        <Header glyph="GT" tone="neutral" name="Confidence gate" sub="Code, not a model. Same rules every time."
          right={<Pill kind={auto ? 'ok' : 'warn'}>{auto ? 'Answer alone' : 'Needs a person'}</Pill>} />
        {brief && <Section label="Brief received"><Brief from="checker" text={brief.text} /></Section>}
        <Section label="Result">
          <ConfidenceBar value={d.confidence} threshold={d.threshold} label={`against the bar of ${d.threshold.toFixed(2)}`} />
          <ul className="flex flex-col gap-1">
            {d.reasons.map((r, i) => <li key={i} className="flex gap-2 text-smd text-ink-emphasis"><span className={auto ? 'text-ok-text' : 'text-warn-text'}>•</span>{r}</li>)}
          </ul>
        </Section>
        <Handoff to={[auto ? 'customer' : 'care_specialist']} note={auto ? `Send the reply to ${first} and run the actions.` : 'Hold the reply. A specialist decides.'} />
      </div>
    );
  }

  if (nodeId === 'outcome') {
    const d = view.decision;
    const result = view.final?.result;
    if (!d) return <p className="text-sm text-ink-secondary">The outcome shows here once the Gate decides.</p>;
    if (d.decision === 'auto') {
      return (
        <div className="flex flex-col gap-s4">
          <Header glyph="OK" tone="accent" name={`Sent to ${first}`} sub="No person needed" right={<Pill kind="ok">Resolved</Pill>} />
          {result?.reply && <Section label="The reply"><p className="text-md text-ink-primary leading-relaxed rounded-card bg-surface-raised border border-line px-s4 py-s3">{result.reply}</p></Section>}
          {view.actions.length > 0 && (
            <Section label="What the crew did">
              {view.actions.map((a, i) => (
                <span key={i} className="flex items-center gap-s2 text-smd"><Icon name="check" size={14} className="text-ok-text" />
                  <span className="text-ink-primary">{human(a.action)}</span><span className="text-ink-secondary">{a.detail}</span></span>
              ))}
            </Section>
          )}
          {pendingWos.length > 0 && onRepair && (
            <div className="flex items-center justify-between gap-s3 rounded-card border border-line bg-surface-raised px-s3 py-s2">
              <span className="text-sm text-ink-secondary">{pendingWos.length} work order{pendingWos.length === 1 ? '' : 's'} waiting for the repair crew.</span>
              <Button onClick={onRepair}><Icon name="wrench" size={14} /> Hand to the repair crew</Button>
            </div>
          )}
        </div>
      );
    }
    const h = view.handoff?.handoff ?? result?.handoff;
    const p = PERSONAS.specialist;
    return (
      <div className="flex flex-col gap-s4">
        <Header glyph={p.glyph} tone="accent" name={p.name} sub="Care specialist · a person" right={<Pill kind={resolved ? 'ok' : 'warn'}>{resolved ? 'Approved' : 'Needs you'}</Pill>} />
        {h && <Section label="The crew's summary"><p className="text-md text-ink-primary leading-relaxed">{h.summary}</p></Section>}
        {h && <Section label="Recommendation"><p className="text-smd text-ink-emphasis leading-relaxed">{h.recommendation}</p></Section>}
        {(result?.actions?.length ?? 0) > 0 && (
          <Section label="Proposed">
            <span className="flex flex-wrap gap-s2">{result!.actions!.map((a, i) => <Pill key={i} kind="muted">{human(a.type)}{a.amount ? ` ${usd(a.amount)}` : ''}</Pill>)}</span>
          </Section>
        )}
        {resolved ? <p className="text-sm text-ok-text">Approved. The proposed actions ran and {first} has the reply.</p> : onApproveHandoff && (
          <div className="flex items-center gap-s2">
            <Button variant="primary" onClick={onApproveHandoff} disabled={!canAct}><Icon name="check" size={14} /> Approve as {p.name.split(' ')[0]}</Button>
            {!canAct && <span className="text-xs text-ink-secondary">Sign in as the Care specialist to approve.</span>}
          </div>
        )}
      </div>
    );
  }

  // A service bot.
  const runs = view.runs.filter((r) => r.bot === nodeId);
  const b = BOTS[nodeId];
  if (!runs.length) return <div className="flex flex-col gap-s3"><p className="text-sm text-ink-secondary">{b?.name} is waiting for its turn.</p><WhatItDoes id={nodeId} /></div>;
  const kind = runs[runs.length - 1].done?.kind ?? runs[runs.length - 1].start?.kind ?? 'rules';
  return (
    <div className="flex flex-col gap-s4">
      <Header glyph={b.glyph} tone={kind === 'ai' ? 'ai' : 'neutral'} name={b.name} sub={b.role}
        right={<><EngineMark kind={kind} />{runs[runs.length - 1].done?.ms != null && <span className="text-xs text-ink-secondary tabular-nums">{runs[runs.length - 1].done!.ms} ms</span>}</>} />
      <WhatItDoes id={nodeId} />
      {runs.map((r) => {
        const sentBack = r.round > 1 && nodeId === 'resolver' && view.revStart;
        const brief = sentBack
          ? { from: 'checker', text: `Fix ${view.revStart!.failed?.length ?? 0} claim(s): ${(view.revStart!.failed ?? []).map((f) => `“${f.text}” ${f.notes.join(' ')}`).join(' ')}` }
          : nodeId === 'dispatcher' ? { from: 'customer', text: `“${view.start?.contact.message ?? ''}”` } : briefFor(b.name, r.prior);
        const d = r.done;
        const coverage = d?.output?.coverage as Coverage[] | undefined;
        return (
          <div key={r.round} className="flex flex-col gap-s4">
            {runs.length > 1 && <span className="self-start text-xs font-semibold text-ink-emphasis px-2.5 py-1 rounded-pill bg-surface-raised border border-line">{nodeId === 'resolver' ? `Draft ${r.round}` : `Check ${r.round}`}</span>}
            {brief && <Section label="Brief received"><Brief from={brief.from === 'customer' ? first : brief.from} text={brief.text} /></Section>}
            {r.tools.length > 0 && (
              <Section label={`Looked up · ${r.tools.length}`}>
                <div className="flex flex-col gap-1.5">
                  {r.tools.map((t, i) => (
                    <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease: ENTER }}
                      className="grid grid-cols-[16px_1fr] gap-s2 items-start text-sm">
                      <Icon name={t.ok ? 'check' : 'x'} size={14} className={`mt-0.5 ${t.ok ? 'text-ok-text' : 'text-crit-text'}`} />
                      <span className="min-w-0">
                        <span className="text-ink-primary">{human(t.name)}</span>
                        <span className="text-ink-secondary"> · {t.summary}</span>
                      </span>
                    </motion.div>
                  ))}
                </div>
              </Section>
            )}
            <Section label="Result">
              {d ? <p className="text-md text-ink-primary leading-relaxed"><Typed text={d.say ?? ''} /></p> : <Spinner label={`${b.name} is working…`} />}
              {nodeId === 'librarian' && d?.search_tier && (
                <span className="text-xs text-ink-secondary tabular-nums">search tier {d.search_tier} · top score {d.top_score}</span>
              )}
            </Section>
            {coverage && coverage.length > 1 && <Section label="Sources for each ask"><AskCoverage coverage={coverage} /></Section>}
            {nodeId === 'menu' && d?.output?.basket != null && <Section label="Basket"><MenuBasket basket={d.output.basket as Basket} /></Section>}
            {d && <Handoff to={d.to ?? []} note={d.note} />}
            {d?.output && <RawOutput data={d.output} />}
          </div>
        );
      })}
    </div>
  );
}

/** A bot's result, typed out quickly the first time it shows, so a run reads like the bot is speaking. Under 0.7 s. */
function Typed({ text }: { text: string }) {
  const reduce = useReducedMotion();
  const [n, setN] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (reduce) { setN(text.length); return; }
    setN(0);
    const step = Math.max(2, Math.ceil(text.length / 40));
    const t = window.setInterval(() => setN((x) => { if (x + step >= text.length) { clearInterval(t); return text.length; } return x + step; }), 16);
    return () => clearInterval(t);
  }, [text, reduce]);
  return <>{text.slice(0, n)}<span className="invisible">{text.slice(n)}</span></>;
}

// ---------------------------------------------------------------- bot-specific results

interface Coverage { ask: string; intent: string | null; source_id: string | null }

/** One row per thing the customer asked; shown only when a message asked for more than one thing. */
function AskCoverage({ coverage }: { coverage: Coverage[] }) {
  return (
    <div className="flex flex-col gap-1" aria-label="Sources found for each ask">
      {coverage.map((c, i) => (
        <div key={i} className="grid grid-cols-[16px_1fr] gap-s2 items-start text-sm">
          <Icon name={c.source_id ? 'check' : 'x'} size={14} className={`mt-0.5 ${c.source_id ? 'text-ok-text' : 'text-crit-text'}`} />
          <span className="min-w-0">
            <span className="text-ink-primary">Ask {i + 1} · {human(c.intent ?? '')}</span>
            <span className="text-ink-secondary font-code text-xs"> → {c.source_id ?? 'nothing found'}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

interface BasketLine { item_id: string; name: string; qty: number; line_total: number; matched_for: string; category: string }
interface Basket {
  lines: BasketLine[]; total: number; party_size: number; max_budget: number | null; over_budget: boolean; tier: string;
  excluded: { name: string; reason: string; wanted_for: string }[];
  dropped: { name: string; qty: number; amount: number; reason: string }[];
  coverage: { want: string; item_id: string | null; note: string }[];
}

/** The Menu bot's basket. Each thing the request was parsed into gets a hue, echoed on the line that answers it,
 *  so the hand-off from parsing to search to the code's filters reads at a glance. */
function MenuBasket({ basket }: { basket: Basket }) {
  const wants = [...new Set([...basket.coverage.map((c) => c.want), ...basket.lines.map((l) => l.matched_for)])];
  const hue = (w: string) => `var(--series-${(wants.indexOf(w) % 6) + 1})`;
  const dot = (w: string) => <span aria-hidden className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: hue(w) }} />;
  return (
    <div className="flex flex-col gap-s2">
      <div className="flex flex-wrap gap-1" aria-label="What the request was parsed into">
        {wants.map((w) => {
          const c = basket.coverage.find((x) => x.want === w);
          const met = !c || !!c.item_id;
          return (
            <span key={w} title={c?.note || 'answered'}
              className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-pill border border-line whitespace-nowrap">
              {dot(w)}<span className={met ? 'text-ink-primary' : 'text-ink-faint line-through'}>{w}</span>
            </span>
          );
        })}
      </div>
      <div className="flex flex-col gap-1 text-xs tabular-nums rounded-card border border-line bg-surface-inset px-s3 py-s2">
        {basket.lines.map((l) => (
          <div key={l.item_id} className="grid grid-cols-[14px_1fr_auto] gap-s2 items-center">
            {dot(l.matched_for)}
            <span className="min-w-0 text-ink-primary">{l.qty} × {l.name}</span>
            <span className="text-ink-secondary tabular-nums">{usd(l.line_total)}</span>
          </div>
        ))}
        {basket.excluded.map((x) => (
          <div key={x.name} className="grid grid-cols-[14px_1fr] gap-s2 items-start">
            <Icon name="x" size={14} className="text-crit-text" />
            <span className="min-w-0 text-ink-secondary"><span className="line-through">{x.name}</span> · {x.reason}</span>
          </div>
        ))}
        {basket.dropped.map((d) => (
          <div key={d.name} className="grid grid-cols-[14px_1fr] gap-s2 items-start">
            <Icon name="x" size={14} className="text-ink-faint" />
            <span className="min-w-0 text-ink-secondary"><span className="line-through">{d.qty} × {d.name}</span> · {d.reason}</span>
          </div>
        ))}
        <div className="grid grid-cols-[14px_1fr_auto] gap-s2 items-center pt-1 border-t border-line">
          <span />
          <span className="text-ink-secondary">for {basket.party_size}{basket.max_budget ? ` · budget ${usd(basket.max_budget)}` : ''} · search {basket.tier}</span>
          <span className={`tabular-nums font-semibold ${basket.over_budget ? 'text-warn-text' : 'text-ink-primary'}`}>{usd(basket.total)}</span>
        </div>
      </div>
    </div>
  );
}
