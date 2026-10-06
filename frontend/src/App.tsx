import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { Component, createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api';
import { useApi } from './lib/hooks';
import type { Cue, Engine, Inbox, Role, Status } from './lib/types';
import { Button, ENTER, Icon, Segmented, Spinner } from './components/ui';
import { hhmm } from './lib/format';
import SignIn from './screens/SignIn';
import { LogoMark } from './components/Logo';
import { PersonaAvatar } from './components/PersonaAvatar';
import { PizzaProgress } from './components/Pizza';
import { DecisionToast, useDecisionQueue, type Decision } from './components/Decisions';
import Copilot from './components/Copilot';

const CityScreen = lazy(() => import('./screens/CityScreen'));
const CaseRoom = lazy(() => import('./screens/CaseRoom'));
const Cockpit = lazy(() => import('./screens/Cockpit'));
const RepairScreen = lazy(() => import('./screens/RepairScreen'));
const ScheduleScreen = lazy(() => import('./screens/ScheduleScreen'));
const WarehouseScreen = lazy(() => import('./screens/WarehouseScreen'));
const CustomerScreen = lazy(() => import('./screens/CustomerScreen'));
const AgentFloor = lazy(() => import('./screens/AgentFloor'));
const JobsScreen = lazy(() => import('./screens/JobsScreen'));
const SpecialistHome = lazy(() => import('./screens/SpecialistHome'));

export type Tab = 'home' | 'order' | 'floor' | 'city' | 'cases' | 'cockpit' | 'repair' | 'schedule' | 'warehouse' | 'jobs';
/** The city's light: the in-app clock picks it, or a presenter forces one from the Demo menu. */
export type Sky = 'live' | 'day' | 'dusk' | 'night';

export const TAB_LABEL: Record<Tab, string> = {
  home: 'Overview', order: 'My Order', floor: 'Agent Floor', city: 'Live City', cases: 'Case Room', cockpit: 'KPI Cockpit',
  repair: 'Repair Queue', schedule: 'Schedule', warehouse: 'Warehouse', jobs: 'My Jobs',
};

/** Five people. Each sees only what needs them; the bots do the rest. */
export const PERSONAS: Record<Role, { name: string; title: string; blurb: string; glyph: string; tabs: Tab[] }> = {
  customer: { name: 'Maya Chen', title: 'Customer, Eastern Market', glyph: 'MC', tabs: ['order'],
    blurb: 'Orders pizza and writes in when something goes wrong. Never sees a bot, only the answer.' },
  specialist: { name: 'Dana Kim', title: 'Care specialist', glyph: 'DK', tabs: ['home', 'floor', 'cases', 'city'],
    blurb: 'Works only what the bots hand over: refunds over $20, legal, safety. Research already done.' },
  head: { name: 'Renee Alvarez', title: 'Head of Customer Care', glyph: 'RA', tabs: ['cockpit', 'floor', 'cases', 'city'],
    blurb: 'Owns the KPIs and sets how sure the bots must be before they answer alone.' },
  repair_lead: { name: 'Imani Wright', title: 'Fleet repair lead', glyph: 'IW', tabs: ['repair', 'schedule', 'warehouse', 'city'],
    blurb: 'Approves the repair crew’s plans: which part, which mechanic, before the dinner rush.' },
  mechanic: { name: 'Lena Fischer', title: 'Mechanic, Navy Yard Depot', glyph: 'LF', tabs: ['jobs', 'city'],
    blurb: 'Gets the booked jobs with the part and bin already reserved. Starts them, marks them done.' },
};

interface Ctx {
  status: Status | null; engine: Engine; setEngine: (e: Engine) => void; threshold: number; setThreshold: (t: number) => void;
  tick: number; bump: () => void; openCase: (id: string) => void; openWorkOrder: (id: string) => void;
  caseId: string | null; workOrderId: string | null; setCaseId: (id: string | null) => void; setWorkOrderId: (id: string | null) => void;
  role: Role; inbox: Inbox | null; go: (tab: Tab) => void; switchTo: (role: Role, tab?: Tab) => void;
  /** A one-shot request from the copilot for a screen to act on (centre a robot, replay a story). `n` makes repeats distinct. */
  cue: (Cue & { n: number }) | null; setCue: (c: Cue | null) => void;
  /** Demo-only "view as": which customer the My Order screen shows, which mechanic My Jobs shows. */
  demoCustomer: string; setDemoCustomer: (id: string) => void; demoMechanic: string; setDemoMechanic: (id: string) => void;
  sky: Sky; setSky: (s: Sky) => void; rain: boolean; setRain: (r: boolean) => void;
  /** A person's decision, held for the undo window before it is sent. */
  queueDecision: (d: Decision) => void; pendingDecision: string | null;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

function readPref<T extends string>(k: string): T | null {
  try { return localStorage.getItem(k) as T | null; } catch { return null; }
}
function writePref(k: string, v: string | null) {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode: not remembered */ }
}

export default function App() {
  // Deep links (?as=specialist&tab=floor&case=K-9003) let a presenter keep one browser tab per person.
  const params = new URLSearchParams(window.location.search);
  const linked = params.get('as') as Role | null;
  const saved = linked && PERSONAS[linked] ? linked : readPref<Role>('sb-persona');
  const [role, setRoleState] = useState<Role | null>(saved && PERSONAS[saved] ? saved : null);
  const linkedTab = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(role ? (linkedTab && PERSONAS[role].tabs.includes(linkedTab) ? linkedTab : PERSONAS[role].tabs[0]) : 'floor');
  const [engine, setEngine] = useState<Engine>('offline');
  const [threshold, setThreshold] = useState(0.75);
  const [tick, setTick] = useState(0);
  const [caseId, setCaseId] = useState<string | null>(params.get('case'));
  const [workOrderId, setWorkOrderId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [cue, setCueState] = useState<(Cue & { n: number }) | null>(null);
  const [demoCustomer, setDemoCustomer] = useState('C-1042');
  const [demoMechanic, setDemoMechanic] = useState('M-04');
  const [sky, setSky] = useState<Sky>((params.get('sky') as Sky) || 'live');
  const [rain, setRain] = useState(params.get('rain') === '1');
  const [copilotSlot, setCopilotSlot] = useState<HTMLElement | null>(null);
  const setCue = useCallback((c: Cue | null) => setCueState(c ? { ...c, n: Date.now() } : null), []);
  const { data: status, reload } = useApi<Status>('/api/status', tick);
  const { data: inbox } = useApi<Inbox>('/api/inbox', tick);
  const decisions = useDecisionQueue();
  const reduce = useReducedMotion();

  useEffect(() => { if (status) setEngine((e) => (e === 'offline' && status.engine === 'live' ? 'live' : e)); }, [status?.engine]);

  const switchTo = useCallback((r: Role, t?: Tab) => {
    setRoleState(r); writePref('sb-persona', r); setTab(t ?? PERSONAS[r].tabs[0]);
  }, []);
  const signOut = () => { setRoleState(null); writePref('sb-persona', null); };
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const go = useCallback((t: Tab) => setTab(t), []);
  // Cross-links land on whoever owns that work: a case goes to the specialist's view unless this persona has one.
  const openCase = useCallback((id: string) => {
    setCaseId(id);
    if (role && PERSONAS[role].tabs.includes('cases')) setTab('cases'); else switchTo('specialist', 'cases');
  }, [role, switchTo]);
  const openWorkOrder = useCallback((id: string) => { setWorkOrderId(id); switchTo('repair_lead', 'repair'); }, [switchTo]);

  // The crew works every unworked contact on its own as soon as the console opens (and again after a reset),
  // so the Case Room opens on a worked queue where only the handoffs need a person.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!status) return;
    api.post('/api/queue/work', { engine: status.engine, threshold }).then(bump).catch(() => { /* status shows the queue */ });
  }, [status?.engine, generation]);
  useEffect(() => {
    if (!status?.queue.running) return;
    const t = setTimeout(bump, 800);
    return () => clearTimeout(t);
  }, [status, bump]);

  const reset = async () => {
    setResetting(true);
    await api.post('/api/reset');
    setCaseId(null); setWorkOrderId(null); setResetting(false); setGeneration((g) => g + 1); bump();
  };

  // Demo control: a contact the crew hands to a person, worked in the background, so the copilot's nudge fires on cue.
  const dropCase = async () => {
    await api.post('/api/demo/new-case', { engine: status?.engine, threshold });
    bump();
  };

  const queueDecision = decisions.queue;
  const pendingDecision = decisions.pending?.id ?? null;
  const ctx = useMemo<Ctx>(() => ({ status, engine, setEngine, threshold, setThreshold, tick, bump, openCase, openWorkOrder,
    caseId, workOrderId, setCaseId, setWorkOrderId, role: role ?? 'specialist', inbox, go, switchTo, cue, setCue,
    demoCustomer, setDemoCustomer, demoMechanic, setDemoMechanic, sky, setSky, rain, setRain, queueDecision, pendingDecision }),
  [status, engine, threshold, tick, bump, openCase, openWorkOrder, caseId, workOrderId, role, inbox, go, switchTo, cue, setCue,
    demoCustomer, demoMechanic, sky, rain, queueDecision, pendingDecision]);

  // Tabs slide in the direction you moved: right of the current tab comes in from the right.
  const order = role ? PERSONAS[role].tabs : [];
  const prevTab = useRef(tab);
  const dir = order.indexOf(tab) >= order.indexOf(prevTab.current) ? 1 : -1;
  useEffect(() => { prevTab.current = tab; }, [tab]);

  if (!role) {
    return (
      <AppCtx.Provider value={ctx}>
        <LayoutGroup><SignIn onPick={(r) => switchTo(r)} inbox={inbox} status={status} /></LayoutGroup>
      </AppCtx.Provider>
    );
  }

  const p = PERSONAS[role];
  const r = status?.robots ?? {};
  const offRoad = (r.fault ?? 0) + (r.grounded ?? 0) + (r.in_repair ?? 0);
  const engines: { id: Engine; label: string }[] = [
    ...(status?.engine === 'live' ? [{ id: 'live' as Engine, label: 'Claude' }] : []),
    { id: 'offline', label: 'Rules' },
    ...((status?.recordings.length ?? 0) > 0 ? [{ id: 'replay' as Engine, label: 'Replay' }] : []),
  ];
  const waiting = inboxCount(role, inbox);
  const light = role === 'customer';

  return (
    <AppCtx.Provider value={ctx}>
      <LayoutGroup>
      {/* The customer stands on the other side of the counter: their app is cream and tomato, the staff console is cast iron. */}
      <div data-theme={light ? 'light' : undefined} className="grain flex h-screen overflow-hidden bg-surface text-ink-primary">
      <div className="flex flex-col flex-1 min-w-0">
        <motion.header initial={reduce ? false : { y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.45, ease: ENTER, delay: 0.1 }}
          className="relative z-30 flex items-center gap-s4 px-s5 max-md:px-s4 h-header bg-surface-solid border-b border-line-shell shrink-0">
          <div className="flex items-center gap-s3 min-w-0 shrink-0">
            <LogoMark size={30} />
            <div className="flex flex-col leading-none gap-1 min-w-0 max-xl:hidden">
              <span className="font-display text-[15px] font-bold text-ink-primary">Slice<span className="text-accent-bright">Bot</span></span>
              <span className="text-2xs text-ink-secondary truncate">{p.title}</span>
            </div>
          </div>
          <span className="w-px h-6 bg-line max-xl:hidden" />
          <Tabs id="top" tabs={p.tabs} tab={tab} setTab={setTab} inbox={inbox} className="max-lg:hidden flex-1 overflow-x-auto [scrollbar-width:none]" />

          <div className="ml-auto flex items-center gap-s2 shrink-0">
            {status?.queue.running && (
              <span className="flex items-center gap-s2 pr-s2 text-xs text-ink-secondary tabular-nums max-lg:hidden" title="The crew is working the inbox">
                <PizzaProgress done={status.queue.done} total={status.queue.total} />
                Crew working {status.queue.done}/{status.queue.total}
              </span>
            )}
            <span ref={setCopilotSlot} className="relative" />
            <DemoMenu status={status} engines={engines} engine={engine} setEngine={setEngine} offRoad={offRoad}
              onReset={reset} resetting={resetting} onDrop={dropCase} role={role} />
            <button onClick={signOut} title="Sign in as someone else"
              className="flex items-center gap-s2 h-10 pl-1 pr-s3 rounded-pill border border-line bg-surface-raised hover:bg-surface-hover
                         hover:border-line-hover transition-colors duration-fast ease-out">
              <PersonaAvatar role={role} size={30} layoutId="persona-avatar" />
              <span className="text-smd font-medium text-ink-primary max-md:hidden">{p.name}</span>
              {waiting > 0 && <span className="text-xs font-semibold px-2 py-0.5 rounded-pill bg-warn-fill text-warn-text tabular-nums">{waiting}</span>}
              <Icon name="logout" size={14} className="text-ink-secondary max-lg:hidden" />
            </button>
          </div>
        </motion.header>
        <Tabs id="below" tabs={p.tabs} tab={tab} setTab={setTab} inbox={inbox}
          className="lg:hidden bg-surface-solid border-b border-line-shell px-s3 py-2 shrink-0 overflow-x-auto" />

        <main className="flex-1 overflow-y-auto overflow-x-hidden p-s6 max-md:p-s4 min-h-0">
          {/* Enter-only on purpose: waiting for the old screen's exit let a Case Room that was still
              streaming a run block every other tab from appearing. */}
          <motion.div key={`${role}-${tab}`} className="h-full"
              initial={reduce ? false : { opacity: 0, x: 18 * dir }} animate={{ opacity: 1, x: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.3, ease: ENTER }}
              onAnimationComplete={() => reload()}>
              <ScreenBoundary>
              <Suspense fallback={<div className="p-s6"><Spinner label="Loading view…" /></div>}>
                {tab === 'home' && <SpecialistHome />}
                {tab === 'order' && <CustomerScreen />}
                {tab === 'floor' && <AgentFloor />}
                {tab === 'city' && <CityScreen />}
                {tab === 'cases' && <CaseRoom />}
                {tab === 'cockpit' && <Cockpit />}
                {tab === 'repair' && <RepairScreen />}
                {tab === 'schedule' && <ScheduleScreen />}
                {tab === 'warehouse' && <WarehouseScreen />}
                {tab === 'jobs' && <JobsScreen />}
              </Suspense>
              </ScreenBoundary>
          </motion.div>
        </main>
      </div>
      <Copilot role={role} tab={tab} slot={copilotSlot} waiting={waiting} />
      <DecisionToast {...decisions} />
      </div>
      </LayoutGroup>
    </AppCtx.Provider>
  );
}

