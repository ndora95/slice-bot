/* The Care specialist's landing page. One question drives it: "is anything waiting on me?" The next case is the hero: the
 * customer's words, the crew's recommendation, and the buttons to act. Approving collapses the card into today's bar,
 * where it waits out the undo window and then joins "closed by you". Under it, three KPIs against their targets, where
 * today's contacts went, what the crew has been doing, and the way into the Agent Floor. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Bot, HandCoins, Timer, Workflow, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { PERSONAS, useApp } from '../App';
import { Roll } from '../components/Roll';
import { Button, ENTER, Icon, Panel, Pill, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { hhmm, pct, sentence, usd } from '../lib/format';
import { useApi } from '../lib/hooks';
import { FEATURED, STORY } from '../lib/stories';
import type { CaseResult, Contact, Kpis } from '../lib/types';

const WAIT_TARGET_MIN = 15;
const CONTAIN_TARGET = 0.8;
const minsBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
const ago = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`);
const needsYou = (c: Contact) => c.decision === 'human' && !c.resolved_by;
const MORPH = { type: 'spring' as const, stiffness: 210, damping: 30 };

export default function SpecialistHome() {
  const { tick, status, pendingDecision } = useApp();
  const { data: contacts } = useApi<Contact[]>('/api/contacts', tick);
  const { data: k } = useApi<Kpis>('/api/kpis', tick);
  const reduce = useReducedMotion();

  if (!contacts || !k) {
    return <div className="flex flex-col gap-s4 max-w-wide mx-auto"><Skeleton className="h-12" /><Skeleton className="h-64" /><Skeleton className="h-40" /></div>;
  }

  const now = status?.clock ?? new Date().toISOString();
  // A case whose decision is in its undo window has left the queue, visually: it is a chip on today's bar.
  const yours = contacts.filter((c) => needsYou(c) && c.contact_id !== pendingDecision)
    .map((c) => ({ ...c, waited: minsBetween(c.received_at, now) })).sort((a, b) => b.waited - a.waited);
  const first = PERSONAS.specialist.name.split(' ')[0];
  const hour = Number(now.slice(11, 13));
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="flex flex-col gap-s5 max-w-wide mx-auto pb-s6">
      <motion.header initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.35, ease: ENTER }}>
        <h1 className="font-display text-headline-lg font-semibold text-ink-primary">{greet}, {first}.</h1>
        <p className="text-md text-ink-secondary mt-s2">
          {yours.length === 0 ? 'Nothing is waiting on you. The crew is handling the inbox.'
            : `${yours.length} case${yours.length === 1 ? ' needs' : 's need'} your decision. The research is already done.`}
        </p>
      </motion.header>

      <AnimatePresence initial={false}>
        {yours.length ? <NextUp key={yours[0].contact_id} c={yours[0]} more={yours.slice(1)} /> : <AllClear key="clear" />}
      </AnimatePresence>

      <Today contacts={contacts} />

      <KpiCards contacts={contacts} k={k} oldest={yours[0]?.waited} now={now} />

      <div className="grid grid-cols-[1fr_400px] max-xl:grid-cols-1 gap-s4 items-start">
        <Activity contacts={contacts} />
        <FloorCard />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- next up

function NextUp({ c, more }: { c: Contact & { waited: number }; more: (Contact & { waited: number })[] }) {
  const { tick, bump, openCase, queueDecision } = useApp();
  const { data } = useApi<{ result: CaseResult | null }>(`/api/cases/${c.contact_id}`, tick);
  const reduce = useReducedMotion();
  const r = data?.result;
  const h = r?.handoff;
  const money = (r?.actions ?? []).find((a) => a.amount);
  const who = c.customer_name?.split(' ')[0] ?? 'the visitor';
  const decide = (ok: boolean) => queueDecision({
    id: c.contact_id,
    label: ok ? `Approved${money ? ` the ${usd(money.amount)} ${human(money.type.replace(/^issue_/, ''))}` : ''} for ${who}` : `Declined ${who}'s request`,
    commit: () => api.post(`/api/cases/${c.contact_id}/approve`, { approve: ok }),
    after: bump,
  });
  const late = c.waited > WAIT_TARGET_MIN;
  return (
    <motion.section exit={reduce ? undefined : { opacity: 0, transition: { duration: 0.12 } }} className="relative isolate">
      {/* the card's body is its own layer, so on approval it can fly into today's bar while the words fade */}
      <motion.div layoutId={`decision-${c.contact_id}`} transition={MORPH} aria-hidden
        className="absolute inset-0 -z-10 rounded-panel bg-surface-panel border border-accent-line" />
      <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: ENTER, delay: 0.05 }}
        className="grid grid-cols-[1fr_320px] max-lg:grid-cols-1">
        <div className="p-s6 max-md:p-s4 flex flex-col gap-s4 min-w-0">
          <div className="flex items-center gap-s2 flex-wrap">
            <Pill kind="accent">Next up</Pill>
            <span className="text-sm text-ink-secondary">{c.customer_name ?? 'Web chat visitor'} · {c.contact_id}</span>
            <span className={`text-sm ${late ? 'text-warn-text' : 'text-ink-secondary'}`}>· waiting {ago(c.waited)}</span>
          </div>
          <h2 className="font-display text-headline-md font-semibold text-ink-primary">
            {money ? <>{sentence(money.type)} of <span className="text-accent-bright">{usd(money.amount)}</span> needs your call</> : h ? 'The crew needs your decision' : 'A case needs your decision'}
          </h2>
          <blockquote className="text-lg text-ink-primary leading-relaxed pl-s4 border-l-2 border-accent">“{c.message}”</blockquote>
          {h ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">The crew recommends</span>
              <p className="text-md text-ink-emphasis leading-relaxed max-w-[70ch]">{h.recommendation}</p>
            </div>
          ) : <Skeleton className="h-10" />}
          <div className="flex items-center gap-s2 flex-wrap pt-s1">
            <Button variant="primary" size="lg" onClick={() => decide(true)}>
              <Icon name="check" size={16} /> {money ? `Approve ${usd(money.amount)}` : 'Approve'}
            </Button>
            <Button size="lg" onClick={() => openCase(c.contact_id)}>Open the case <Icon name="arrow" size={15} /></Button>
            <Button variant="ghost" size="lg" onClick={() => decide(false)}>Decline</Button>
          </div>
        </div>
        <aside className="m-px border-l border-line max-lg:border-l-0 max-lg:border-t bg-surface-inset rounded-r-[17px] max-lg:rounded-r-none max-lg:rounded-b-[17px] p-s5 flex flex-col gap-s4">
          <Fact label="Why it came to you" value={r?.reasons?.[0] ?? '…'} />
          <Fact label="Crew confidence" value={r ? pct(r.confidence) : '…'} big />
          {h?.policy_source_id && <Fact label="Policy" value={h.policy_source_id.replace(/^doc:/, '').replace(/#/, ' · ').replace(/-/g, ' ')} />}
          {more.length > 0 && (
            <div className="flex flex-col gap-1 pt-s3 border-t border-line">
              <span className="text-sm font-medium text-ink-secondary">Also waiting · {more.length}</span>
              {more.slice(0, 3).map((m) => (
                <button key={m.contact_id} onClick={() => openCase(m.contact_id)}
                  className="text-left text-sm text-ink-primary hover:text-accent-bright truncate transition-colors duration-fast">
                  {m.customer_name ?? 'Web chat'} · {ago(m.waited)}
                </button>
              ))}
            </div>
          )}
        </aside>
      </motion.div>
    </motion.section>
  );
}

const human = (s: string) => s.replace(/_/g, ' ');

function Fact({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-ink-secondary">{label}</span>
      <span className={`text-ink-primary leading-snug ${big ? 'font-display text-metric font-semibold' : 'text-smd'}`}>{big ? <Roll value={value} /> : value}</span>
    </div>
  );
}

function AllClear() {
  const reduce = useReducedMotion();
  return (
    <motion.section initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0 }}
      transition={{ duration: 0.35, ease: ENTER }}
      className="surface-card rounded-panel p-s6 flex items-center gap-s4">
      <span className="grid place-items-center w-12 h-12 rounded-pill bg-ok-fill text-ok-text shrink-0"><Icon name="check" size={22} /></span>
      <div>
        <h2 className="font-display text-lg font-semibold text-ink-primary">You&apos;re all caught up</h2>
        <p className="text-sm text-ink-secondary">Cases only come to you when the crew isn&apos;t sure, or policy says a person decides: refunds over $20, legal, or safety.</p>
      </div>
    </motion.section>
  );
}

