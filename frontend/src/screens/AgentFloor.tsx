/* The Agent Floor: one complaint, worked live, drawn as a chain. Each bot gets a brief from the one before it, does its
 * lookups, and hands its result on; the chain lights the bot doing the work and the card below shows exactly what it got,
 * what it did, and what it passed along. Robots the bots talk about light up on the DC map. When the service crew opens
 * work orders, a second chain, the repair crew, picks them up and asks the Repair lead to approve the plan. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Workflow, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PERSONAS, useApp } from '../App';
import { Chain, type BackEdge, type ChainNode } from '../components/Chain';
import {
  Brief, briefFor, ConfidenceBar, foldService, followNode, Handoff, Header, Section, ServiceDetail, serviceChain, shortSay, StepNav,
  usePlayer, WhatItDoes, type ServiceView,
} from '../components/ServiceRun';
import { Button, EngineMark, ENTER, Icon, Panel, Pill, Skeleton, Spinner } from '../components/ui';
import { api, streamCase, streamCrew } from '../lib/api';
import { BOTS, hhmm, PART_LABEL } from '../lib/format';
import { useApi } from '../lib/hooks';
import { FEATURED, STORY } from '../lib/stories';
import type { CaseEvent, City, Contact, CrewEvent, Plan, WorkOrder } from '../lib/types';
import { CityScene, useCityMap, whereIs } from '../three/City';
import { lightAt } from '../three/palette';

type Post = Extract<CrewEvent, { type: 'post' }>;
type Approval = Extract<CrewEvent, { type: 'approval' }>;

const REPAIR = ['diagnostician', 'fleet', 'parts', 'runner', 'scheduler'];

// ---------------------------------------------------------------- the repair chain

function repairChain(crew: CrewEvent[], running: boolean, booked: boolean): { nodes: ChainNode[]; back: BackEdge | null } {
  const posts = crew.filter((c): c is Post => c.type === 'post');
  const approval = crew.find((c): c is Approval => c.type === 'approval');
  const last = posts[posts.length - 1];
  const furthest = Math.max(-1, ...posts.map((p) => REPAIR.indexOf(p.bot)));
  const nodes: ChainNode[] = REPAIR.map((b) => {
    const mine = posts.filter((p) => p.bot === b);
    const working = running && !approval && last?.bot === b && last === mine[mine.length - 1];
    const state = mine.length ? (working ? 'active' : 'done') : approval || REPAIR.indexOf(b) < furthest ? 'skipped' : 'pending';
    return {
      id: b, name: BOTS[b].name, glyph: BOTS[b].glyph, tone: mine[mine.length - 1]?.kind === 'ai' ? 'ai' : 'bot', state,
      status: state === 'skipped' ? 'not needed' : state === 'pending' ? BOTS[b].role
        : b === 'diagnostician' && mine[mine.length - 1]?.confidence != null ? `${Math.round(mine[mine.length - 1].confidence! * 100)}% sure`
          : shortSay(mine[mine.length - 1]?.say),
      badge: mine.length > 1 ? `×${mine.length}` : undefined,
    };
  });
  const lead = PERSONAS.repair_lead;
  nodes.push(booked
    ? { id: 'repair_lead', name: 'Booked', icon: 'check', tone: 'person', state: 'ok', status: `by ${lead.name.split(' ')[0]}` }
    : approval
      ? { id: 'repair_lead', name: 'Repair lead', glyph: lead.glyph, tone: 'person', state: 'waiting', status: 'approve the plan' }
      : { id: 'repair_lead', name: 'Repair lead', glyph: lead.glyph, tone: 'person', state: 'pending', status: 'approves the plan' });
  // The Diagnostician asks the Fleet bot when unsure: draw that consult as a loop back.
  const consulted = posts.some((p) => p.consult);
  const back = consulted ? { from: 1, to: 0, live: running && last?.bot === 'fleet' && !!last.consult, label: 'asks Fleet' } : null;
  return { nodes, back };
}

/** Robots the conversation is about, in the order they come up. */
function robotsIn(events: CaseEvent[], crew: CrewEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool' && e.name === 'get_robot' && typeof e.args.robot_id === 'string') out.add(e.args.robot_id);
    if (e.type === 'step' && e.status === 'done' && e.bot === 'fleet') {
      ((e.output?.fleet_pattern_robots as string[] | undefined) ?? []).forEach((r) => out.add(r));
    }
    if (e.type === 'tool' && e.name === 'find_backup_robot') e.summary.match(/SB-\d{3}/)?.forEach((r) => out.add(r));
    if (e.type === 'action') e.detail.match(/SB-\d{3}/g)?.forEach((r) => out.add(r));
  }
  for (const c of crew) {
    if (c.type === 'crew_start') c.robots.forEach((r) => out.add(r));
    if (c.type === 'approval') c.runner_trips.forEach((t) => out.add(t.runner_id));
  }
  return [...out];
}