function Tabs({ id, tabs, tab, setTab, inbox, className = '' }: {
  id: string; tabs: Tab[]; tab: Tab; setTab: (t: Tab) => void; inbox: Inbox | null; className?: string;
}) {
  return (
    <nav className={`flex items-center gap-0.5 min-w-0 ${className}`}>
      {tabs.map((t) => {
        const on = t === tab;
        const badge = t === 'cases' ? inbox?.specialist : t === 'repair' ? inbox?.repair_lead : 0;
        return (
          <button key={t} onClick={() => setTab(t)} aria-current={on ? 'page' : undefined}
            className={`relative flex items-center gap-2 px-s3 h-9 rounded-ctl text-smd font-medium whitespace-nowrap
                        transition-colors duration-fast ease-out ${on ? 'text-ink-primary' : 'text-ink-secondary hover:text-ink-primary'}`}>
            {on && <motion.span layoutId={`tab-${id}`} className="absolute inset-0 rounded-ctl bg-surface-raised border border-line-strong"
              transition={{ type: 'spring', stiffness: 420, damping: 38 }} />}
            {on && <motion.span layoutId={`tab-line-${id}`} className="absolute left-s3 right-s3 -bottom-[12px] h-0.5 rounded-pill bg-accent max-lg:hidden"
              transition={{ type: 'spring', stiffness: 420, damping: 38 }} />}
            <span className="relative">{TAB_LABEL[t]}</span>
            {!!badge && (
              <span title="Waiting for a person"
                className="relative text-xs font-semibold px-1.5 py-0.5 rounded-pill min-w-[20px] text-center tabular-nums bg-warn-fill text-warn-text">
                {badge}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Presenter controls (engine, view-as, sky, reset, the live fleet line) in one place, out of everyone's way. */
function DemoMenu({ status, engines, engine, setEngine, offRoad, onReset, resetting, onDrop, role }: {
  status: Status | null; engines: { id: Engine; label: string }[]; engine: Engine; setEngine: (e: Engine) => void;
  offRoad: number; onReset: () => void; resetting: boolean; onDrop: () => Promise<void>; role: Role;
}) {
  const { demoCustomer, setDemoCustomer, demoMechanic, setDemoMechanic, sky, setSky, rain, setRain } = useApp();
  const [open, setOpen] = useState(false);
  const [drop, setDrop] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { data: people } = useApi<{ customer_id: string; name: string }[]>(role === 'customer' ? '/api/customers' : null);
  const { data: mechs } = useApi<{ mechanic_id: string; name: string; depot_id: string }[]>(role === 'mechanic' ? '/api/mechanics' : null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const r = status?.robots ?? {};
  const w = status?.weather;
  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" onClick={() => setOpen(!open)} title="Demo controls">
        <Icon name="sliders" /> <span className="max-md:hidden">Demo</span><Icon name="chevron" size={12} />
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div initial={reduce ? false : { opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }} transition={{ duration: 0.18, ease: ENTER }} style={{ transformOrigin: 'top right' }}
            className="menu absolute right-0 top-11 z-50 w-[320px] rounded-card bg-surface-solid border border-line-strong shadow-overlay p-s4 flex flex-col gap-s4">
            <MenuRow label="Engine">
              <Segmented id="engine" size="sm" options={engines} value={engine} onChange={setEngine} />
              {status?.engine === 'offline' && (
                <span className="text-xs text-ink-secondary leading-snug">
                  Running on the rules engine. Add ANTHROPIC_API_KEY to slicebot/.env and restart to run every bot on Claude.
                </span>
              )}
            </MenuRow>
            {role === 'customer' && people && (
              <MenuRow label="Viewing as customer">
                <Segmented id="who" size="sm" value={demoCustomer} onChange={setDemoCustomer}
                  options={people.slice(0, 4).map((x) => ({ id: x.customer_id, label: x.name.split(' ')[0] }))} />
              </MenuRow>
            )}
            {role === 'mechanic' && mechs && (
              <MenuRow label="Viewing as mechanic">
                <Segmented id="mech" size="sm" value={demoMechanic} onChange={setDemoMechanic}
                  options={mechs.filter((m) => m.depot_id === 'SOUTH').map((m) => ({ id: m.mechanic_id, label: m.name.split(' ')[0] }))} />
              </MenuRow>
            )}
            <MenuRow label="City light">
              <Segmented id="sky" size="sm" value={sky} onChange={setSky}
                options={[{ id: 'live', label: 'Clock' }, { id: 'day', label: 'Day' }, { id: 'dusk', label: 'Dusk' }, { id: 'night', label: 'Night' }]} />
              <label className="flex items-center gap-s2 text-xs text-ink-secondary cursor-pointer select-none">
                <input type="checkbox" checked={rain} onChange={(e) => setRain(e.target.checked)} className="accent-[var(--accent)]" />
                Rain on the map {w && w.precip_prob >= 0.5 ? '(forecast says rain)' : ''}
              </label>
            </MenuRow>
            {status && (
              <div className="flex flex-col gap-1 text-xs text-ink-secondary tabular-nums border-t border-line pt-s3">
                <span>{status.robots_total} robots · {r.active ?? 0} active · {offRoad} off the road</span>
                <span>clock {hhmm(status.clock)}{w ? ` · ${Math.round(w.temp_f)}°F ${w.summary.toLowerCase()}` : ''}</span>
              </div>
            )}
            <div className="flex flex-col gap-s2 border-t border-line pt-s3">
              <Button onClick={() => { setDrop('Sending…'); onDrop().then(() => setDrop('Sent. The crew is working it; watch the pizza.'))
                  .catch((e: Error) => setDrop(e.message)); }} title="A customer writes in with something only a person can decide">
                <Icon name="send" /> Drop in a new case
              </Button>
              {drop && <span className="text-xs text-ink-secondary leading-snug">{drop}</span>}
              <Button onClick={() => { onReset(); setOpen(false); }} disabled={resetting} title="Rebuild the demo data from the seed">
                <Icon name="reset" /> {resetting ? 'Resetting…' : 'Reset demo data'}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-s2"><span className="text-sm font-medium text-ink-emphasis">{label}</span>{children}</div>;
}

/** One broken screen shows its error instead of unmounting the whole console. Keyed by role and tab, so it resets on navigation. */
class ScreenBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-s6 flex flex-col items-start gap-s3">
        <p className="text-smd text-ink-primary">This view hit an error.</p>
        <code className="text-xs font-code text-ink-secondary">{this.state.error.message}</code>
        <Button variant="ghost" onClick={() => window.location.reload()}><Icon name="reset" /> Reload</Button>
      </div>
    );
  }
}

export function inboxCount(role: Role, inbox: Inbox | null): number {
  if (!inbox) return 0;
  if (role === 'specialist') return inbox.specialist;
  if (role === 'repair_lead') return inbox.repair_lead;
  if (role === 'mechanic') return inbox.mechanic['M-04'] ?? 0;
  return 0;
}