// ---------------------------------------------------------------- kpis

/** Oldest handoff still waiting, at evenly spaced moments from the first contact to now. Only cases that are still open
 *  count, and they were open at every earlier moment too, so each point is exact. */
function waitTrend(contacts: Contact[], now: string): number[] {
  const times = contacts.map((c) => Date.parse(c.received_at));
  if (!times.length) return [];
  const t0 = Math.min(...times), t1 = Date.parse(now);
  const open = contacts.filter(needsYou).map((c) => Date.parse(c.received_at));
  return Array.from({ length: 16 }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / 15;
    return Math.max(0, ...open.filter((r) => r <= t).map((r) => (t - r) / 60000));
  });
}

/** Share answered by the crew, as a running rate across today's contacts in the order they arrived. */
function containTrend(contacts: Contact[]): number[] {
  let crew = 0, decided = 0;
  return [...contacts].sort((a, b) => a.received_at.localeCompare(b.received_at)).flatMap((c) => {
    if (c.decision === 'auto') crew++;
    if (c.decision) decided++;
    return decided ? [crew / decided] : [];
  });
}

/** Refunds and credits as a running total, in the order they were issued. */
function moneyTrend(k: Kpis): number[] {
  let total = 0;
  return (k.money_events ?? []).map((m) => (total += Number(m.amount)));
}