// ---------------------------------------------------------------- screen

export default function AgentFloor() {
  const { tick, bump, engine, threshold, caseId, setCaseId, role, cue, setCue } = useApp();
  const { sky, rain, status: appStatus } = useApp();
  const light = sky === 'live' ? lightAt(appStatus?.clock) : sky;
  const wet = rain || (appStatus?.weather?.precip_prob ?? 0) >= 0.5;
  const { data: contacts } = useApi<Contact[]>('/api/contacts', tick);
  const [cityKey, setCityKey] = useState(0);
  const { data: city } = useApi<City>('/api/city', `${tick}-${cityKey}`);
  const map = useCityMap();
  const id = caseId ?? FEATURED[0];
  const player = usePlayer();
  const [saved, setSaved] = useState<CaseEvent[]>([]);
  const [crew, setCrew] = useState<CrewEvent[]>([]);
  const [wos, setWos] = useState<WorkOrder[]>([]);
  const [phase, setPhase] = useState<'idle' | 'service' | 'repair'>('idle');
  const [booked, setBooked] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const stop = useRef<() => void>();
  const reduce = useReducedMotion();

  const wantReplay = useRef<string | null>(null);
  const loadWos = () => api.get<WorkOrder[]>(`/api/cases/${id}/work_orders`).then(setWos).catch(() => setWos([]));

  useEffect(() => {
    stop.current?.();
    setPhase('idle'); setCrew([]); setBooked(null); setPick(null);
    api.get<{ events: CaseEvent[] }>(`/api/cases/${id}`).then((r) => {
      setSaved(r.events); player.load(r.events);
      if (wantReplay.current === id) { wantReplay.current = null; replayEvents(r.events); }
    }).catch(() => { setSaved([]); player.clear(); });
    loadWos();
  }, [id]);
  useEffect(() => () => stop.current?.(), []);

  const events = player.shown;
  const contact = contacts?.find((c) => c.contact_id === id);
  const resolved = !!contact?.resolved_by;
  const customerName = (events.find((e) => e.type === 'case_start') as Extract<CaseEvent, { type: 'case_start' }> | undefined)?.customer?.name
    ?? contact?.customer_name ?? 'Web chat visitor';
  const view = useMemo(() => foldService(events), [events]);
  const service = useMemo(() => serviceChain(view, phase === 'service', resolved, customerName), [view, phase, resolved, customerName]);
  const repair = useMemo(() => (crew.length ? repairChain(crew, phase === 'repair', !!booked) : null), [crew, phase, booked]);
  const hot = useMemo(() => robotsIn(events, crew), [events, crew]);
  const caseRobot = hot[0];
  // The camera follows the conversation: when a bot names a robot, fly to it; at rest, frame the case's own robot.
  const [fly, setFly] = useState<{ x: number; y: number; key: string } | null>(null);
  const flown = useRef<string | null>(null);
  useEffect(() => {
    const target = phase !== 'idle' ? hot[hot.length - 1] : hot[0];
    if (!target || !city || flown.current === target) return;
    const r = city.robots.find((x) => x.robot_id === target);
    if (!r) return;
    flown.current = target;
    setFly({ ...whereIs(r), key: `${target}-${Date.now()}` });
  }, [hot.join(), city, phase]);
  const pending = wos.filter((w) => w.status === 'proposed' || w.status === 'open');
  const busy = phase !== 'idle';

  // Follow the work: the card shows whoever is working now, unless someone clicked a node to read it.
  const auto = useMemo(() => {
    if (repair) {
      const n = repair.nodes.find((x) => x.state === 'active') ?? [...repair.nodes].reverse().find((x) => x.state !== 'pending' && x.state !== 'skipped');
      if (n) return `r:${n.id}`;
    }
    return `s:${followNode(service.nodes)}`;
  }, [service, repair]);
  const sel = pick ?? auto;

  const runRepair = (list: WorkOrder[]) => {
    const ids = [...list].sort((a, b) => (a.robot_id === caseRobot ? -1 : b.robot_id === caseRobot ? 1 : a.robot_id.localeCompare(b.robot_id)))
      .map((w) => w.wo_id);
    if (!ids.length) return;
    setPhase('repair'); setCrew([]); setBooked(null); setPick(null);
    stop.current = streamCrew(ids, engine, (e) => setCrew((xs) => [...xs, e]), () => setPhase('idle'));
  };

  const run = () => {
    stop.current?.();
    player.clear(); setCrew([]); setBooked(null); setPick(null); setPhase('service');
    stop.current = streamCase(id, { threshold, engine }, (e) => player.push(e), () => player.whenDrained(async () => {
      bump(); setCityKey((k) => k + 1);
      const fresh = await api.get<WorkOrder[]>(`/api/cases/${id}/work_orders`).catch(() => [] as WorkOrder[]);
      setWos(fresh);
      const open = fresh.filter((w) => w.status === 'proposed' || w.status === 'open');
      if (open.length) setTimeout(() => runRepair(open), 1200); else setPhase('idle');
    }));
  };

  // Replays the saved run through the same player, so the chain animates without calling the crew again.
  const replayEvents = (evs: CaseEvent[]) => {
    if (!evs.length) return;
    stop.current?.();
    player.clear(); setCrew([]); setPick(null); setPhase('service');
    evs.forEach((e) => player.push(e));
    player.whenDrained(() => setPhase('idle'));
  };
  const replay = () => replayEvents(saved);

  // The copilot asked to replay a story: switch to it, then replay once its saved run has loaded.
  useEffect(() => {
    if (cue?.kind !== 'story') return;
    setCue(null);
    if (cue.id === id) { if (cue.replay) replayEvents(saved); return; }
    if (cue.replay) wantReplay.current = cue.id;
    setCaseId(cue.id);
  }, [cue]);

  const approveRepairs = async (plans: Plan[]) => {
    const ids = plans.filter((p) => p.feasible).map((p) => p.wo_id);
    await api.post('/api/repair/batch-approve', { wo_ids: ids });
    const mechs = [...new Set(plans.filter((p) => p.feasible).map((p) => p.mechanic))].join(', ');
    setBooked(`${PERSONAS.repair_lead.name} approved ${ids.length} repair${ids.length === 1 ? '' : 's'}. Jobs, parts, and bins are in ${mechs}'s queue.`);
    await loadWos(); bump(); setCityKey((k) => k + 1);
  };

  const approveHandoff = async () => {
    await api.post(`/api/cases/${id}/approve`, { approve: true, note: '' });
    bump(); setCityKey((k) => k + 1);
  };

  const options = FEATURED.includes(id) ? FEATURED : [id, ...FEATURED];
  const stepsDone = service.nodes.filter((n) => n.state === 'done' || n.state === 'ok').length;
  const stepsAll = service.nodes.filter((n) => n.state !== 'skipped').length;

  return (
    <div className="flex flex-col gap-s4 max-w-wide mx-auto pb-s6">
      <div className="flex items-center justify-between gap-s4 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <h1 className="font-display text-headline-lg font-semibold text-ink-primary">Watch the crew work a case</h1>
          <p className="text-sm text-ink-secondary">Each bot gets a brief, does its part, and hands the result to the next. Click any step to see what it did.</p>
        </div>
        <div className="flex items-center gap-s2 flex-wrap">
          <label className="relative">
            <span className="sr-only">Story</span>
            <select value={id} onChange={(e) => setCaseId(e.target.value)} disabled={busy}
              className="appearance-none h-9 pl-s4 pr-s8 rounded-pill bg-surface-raised border border-line-strong text-smd font-medium text-ink-primary
                         hover:border-line-hover focus:outline-none focus:border-accent-line disabled:opacity-50 transition-colors duration-fast">
              {options.map((k) => <option key={k} value={k}>{STORY[k] ?? 'Selected case'} · {k}</option>)}
            </select>
            <Icon name="chevron" size={14} className="absolute right-s4 top-1/2 -translate-y-1/2 text-ink-secondary pointer-events-none" />
          </label>
          <Button onClick={replay} disabled={busy || !saved.length} title="Play the saved run again, step by step">
            <Icon name="reset" size={14} /> Replay
          </Button>
          <Button variant="primary" onClick={run} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="play" size={14} />} {busy ? 'Crew working…' : 'Run it live'}
          </Button>
        </div>
      </div>

      <Panel kicker={<span className="flex items-center gap-2"><Workflow size={16} className="text-accent-bright" />Service crew</span>}
        dot={phase === 'service' ? 'ai' : view.decision ? 'ok' : undefined}
        action={<span className="flex items-center gap-s3">
          {pick && busy && <button onClick={() => setPick(null)} className="text-xs text-accent-bright hover:underline">Follow live</button>}
          <span className="text-xs font-medium text-ink-secondary tabular-nums px-2.5 py-1 rounded-pill bg-surface-inset border border-line">{events.length ? `${stepsDone} of ${stepsAll} steps` : 'not run yet'}</span>
        </span>}>
        <Chain nodes={service.nodes} back={service.back} selected={sel.startsWith('s:') ? sel.slice(2) : null}
          onSelect={(n) => setPick(`s:${n}`)} />
        {!events.length && !busy && (
          <p className="text-sm text-ink-secondary mt-s2">Nobody has worked this case yet. Press <span className="text-ink-primary">Run it live</span>.</p>
        )}
      </Panel>

      <AnimatePresence initial={false}>
        {repair && (
          <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: ENTER }}>
            <Panel kicker={<span className="flex items-center gap-2"><Wrench size={16} className="text-ok-text" />Repair crew · picks up the work orders</span>}
              dot={phase === 'repair' ? 'ai' : booked ? 'ok' : 'warn'}>
              <Chain nodes={repair.nodes} back={repair.back} selected={sel.startsWith('r:') ? sel.slice(2) : null}
                onSelect={(n) => setPick(`r:${n}`)} />
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-xl:grid-cols-1 gap-s4">
        <Panel className="min-h-[460px]" bodyClass="flex-1 flex flex-col">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={sel} className="flex-1 flex flex-col"
              initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: ENTER }}>
              <Detail sel={sel} view={view} crew={crew} customerName={customerName} contact={contact} resolved={resolved}
                canAct={role === 'specialist' || role === 'head'} onApproveHandoff={approveHandoff}
                onApproveRepairs={approveRepairs} booked={booked}
                pendingWos={!busy && !crew.length && view.decision ? pending : []} onRepair={() => runRepair(pending)} />
            </motion.div>
          </AnimatePresence>
          <StepNav sel={sel} onPick={setPick} steps={[...service.nodes.map((n) => ({ ...n, key: `s:${n.id}` })),
            ...(repair?.nodes ?? []).map((n) => ({ ...n, key: `r:${n.id}` }))]} />
        </Panel>

        <section className="relative rounded-panel border border-line-shell overflow-hidden min-h-[520px] max-xl:h-[60vh] shadow-card bg-[var(--map-bg)]">
          {city && map ? (
            <CityScene data={city} map={map} selected={null} onSelect={() => undefined} onContact={() => undefined}
              focus={{ robots: hot, contactId: id }} compact flyTo={fly} light={light} rain={wet} />
          ) : <Skeleton className="absolute inset-4" />}
          {hot.length > 0 && (
            <div className="absolute z-[60] left-s4 top-s4 flex flex-wrap items-center gap-s2 max-w-[80%] pointer-events-none
                            rounded-pill bg-surface-solid border border-line-strong shadow-overlay pl-s3 pr-1.5 py-1.5">
              <span className="text-xs text-ink-secondary">Robots in this case</span>
              {hot.slice(0, 7).map((r) => <Pill key={r} kind={r === caseRobot ? 'warn' : 'muted'}>{r}</Pill>)}
            </div>
          )}
          <MapLegend />
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the step card