function KpiCards({ contacts, k, oldest, now }: { contacts: Contact[]; k: Kpis; oldest?: number; now: string }) {
  const reduce = useReducedMotion();
  const crew = contacts.filter((c) => c.decision === 'auto').length;
  const decided = crew + contacts.filter(needsYou).length + contacts.filter((c) => c.resolved_by).length;
  const contain = decided ? crew / decided : 0;
  const byCrew = k.money.filter((m) => m.created_by === 'agent').reduce((a, m) => a + m.total, 0);
  const byPeople = k.money.filter((m) => m.created_by !== 'agent').reduce((a, m) => a + m.total, 0);
  const waitOk = oldest == null || oldest <= WAIT_TARGET_MIN;
  const containOk = !decided || contain >= CONTAIN_TARGET;
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { delay: 0.1, duration: 0.35, ease: ENTER }}
      className="surface-card rounded-panel grid grid-cols-3 max-md:grid-cols-1 overflow-hidden">
      <Kpi icon={Timer} value={oldest != null ? ago(oldest) : 'none'} label="Oldest waiting" target={`target under ${WAIT_TARGET_MIN} min`}
        ok={waitOk} trend={waitTrend(contacts, now)} color={waitOk ? 'var(--status-ok)' : 'var(--status-warn)'} />
      <Kpi icon={Bot} value={decided ? pct(contain) : '—'} label="Answered by the crew" target={`target ${pct(CONTAIN_TARGET)}`}
        ok={containOk} trend={containTrend(contacts)} color="var(--series-1)" border />
      <Kpi icon={HandCoins} value={usd(byCrew + byPeople)} label="Refunds and credits" target={`${usd(byCrew)} by the crew · ${usd(byPeople)} by people`}
        trend={moneyTrend(k)} color="var(--accent)" border />
    </motion.div>
  );
}