function Detail({ sel, view, crew, customerName, contact, resolved, canAct, onApproveHandoff, onApproveRepairs, booked, pendingWos, onRepair }: {
  sel: string; view: ServiceView; crew: CrewEvent[]; customerName: string; contact?: Contact; resolved: boolean; canAct: boolean;
  onApproveHandoff: () => void; onApproveRepairs: (p: Plan[]) => void; booked: string | null; pendingWos: WorkOrder[]; onRepair: () => void;
}) {
  const [chain, nodeId] = [sel.slice(0, 1), sel.slice(2)];

  if (chain === 'r') {
    const posts = crew.filter((c): c is Post => c.type === 'post');
    if (nodeId === 'repair_lead') {
      const a = crew.find((c): c is Approval => c.type === 'approval');
      const lead = PERSONAS.repair_lead;
      if (!a) return <p className="text-sm text-ink-secondary">The plan comes here for approval once the Scheduler fits the repairs.</p>;
      const ok = a.plans.filter((p) => p.feasible);
      return (
        <div className="flex flex-col gap-s4">
          <Header glyph={lead.glyph} tone="accent" name={lead.name} sub="Fleet repair lead · a person" right={<Pill kind={booked ? 'ok' : 'warn'}>{booked ? 'Booked' : 'Needs approval'}</Pill>} />
          <Section label="Brief">
            <Brief from="scheduler" text={briefFor('Repair lead', posts)?.text ?? 'Repairs planned. Approve to book them.'} />
          </Section>
          <Section label={`The plan · ${a.feasible} of ${a.count} fit today, ${a.before_dinner_rush} back before the dinner rush`}>
            <div className="flex flex-col rounded-card border border-line overflow-hidden">
              {ok.map((p) => (
                <div key={p.wo_id} className="grid grid-cols-[64px_1fr_auto] gap-s2 px-s3 py-s2 text-sm border-t border-line first:border-t-0">
                  <span className="font-semibold text-ink-primary">{p.robot_id}</span>
                  <span className="text-ink-secondary truncate">{PART_LABEL[p.part_key]} · {p.mechanic} · {p.depot}</span>
                  <span className="text-ink-primary tabular-nums">{hhmm(p.start)}–{hhmm(p.end)}</span>
                </div>
              ))}
            </div>
            {a.runner_trips[0] && <span className="text-sm text-ink-secondary">Runner {a.runner_trips[0].runner_id} carries the parts from {a.runner_trips[0].from} to {a.runner_trips[0].to}.</span>}
          </Section>
          {booked ? <p className="text-sm text-ok-text">{booked}</p> : (
            <div><Button variant="primary" onClick={() => onApproveRepairs(a.plans)}><Icon name="check" size={14} /> Approve as {lead.name.split(' ')[0]}</Button></div>
          )}
        </div>
      );
    }
    const mine = posts.filter((p) => p.bot === nodeId);
    const b = BOTS[nodeId];
    if (!mine.length) return <div className="flex flex-col gap-s3"><p className="text-sm text-ink-secondary">{b?.name} is waiting for its turn.</p><WhatItDoes id={nodeId} /></div>;
    return (
      <div className="flex flex-col gap-s4">
        <Header glyph={b.glyph} tone={mine[0].kind === 'ai' ? 'ai' : 'neutral'} name={b.name} sub={b.role} right={<EngineMark kind={mine[0].kind} />} />
        <WhatItDoes id={nodeId} />
        {mine.map((p, i) => {
          const before = posts.slice(0, posts.indexOf(p));
          const brief = briefFor(b.name, before);
          return (
            <div key={i} className="flex flex-col gap-s4">
              {mine.length > 1 && <span className="self-start text-xs font-semibold text-ink-emphasis px-2.5 py-1 rounded-pill bg-surface-raised border border-line">{p.consult ? 'Answering a question' : `Pass ${i + 1}`}</span>}
              {brief && <Section label="Brief received"><Brief from={brief.from} text={brief.text} /></Section>}
              {p.tool && (
                <Section label="Looked up">
                  <span className="flex items-center gap-s2 text-sm"><Icon name="check" size={14} className="text-ok-text" />
                    <span className="text-ink-primary">{p.tool}</span><span className="text-ink-secondary">({p.robot_id}) → {p.source_id}</span></span>
                </Section>
              )}
              <Section label="Result">
                <p className="text-md text-ink-primary leading-relaxed">{p.say}</p>
                {p.confidence != null && <ConfidenceBar value={p.confidence} label="sure of the part" />}
              </Section>
              <Handoff to={p.to} note={p.note} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <ServiceDetail nodeId={nodeId} view={view} customerName={customerName} contact={contact} resolved={resolved} canAct={canAct}
      onApproveHandoff={onApproveHandoff} pendingWos={pendingWos} onRepair={onRepair} />
  );
}

/** What the colors on the map mean. */
function MapLegend() {
  const items = [
    { label: 'Delivery', color: 'var(--map-route)' }, { label: 'Backup', color: 'var(--map-route-backup)' },
    { label: 'Runner or stall', color: 'var(--map-route-runner)' }, { label: 'Customer', color: 'var(--map-pin-customer)', pin: true },
  ];
  return (
    <div className="absolute z-[60] left-s4 bottom-s4 flex flex-wrap items-center gap-x-s3 gap-y-1 pointer-events-none max-md:hidden
                    rounded-pill bg-surface-solid border border-line px-s3 py-1.5">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-2xs font-medium text-ink-secondary">
          {i.pin ? <span className="w-2 h-2 rounded-pill" style={{ background: i.color }} />
            : <span className="w-4 h-[3px] rounded-pill" style={{ background: i.color }} />}
          {i.label}
        </span>
      ))}
    </div>
  );
}