function Kpi({ icon: I, value, label, target, ok, trend, color, border }: {
  icon: LucideIcon; value: string; label: string; target: string; ok?: boolean; trend: number[]; color: string; border?: boolean;
}) {
  return (
    <div className={`relative px-s5 py-s4 flex items-center gap-s4 min-h-[112px] ${border ? 'border-l border-line max-md:border-l-0 max-md:border-t' : ''}`}>
      <div className="flex flex-col gap-s2 min-w-0 flex-1">
        <span className="flex items-center gap-s2 text-sm font-medium text-ink-secondary">
          <I size={15} style={{ color }} />{label}
        </span>
        <span className="font-display text-metric font-semibold leading-none text-ink-primary"><Roll value={value} /></span>
        <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
          {ok != null && <span className={`w-1.5 h-1.5 rounded-pill ${ok ? 'bg-ok' : 'bg-warn'}`} />}
          {ok === false ? <span className="text-warn-text">{target}</span> : target}
        </span>
      </div>
      <TrendLine values={trend} color={color} />
    </div>
  );
}

/** A small smooth sparkline beside the KPI, with a dot on today's value. */
function TrendLine({ values, color }: { values: number[]; color: string }) {
  const id = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  if (values.length < 2) return <span className="w-[120px] shrink-0" />;
  const W = 120, H = 48, lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (W - 6) + 1, H - 6 - ((v - lo) / span) * (H - 14)] as const);
  // Catmull-Rom through the points, as cubic Béziers, so the line is smooth without overshooting much.
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  const end = pts[pts.length - 1];
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="w-[120px] h-[48px] shrink-0 overflow-visible">
      <defs>
        <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: color }} stopOpacity="0.1" /><stop offset="1" style={{ stopColor: color }} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${end[0]},${H} L${pts[0][0]},${H} Z`} fill={`url(#fill-${id})`} />
      <motion.path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round"
        initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.7, ease: ENTER, delay: 0.2 }} />
      <circle cx={end[0]} cy={end[1]} r={3} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------- today

function Today({ contacts }: { contacts: Contact[] }) {
  const { pendingDecision } = useApp();
  const reduce = useReducedMotion();
  const total = contacts.length || 1;
  const pending = contacts.find((c) => c.contact_id === pendingDecision);
  const segs = [
    { n: contacts.filter((c) => c.decision === 'auto').length, label: 'Answered by the crew', bar: 'bg-ok', dot: 'bg-ok' },
    { n: contacts.filter((c) => c.resolved_by).length, label: 'Closed by you', bar: 'bg-accent', dot: 'bg-accent' },
    { n: contacts.filter((c) => needsYou(c) && c.contact_id !== pendingDecision).length, label: 'Waiting on you', bar: 'bg-warn', dot: 'bg-warn' },
    { n: contacts.filter((c) => !c.decision).length, label: 'Crew working', bar: 'bg-ai', dot: 'bg-ai' },
  ].filter((s) => s.n > 0);

  return (
    <Panel kicker={`Today · ${contacts.length} contacts`} delay={0.08}>
      <div className="flex flex-col gap-s4">
        <div className="flex items-center h-7 gap-1" role="img"
          aria-label={segs.map((s) => `${s.n} ${s.label.toLowerCase()}`).join(', ')}>
          {segs.map((s, i) => (
            <motion.span key={s.label} layout className={`h-3 rounded-pill ${s.bar}`}
              initial={reduce ? false : { width: 0 }} animate={{ width: `${(s.n / total) * 100}%` }}
              transition={reduce ? { duration: 0 } : { delay: 0.15 + i * 0.08, duration: 0.6, ease: ENTER }} />
          ))}
          {/* the decision in its undo window: the card that just collapsed, now a chip at the end of the bar */}
          <AnimatePresence>
            {pending && (
              <motion.span key={pending.contact_id} layoutId={`decision-${pending.contact_id}`} transition={MORPH}
                className="h-7 shrink-0 rounded-pill bg-accent-fill border border-accent-line flex items-center gap-1.5 px-s3 text-xs font-semibold text-accent-bright whitespace-nowrap">
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="flex items-center gap-1.5">
                  <Icon name="check" size={12} />{pending.customer_name?.split(' ')[0] ?? 'Visitor'} · sending
                </motion.span>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="flex flex-wrap gap-x-s5 gap-y-s2">
          {segs.map((s) => (
            <span key={s.label} className="flex items-center gap-s2 text-sm text-ink-secondary">
              <span className={`w-2 h-2 rounded-pill ${s.dot}`} />
              <span className="font-semibold tabular-nums text-ink-primary">{s.n}</span>{s.label}
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- activity and the way to the floor

function Activity({ contacts }: { contacts: Contact[] }) {
  const { openCase } = useApp();
  const rows = [...contacts].sort((a, b) => b.received_at.localeCompare(a.received_at)).slice(0, 6);
  const line = (c: Contact) => {
    const who = c.customer_name?.split(' ')[0] ?? 'A web chat visitor';
    if (!c.decision) return { icon: 'dot', tone: 'text-ai bg-ai-fill', text: `Crew is working on ${who}'s message` };
    if (c.resolved_by) return { icon: 'person', tone: 'text-accent-bright bg-accent-fill', text: `You closed ${who}'s case` };
    if (c.decision === 'human') return { icon: 'forward', tone: 'text-warn-text bg-warn-fill', text: `Crew handed ${who}'s case to you` };
    return { icon: 'check', tone: 'text-ok-text bg-ok-fill', text: `Crew answered ${who}` };
  };
  // The same status words the Case Room uses, as soft badges.
  const badge = (c: Contact) => !c.decision ? <Pill kind="ai">Crew working</Pill>
    : c.resolved_by ? <Pill kind="muted">Specialist closed</Pill>
    : c.decision === 'human' ? <Pill kind="warn">Specialist</Pill> : <Pill kind="ok">Resolved</Pill>;
  return (
    <Panel kicker="Recent activity" delay={0.14}>
      <ul className="flex flex-col -mx-s2">
        {rows.map((c) => {
          const l = line(c);
          return (
            <li key={c.contact_id}>
              <button onClick={() => openCase(c.contact_id)}
                className="w-full text-left grid grid-cols-[36px_1fr_auto] items-center gap-s3 px-s2 py-s3 rounded-card hover:bg-surface-raised transition-colors duration-fast ease-out">
                <span className={`grid place-items-center w-9 h-9 rounded-pill ${l.tone}`}><Icon name={l.icon} size={15} /></span>
                <span className="min-w-0">
                  <span className="block text-smd font-medium text-ink-primary">{l.text}</span>
                  <span className="block text-sm text-ink-secondary truncate">{c.message}</span>
                </span>
                <span className="flex flex-col items-end gap-1.5">
                  <span className="flex items-center gap-1.5 max-md:hidden">
                    {badge(c)}
                    <Pill kind={c.verified ? 'ok' : 'muted'}>{c.verified ? 'Verified, app' : 'Unverified, web chat'}</Pill>
                  </span>
                  <span className="text-xs text-ink-secondary tabular-nums">{hhmm(c.received_at)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function FloorCard() {
  const { setCaseId, go } = useApp();
  const watch = (id: string) => { setCaseId(id); go('floor'); };
  return (
    <Panel kicker={<span className="flex items-center gap-2"><Workflow size={16} className="text-ai" />Agent Floor</span>} delay={0.2}>
      <div className="flex flex-col gap-s4">
        <p className="text-sm text-ink-secondary leading-relaxed">Watch a case move bot to bot: who got the brief, what they looked up, and what they handed on.</p>
        <div className="grid grid-cols-2 gap-s2">
          {FEATURED.map((id) => (
            <button key={id} onClick={() => watch(id)}
              className="group text-left rounded-card border border-line bg-surface-raised px-s3 py-s3 hover:border-accent-line hover:bg-accent-fill
                         transition-colors duration-fast ease-out">
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink-secondary group-hover:text-accent-bright tabular-nums">
                <span className="grid place-items-center w-5 h-5 rounded-pill bg-surface-hover group-hover:bg-accent group-hover:text-[var(--accent-ink)] transition-colors duration-fast">
                  <Icon name="play" size={9} /></span>{id}
              </span>
              <span className="block text-sm text-ink-primary leading-snug mt-1.5">{STORY[id]}</span>
            </button>
          ))}
        </div>
        <Button onClick={() => go('floor')}>Open the Agent Floor <Icon name="arrow" size={14} /></Button>
      </div>
    </Panel>
  );
}
