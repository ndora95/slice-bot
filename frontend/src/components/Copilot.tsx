/* SliceBot Copilot: the help panel every persona opens from the pizza in the corner.
 * It pushes the console aside rather than covering it, answers from the same tools the crew uses, and shows each tool
 * call as it runs. It never changes data on its own: approving a case, a goodwill credit, a repair plan, or a new
 * threshold comes back as a card, and the person's click on that card calls the same endpoint the console's own button
 * does. It can move the screen (Live City on a robot, a story replayed on the Agent Floor), nudge when new work lands,
 * and walk a presenter through the 60-second story. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { inboxCount, PERSONAS, TAB_LABEL, useApp, type Tab } from '../App';
import { api, streamCopilot } from '../lib/api';
import { hhmm, sentence } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { CaseResult, CopilotCard, CopilotManifest, CopilotSource, CopilotStep, Cue, Inbox, Role } from '../lib/types';
import { SweepChart } from './charts';
import { PizzaMark } from './Logo';
import { EngineMark, ENTER, Icon, Pill, Spinner } from './ui';

const WIDTH = 400;
const OPEN_KEY = 'sb-copilot-open';

interface MeMsg { id: number; from: 'me'; text: string }
interface BotMsg {
  id: number; from: 'bot'; phase: 'thinking' | 'typing' | 'done' | 'error'; note: string; steps: CopilotStep[];
  text: string; cards: CopilotCard[]; sources: CopilotSource[]; suggestions: string[]; ms?: number; engine?: string;
}
type Msg = MeMsg | BotMsg;
type Card<K extends CopilotCard['kind']> = Extract<CopilotCard, { kind: K }>;
type Decidable = Card<'approval'> | Card<'goodwill'> | Card<'repair_plan'> | Card<'threshold'>;
type Decided = { approved: boolean; details: string[] };
interface Nudge { text: string; ask: string }

/** The 60-second story, one person at a time. Each step moves the console and offers one question to ask. */
const TOUR: { role: Role; tab: Tab; title: string; say: string; ask: string; cue?: Cue }[] = [
  { role: 'customer', tab: 'order', title: 'A customer writes in',
    say: 'Maya asks in the app and gets an answer from the service crew. Her copilot can only read the help articles: no account tools, no internal manual.',
    ask: 'What if my pizza arrives cold?' },
  { role: 'specialist', tab: 'floor', cue: { kind: 'story', id: 'K-9003', replay: true }, title: 'The crew works the case',
    say: "Priya's cold pizza, replayed on the Agent Floor. Seven bots, each with only its own tools, hand the case along while the robots they mention light up on the DC map.",
    ask: 'Why did K-9008 get sent back?' },
  { role: 'specialist', tab: 'home', title: 'Only the hard calls reach a person',
    say: 'Refunds over $20, legal, and safety go to Dana with the research done. She can resolve one from the chat; the click is hers, not the bot’s.',
    ask: 'Resolve the next case' },
  { role: 'repair_lead', tab: 'repair', title: 'One complaint becomes a fleet fix',
    say: 'The Fleet bot found the same heat loss on three more robots from batch M2-B07. The repair crew fit all four fixes before the dinner rush; Imani approves the plan.',
    ask: 'Approve the M2-B07 seal repairs' },
  { role: 'mechanic', tab: 'jobs', title: 'The mechanic gets the job, part reserved',
    say: "Lena's queue has the job, the part, and the bin. A runner robot is already carrying the gaskets from the Hub.",
    ask: "What's my next job?" },
  { role: 'head', tab: 'cockpit', title: 'The business sets the dial',
    say: 'Renee owns one lever: how sure the crew must be before it answers alone. Ask what moving it would cost.',
    ask: 'What if we raised the threshold to 0.85?' },
];

let nextId = 1;
const bot = (patch: Partial<BotMsg> = {}): BotMsg => ({
  id: nextId++, from: 'bot', phase: 'thinking', note: 'Reading your question', steps: [], text: '', cards: [], sources: [],
  suggestions: [], ...patch,
});
/** How long the typing bubble shows before a reply lands: long enough to read as typing, never a wait. */
const typingMs = (text: string) => Math.min(1300, 420 + text.length * 5);
const cardKey = (c: CopilotCard) => (c.kind === 'robot' ? c.robot_id : 'contact_id' in c ? `${c.kind}:${c.contact_id}` : c.kind);
const usd = (v: number) => `$${v.toFixed(2)}`;

function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
function writeOpen(v: boolean) {
  try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* private mode: not remembered */ }
}

export default function Copilot({ role, tab, slot, waiting = 0 }: { role: Role; tab: Tab; slot: HTMLElement | null; waiting?: number }) {
  const { engine, caseId, setCaseId, bump, status, inbox, switchTo, go, setCue, threshold, setThreshold } = useApp();
  const reduce = useReducedMotion();
  const [open, setOpenState] = useState(readOpen);
  const [threads, setThreads] = useState<Partial<Record<Role, Msg[]>>>({});
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [tour, setTour] = useState<number | null>(null);
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const { data: manifest } = useApi<CopilotManifest>(`/api/copilot/manifest?role=${role}`);
  const openRef = useRef(open);
  const stop = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const thread = threads[role] ?? [];
  const persona = PERSONAS[role];

  const setOpen = useCallback((v: boolean) => {
    openRef.current = v; setOpenState(v); writeOpen(v);
    if (v) { setUnread(0); setNudge(null); setTimeout(() => input.current?.focus(), 320); }
  }, []);

  // ⌘J / Ctrl+J toggles the panel from anywhere; Escape minimizes it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpen(!openRef.current); }
      else if (e.key === 'Escape' && openRef.current) setOpen(false);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [setOpen]);

  // A persona switch mid-answer would land the reply in the wrong thread.
  useEffect(() => () => { stop.current?.(); setBusy(false); }, [role]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' }); }, [thread, reduce]);

  const patch = useCallback((r: Role, id: number, fn: (m: BotMsg) => Partial<BotMsg>) => {
    setThreads((t) => ({ ...t, [r]: (t[r] ?? []).map((m) => (m.id === id && m.from === 'bot' ? { ...m, ...fn(m) } : m)) }));
  }, []);
  const push = useCallback((r: Role, ...msgs: Msg[]) => setThreads((t) => ({ ...t, [r]: [...(t[r] ?? []), ...msgs] })), []);

  /** Typing dots, then the bubble, then anything that waits for the reply (a screen move). */
  const land = useCallback((r: Role, id: number, reply: Partial<BotMsg>, after?: () => void) => {
    patch(r, id, () => ({ ...reply, phase: 'typing' }));
    setTimeout(() => {
      patch(r, id, () => ({ phase: 'done' }));
      setBusy(false);
      if (!openRef.current) setUnread((u) => u + 1);
      after?.();
    }, reduce ? 0 : typingMs(reply.text ?? ''));
  }, [patch, reduce]);

  /** Follow a screen-move card. Harmless, so it happens on its own when the reply lands. */
  const moveTo = useCallback((c: Card<'nav'>) => {
    if (c.cue?.kind === 'case') setCaseId(c.cue.id);
    else if (c.cue) setCue(c.cue);
    go(c.tab as Tab);
  }, [go, setCaseId, setCue]);

  const ask = (raw: string, opts: { silent?: boolean } = {}) => {
    const text = raw.trim();
    if (!text || busy) return;
    const r = role;
    const history = thread.filter((m) => m.from === 'me' || m.phase === 'done').map((m) => ({ from: m.from, text: m.text }));
    const b = bot({ note: opts.silent ? 'Heads up' : 'Reading your question' });
    if (opts.silent) push(r, b); else push(r, { id: nextId++, from: 'me', text }, b);
    setDraft(''); setBusy(true);
    let reply: Partial<BotMsg> | null = null;
    let nav: Card<'nav'> | null = null;
    stop.current = streamCopilot(
      { role: r, message: text, history, context: { tab, case_id: tab === 'cases' ? caseId : null, threshold },
        who: { name: persona.name, title: persona.title }, engine },
      (ev) => {
        if (ev.type === 'thinking') patch(r, b.id, () => ({ note: ev.text }));
        else if (ev.type === 'tool') patch(r, b.id, (m) => ({ note: 'Thinking', steps: [...m.steps, ev] }));
        else if (ev.type === 'card') {
          if (ev.card.kind === 'nav') nav = ev.card;
          patch(r, b.id, (m) => ({ cards: [...m.cards, ev.card] }));
        } else if (ev.type === 'reply') reply = { text: ev.text, sources: ev.sources, suggestions: ev.suggestions };
        else if (ev.type === 'done') patch(r, b.id, () => ({ ms: ev.ms, engine: ev.engine }));
        else if (ev.type === 'error') reply = null;
      },
      () => {
        stop.current = null;
        const move = nav;
        if (reply) land(r, b.id, reply, move ? () => moveTo(move) : undefined);
        else { patch(r, b.id, () => ({ phase: 'error', text: 'I lost the connection to the console. Try again in a moment.' })); setBusy(false); }
      },
    );
  };

  /** A message from the copilot after the person clicked a card: what ran, typed out like any other reply. */
  const followUp = (r: Role, step: { label: string; summary: string }, text: string, suggestions: string[]) => {
    const b = bot({ note: 'Running your decision', steps: [{ name: 'decision', group: 'You', ok: true, ms: 0, ...step }] });
    push(r, b); setBusy(true);
    land(r, b.id, { text, suggestions });
  };

  /** The person clicked a card. This, not the copilot, is what changes data. */
  const decide = async (msgId: number, card: Decidable, yes: boolean) => {
    const r = role;
    const mark = (decided: Decided) => patch(r, msgId, (m) => ({
      cards: m.cards.map((c) => (cardKey(c) === cardKey(card) ? { ...c, decided } as CopilotCard : c)) }));
    if (!yes && card.kind !== 'approval') {
      mark({ approved: false, details: [] });
      followUp(r, { label: 'Left as is', summary: 'Nothing changed' }, 'Left as is. Nothing changed.', []);
      return;
    }
    if (card.kind === 'approval') {
      const res = await api.post<CaseResult>(`/api/cases/${card.contact_id}/approve`,
        { approve: yes, note: `${yes ? 'Approved' : 'Declined'} from the copilot` });
      const details = (res.specialist_actions ?? []).map((a) => a.detail);
      mark({ approved: yes, details }); bump();
      const left = (await api.get<Inbox>('/api/inbox').catch(() => null))?.specialist ?? 0;
      const after = left ? `${left} more case${left === 1 ? '' : 's'} waiting.` : 'Your inbox is clear.';
      followUp(r, { label: yes ? 'Approved by you' : 'Declined by you', summary: details.join('; ') || 'No actions run' },
        yes ? `Done. ${details.join(', ') || 'Nothing to run'} for ${card.contact_id}, logged as yours in the Case Room. ${after}`
          : `Declined. No money moved on ${card.contact_id}. ${after}`,
        left ? ['Resolve the next case', "What's waiting on me?"] : ['How are we doing on containment?']);
    } else if (card.kind === 'goodwill') {
      const res = await api.post<CaseResult>(`/api/cases/${card.contact_id}/goodwill`, { amount: card.amount, message: card.message });
      const detail = res.specialist_actions?.[res.specialist_actions.length - 1]?.detail ?? `${usd(card.amount)} goodwill credit`;
      mark({ approved: true, details: [detail] }); bump();
      followUp(r, { label: 'Sent by you', summary: detail },
        `Sent. ${detail}${card.pending ? `, and ${card.contact_id} is closed` : ''}. ${card.customer.split(' ')[0]} sees your message in the app.`,
        ["What's waiting on me?"]);
    } else if (card.kind === 'repair_plan') {
      const ids = card.plans.filter((p) => p.feasible).map((p) => p.wo_id);
      const res = await api.post<{ approved: number }>('/api/repair/batch-approve', { wo_ids: ids });
      const mechs = [...new Set(card.plans.filter((p) => p.feasible).map((p) => p.mechanic))].join(', ');
      const detail = `${res.approved} repair${res.approved === 1 ? '' : 's'} booked`;
      mark({ approved: true, details: [detail] }); bump();
      followUp(r, { label: 'Approved by you', summary: detail },
        `Booked ${res.approved}. Jobs, parts, and bins are in ${mechs}'s queue${mechs.includes(',') ? 's' : ''}.`,
        ['Which robots are off the road?', 'What needs my approval?']);
    } else {
      setThreshold(card.proposed_threshold);
      mark({ approved: true, details: [`threshold ${card.proposed_threshold.toFixed(2)}`] });
      followUp(r, { label: 'Set by you', summary: `Threshold ${card.proposed_threshold.toFixed(3)}` },
        `Threshold set to ${card.proposed_threshold.toFixed(2)}. New cases use it from now on; the KPI Cockpit shows the same point.`,
        ['How are we doing on containment?']);
    }
  };

  // Nudges: when new work lands for this persona, say so. Baseline on first sight and on every persona switch.
  // The copilot also polls on its own, so work that lands from another tab (the customer writing in) still nudges here.
  const [latest, setLatest] = useState<Inbox | null>(null);
  useEffect(() => { if (inbox) setLatest(inbox); }, [inbox]);
  useEffect(() => {
    const t = setInterval(() => api.get<Inbox>('/api/inbox').then(setLatest).catch(() => undefined), 4000);
    return () => clearInterval(t);
  }, []);
  const seen = useRef<{ role: Role; cases: Set<string>; count: number } | null>(null);
  useEffect(() => {
    if (!latest) return;
    const cases = new Set(latest.specialist_cases);
    const count = inboxCount(role, latest);
    const prev = seen.current;
    seen.current = { role, cases, count };
    if (!prev || prev.role !== role) return;
    const deliver = (n: Nudge) => {
      bump();  // the rest of the console catches up too: badges, the Overview, the Case Room list
      if (openRef.current) push(role, bot({ phase: 'done', text: `Heads up: ${n.text}`, suggestions: [n.ask] }));
      else { setNudge(n); setUnread((u) => u + 1); }
    };
    if (role === 'specialist' || role === 'head') {
      const fresh = [...cases].filter((c) => !prev.cases.has(c));
      if (!fresh.length) return;
      const n = { text: `${fresh[0]} just landed in the inbox.`, ask: `Resolve ${fresh[0]}` };
      api.get<{ result: CaseResult | null }>(`/api/cases/${fresh[0]}`)
        .then((x) => { const s = x.result?.handoff?.summary; deliver(s ? { ...n, text: `${n.text} ${s}` } : n); })
        .catch(() => deliver(n));
    } else if (role === 'repair_lead' && count > prev.count) {
      deliver({ text: `${count - prev.count} new work order${count - prev.count === 1 ? '' : 's'} need your approval.`, ask: 'What needs my approval?' });
    } else if (role === 'mechanic' && count > prev.count) {
      deliver({ text: 'a new job was booked for you.', ask: "What's my next job?" });
    }
  }, [latest, role]);

  const enterStep = (i: number | null) => {
    setTour(i);
    if (i === null) return;
    const s = TOUR[i];
    switchTo(s.role, s.tab);
    if (s.cue) setCue(s.cue);
  };

  const clear = () => { stop.current?.(); setBusy(false); setThreads((t) => ({ ...t, [role]: [] })); };
  const lastBot = [...thread].reverse().find((m): m is BotMsg => m.from === 'bot');

  return (
    <>
      <AnimatePresence initial={false}>
        {open && (
          <motion.aside key="copilot" aria-label="SliceBot Copilot"
            initial={{ width: 0 }} animate={{ width: WIDTH }} exit={{ width: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.3, ease: ENTER }}
            className="shrink-0 h-full overflow-hidden bg-surface-panel border-l border-line-shell
                       max-md:fixed max-md:inset-0 max-md:z-50 max-md:!w-full">
            <div className="h-full flex flex-col max-md:!w-full" style={{ width: WIDTH }}>
              <Header busy={busy} engine={lastBot?.engine ?? (engine === 'live' ? 'live' : 'offline')} manifest={manifest}
                onClear={thread.length ? clear : undefined} onMinimize={() => setOpen(false)}
                onTour={tour === null ? () => enterStep(0) : undefined} />

              <div className="flex-1 overflow-y-auto px-s4 pb-s4 flex flex-col gap-s3 min-h-0">
                {tour !== null && <TourBanner i={tour} busy={busy} onAsk={(q) => ask(q)} onGo={enterStep} />}
                {thread.length === 0 ? (
                  <Intro name={persona.name.split(' ')[0]} starters={manifest?.starters ?? []} onPick={(q) => ask(q)}
                    onTour={tour === null ? () => enterStep(0) : undefined} />
                ) : (
                  <>
                    <span className="self-center text-2xs font-mono text-ink-secondary pt-s4">Today {hhmm(status?.clock)}</span>
                    {thread.map((m, i) => m.from === 'me'
                      ? <MeBubble key={m.id} text={m.text} delivered={i === thread.length - 2 && thread[i + 1]?.from === 'bot'
                          && (thread[i + 1] as BotMsg).phase === 'thinking'} />
                      : <BotTurn key={m.id} m={m} last={m.id === lastBot?.id} busy={busy} onAsk={(q) => ask(q)} role={role}
                          onDecide={(c, ok) => decide(m.id, c, ok)} onMove={moveTo} onTour={() => enterStep(0)} />)}
                  </>
                )}
                <div ref={end} />
              </div>

              <Composer value={draft} onChange={setDraft} onSend={() => ask(draft)} busy={busy} inputRef={input}
                where={`${TAB_LABEL[tab]}${tab === 'cases' && caseId ? ` · ${caseId}` : ''}`} />
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {slot && createPortal(
        <>
          {/* The launcher lives in the header, so it never sits on top of a screen's content. Each case waiting on
              this person pulls a slice out of the pizza. */}
          <button onClick={() => setOpen(!open)} aria-label={open ? 'Close SliceBot Copilot' : 'Open SliceBot Copilot'} aria-expanded={open}
            className={`group relative flex items-center gap-s2 h-10 pl-1.5 pr-1.5 xl:pr-s3 rounded-pill border transition-colors duration-fast ease-out
                        ${open ? 'bg-accent-fill border-accent-line text-ink-primary' : 'bg-surface-raised border-line hover:border-line-hover hover:bg-surface-hover text-ink-emphasis'}`}>
            <span className={`transition-transform duration-slow ease-out group-hover:rotate-[24deg] ${nudge ? 'nudge-wiggle' : ''}`}>
              <PizzaMark size={28} out={waiting} />
            </span>
            {!open && <span className="text-smd font-medium max-xl:hidden">Ask SliceBot</span>}
            {!open && <kbd className="text-2xs font-sans text-ink-secondary px-1.5 py-0.5 rounded-ctl border border-line max-xl:hidden">⌘J</kbd>}
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 grid place-items-center min-w-[18px] h-[18px] px-1 rounded-pill
                               bg-accent text-[var(--accent-ink)] text-2xs font-bold tabular-nums">{unread}</span>
            )}
          </button>
          <AnimatePresence>
            {!open && nudge && (
              <motion.div key="nudge" role="status"
                initial={reduce ? false : { opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: ENTER }}
                style={{ transformOrigin: 'top right' }}
                className="popover absolute right-0 top-12 z-50 w-[300px] rounded-card rounded-tr-ctl bg-surface-solid border border-line-strong shadow-overlay p-s3 flex flex-col gap-s2">
                <span className="flex items-start gap-s2">
                  <span className="shrink-0 pt-0.5"><PizzaMark size={18} /></span>
                  <span className="text-smd text-ink-primary leading-snug flex-1">{sentence(nudge.text)}</span>
                  <button onClick={() => setNudge(null)} aria-label="Dismiss"
                    className="shrink-0 text-ink-secondary hover:text-ink-primary transition-colors duration-fast ease-out"><Icon name="x" size={14} /></button>
                </span>
                <button onClick={() => { const n = nudge; setOpen(true); ask(n.ask, { silent: true }); }}
                  className="self-start text-sm text-ai bg-ai-fill border border-ai-line rounded-pill px-s3 py-1
                             hover:bg-surface-hover transition-colors duration-fast ease-out">{nudge.ask}</button>
              </motion.div>
            )}
          </AnimatePresence>
        </>, slot)}
    </>
  );
}

// ---------------------------------------------------------------- chrome

const EFFECT_PILL = {
  read: <Pill kind="muted">read only</Pill>,
  proposes: <Pill kind="warn">needs your click</Pill>,
  navigates: <Pill kind="info">moves your screen</Pill>,
};

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} aria-label={label}
      className="grid place-items-center w-8 h-8 rounded-ctl text-ink-secondary hover:text-ink-primary hover:bg-surface-hover
                 transition-colors duration-fast ease-out"><Icon name={icon} /></button>
  );
}

function Header({ busy, engine, manifest, onClear, onMinimize, onTour }: {
  busy: boolean; engine: string; manifest: CopilotManifest | null; onClear?: () => void; onMinimize: () => void; onTour?: () => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const tools = manifest?.tools ?? [];
  const groups = [...new Set(tools.map((t) => t.group_label))];
  return (
    <header className="shrink-0 border-b border-line-shell">
      <div className="flex items-center gap-s2 px-s4 h-header">
        <span className={`grid place-items-center w-8 h-8 ${busy ? 'spin-slow' : ''}`}><PizzaMark size={28} /></span>
        <div className="flex flex-col min-w-0 flex-1 leading-tight pl-1">
          <span className="flex items-center gap-s2 text-smd font-semibold text-ink-primary">
            SliceBot Copilot <EngineMark kind={engine === 'live' ? 'ai' : 'rules'} />
          </span>
          <button onClick={() => setShowTools(!showTools)} aria-expanded={showTools}
            className="flex items-center gap-1.5 text-xs text-ink-secondary hover:text-ink-primary transition-colors duration-fast ease-out w-fit">
            <span className="w-1.5 h-1.5 rounded-pill bg-ok" />
            Connected to {tools.length} tool{tools.length === 1 ? '' : 's'}
            <Icon name="chevron" size={10} className={`transition-transform duration-fast ease-out ${showTools ? 'rotate-180' : ''}`} />
          </button>
        </div>
        {onTour && <IconButton icon="map" label="Take the 60-second tour" onClick={onTour} />}
        {onClear && <IconButton icon="reset" label="Clear this chat" onClick={onClear} />}
        <IconButton icon="minus" label="Minimize (Esc)" onClick={onMinimize} />
      </div>
      <AnimatePresence initial={false}>
        {showTools && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: ENTER }} className="overflow-hidden">
            <div className="px-s4 pb-s3 flex flex-col gap-s3 max-h-[52vh] overflow-y-auto">
              {groups.map((g) => (
                <div key={g} className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-2xs font-mono uppercase tracking-wider text-ink-secondary">
                    <Icon name="plug" size={12} /> {g}
                  </span>
                  {tools.filter((t) => t.group_label === g).map((t) => (
                    <div key={t.name} className="flex flex-col gap-0.5 rounded-chip bg-surface-inset border border-line px-s3 py-s2">
                      <span className="flex items-center justify-between gap-s2">
                        <code className="text-sm font-mono text-ink-primary">{t.name}</code>{EFFECT_PILL[t.effect]}
                      </span>
                      <span className="text-xs text-ink-secondary leading-snug">{t.description}</span>
                    </div>
                  ))}
                </div>
              ))}
              <p className="text-xs text-ink-secondary leading-snug">
                Same tools and limits as the crew. The copilot can look things up and move your screen; anything that changes data waits for your click.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

const STARTER_ICONS = ['target', 'bolt', 'doc', 'layers'];

function Intro({ name, starters, onPick, onTour }: { name: string; starters: string[]; onPick: (q: string) => void; onTour?: () => void }) {
  return (
    <div className="flex flex-col gap-s4 pt-s6">
      <div className="flex flex-col items-center text-center gap-s2">
        <PizzaMark size={52} />
        <h2 className="text-md font-semibold text-ink-primary">Hi {name}, what can I dig up?</h2>
        <p className="text-sm text-ink-secondary max-w-[34ch]">
          Ask about a case, a robot, a policy, or how the console works. You'll see every tool I use.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-s2">
        {starters.map((q, i) => (
          <button key={q} onClick={() => onPick(q)} style={{ '--i': i * 4 } as React.CSSProperties}
            className="u-rise flex flex-col items-start gap-s2 text-left rounded-card bg-surface-raised border border-line p-s3
                       hover:bg-surface-hover hover:border-line-hover transition-colors duration-fast ease-out">
            <span className="grid place-items-center w-6 h-6 rounded-ctl bg-ai-fill text-ai">
              <Icon name={STARTER_ICONS[i % STARTER_ICONS.length]} size={14} />
            </span>
            <span className="text-smd text-ink-primary leading-snug">{q}</span>
          </button>
        ))}
        {onTour && (
          <button onClick={onTour} style={{ '--i': 16 } as React.CSSProperties}
            className="u-rise col-span-2 flex items-center gap-s3 text-left rounded-card bg-surface-inset border border-dashed border-line-strong p-s3
                       hover:bg-surface-hover hover:border-line-hover transition-colors duration-fast ease-out">
            <span className="grid place-items-center w-8 h-8 rounded-ctl bg-accent-fill text-accent-bright shrink-0"><Icon name="map" /></span>
            <span className="flex flex-col">
              <span className="text-smd text-ink-primary font-medium">Take the 60-second tour</span>
              <span className="text-xs text-ink-secondary">Six steps, five people. I switch screens for you.</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function TourBanner({ i, busy, onAsk, onGo }: { i: number; busy: boolean; onAsk: (q: string) => void; onGo: (i: number | null) => void }) {
  const s = TOUR[i];
  const p = PERSONAS[s.role];
  const last = i === TOUR.length - 1;
  return (
    <div className="sticky top-0 z-10 -mx-s4 px-s4 pt-s3 pb-s3 bg-surface-panel border-b border-line-shell">
      <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: ENTER }}
        className="rounded-card bg-surface-raised border border-accent-line p-s3 flex flex-col gap-s2">
        <div className="flex items-center justify-between gap-s2">
          <span className="flex items-center gap-1">
            {TOUR.map((_, k) => (
              <span key={k} className={`h-1 rounded-pill transition-[width,background-color] duration-med ease-out
                                        ${k === i ? 'w-4 bg-accent' : k < i ? 'w-1.5 bg-accent-line' : 'w-1.5 bg-line-strong'}`} />
            ))}
            <span className="ml-s2 text-2xs font-mono text-ink-secondary tabular-nums">Tour · {i + 1} of {TOUR.length}</span>
          </span>
          <button onClick={() => onGo(null)} aria-label="End the tour"
            className="text-ink-secondary hover:text-ink-primary transition-colors duration-fast ease-out"><Icon name="x" size={14} /></button>
        </div>
        <span className="text-smd font-semibold text-ink-primary">{s.title}</span>
        <span className="text-sm text-ink-emphasis leading-snug">{s.say}</span>
        <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <span className="grid place-items-center w-4 h-4 rounded-ctl bg-accent-fill text-accent-bright text-2xs font-mono font-black">{p.glyph[0]}</span>
          You're {p.name}, {p.title.charAt(0).toLowerCase() + p.title.slice(1)}
        </span>
        <div className="flex items-center gap-s2 pt-1 min-w-0">
          <button onClick={() => onAsk(s.ask)} disabled={busy}
            className="min-w-0 text-sm text-ai bg-ai-fill border border-ai-line rounded-pill px-s3 py-1 disabled:opacity-40
                       hover:bg-surface-hover transition-colors duration-fast ease-out truncate">Try: {s.ask}</button>
          <span className="ml-auto flex items-center gap-1 shrink-0">
            {i > 0 && <button onClick={() => onGo(i - 1)} className="h-7 px-s2 rounded-ctl text-sm text-ink-secondary hover:text-ink-primary transition-colors duration-fast ease-out">Back</button>}
            <button onClick={() => onGo(last ? null : i + 1)}
              className="inline-flex items-center gap-1 h-7 px-s3 rounded-ctl bg-accent text-[var(--accent-ink)] text-sm font-semibold">
              {last ? 'Finish' : 'Next'} {!last && <Icon name="arrow" size={12} />}
            </button>
          </span>
        </div>
      </motion.div>
    </div>
  );
}

function Composer({ value, onChange, onSend, busy, inputRef, where }: {
  value: string; onChange: (v: string) => void; onSend: () => void; busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>; where: string;
}) {
  return (
    <form className="shrink-0 border-t border-line-shell px-s4 pt-s3 pb-s4 flex flex-col gap-s2"
      onSubmit={(e) => { e.preventDefault(); onSend(); }}>
      <span className="text-2xs font-mono text-ink-secondary">Looking at {where}</span>
      <div className="flex items-center gap-s2 rounded-pill bg-surface-inset border border-line pl-s4 pr-1 h-10
                      focus-within:border-accent-line has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2
                      has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent-bright
                      transition-colors duration-fast ease-out">
        {/* The ring is on the pill around the input (has-[input:focus-visible] above), so the input drops its own. */}
        <input className="flex-1 min-w-0 bg-transparent text-smd text-ink-primary placeholder:text-ink-secondary focus:outline-none"
          ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Ask SliceBot…"
          aria-label="Message the copilot" />
        <button type="submit" disabled={!value.trim() || busy} aria-label="Send"
          className="grid place-items-center w-8 h-8 rounded-pill bg-accent text-[var(--accent-ink)] disabled:opacity-30
                     transition-opacity duration-fast ease-out"><Icon name="send" size={14} /></button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- messages

function MeBubble({ text, delivered }: { text: string; delivered: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.2, ease: ENTER }}
      className="self-end flex flex-col items-end gap-1 max-w-[85%] origin-bottom-right">
      <div className="rounded-card rounded-br-ctl bg-accent text-[var(--accent-ink)] px-s3 py-s2 text-smd leading-snug">{text}</div>
      {delivered && <span className="text-2xs text-ink-secondary">Delivered</span>}
    </motion.div>
  );
}

function BotTurn({ m, last, busy, onAsk, onDecide, onMove, onTour, role }: {
  m: BotMsg; last: boolean; busy: boolean; onAsk: (q: string) => void; role: Role;
  onDecide: (c: Decidable, yes: boolean) => Promise<void>; onMove: (c: Card<'nav'>) => void; onTour: () => void;
}) {
  return (
    <div className="self-start flex flex-col gap-s2 w-full">
      <Trace m={m} />
      <AnimatePresence mode="wait" initial={false}>
        {m.phase === 'typing' && (
          <motion.div key="typing" exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.15 }}
            className="self-start flex items-center gap-1 rounded-card rounded-bl-ctl bg-surface-raised border border-line px-s3 h-9">
            <span className="typing-dot w-1.5 h-1.5 rounded-pill bg-ink-secondary" />
            <span className="typing-dot w-1.5 h-1.5 rounded-pill bg-ink-secondary" />
            <span className="typing-dot w-1.5 h-1.5 rounded-pill bg-ink-secondary" />
          </motion.div>
        )}
        {(m.phase === 'done' || m.phase === 'error') && (
          <motion.div key="reply" initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.2, ease: ENTER }} className="flex flex-col gap-s2 origin-bottom-left">
            <div className={`self-start max-w-[92%] rounded-card rounded-bl-ctl border px-s3 py-s2 text-smd leading-relaxed
                             ${m.phase === 'error' ? 'bg-crit-fill border-crit text-crit-text' : 'bg-surface-raised border-line text-ink-primary'}`}>
              {m.text}
            </div>
            {m.sources.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {m.sources.map((s) => (
                  <span key={s.source_id} title={s.source_id}
                    className="inline-flex items-center gap-1 text-2xs font-mono text-ink-secondary bg-surface-inset border border-line rounded-ctl px-1.5 py-0.5">
                    <Icon name={s.kind === 'db' ? 'db' : 'doc'} size={10} /> {s.title}
                  </span>
                ))}
              </div>
            )}
            {m.cards.map((c) => (
              <div key={cardKey(c)} className="u-rise">
                {c.kind === 'approval' ? <ApprovalCard c={c} onDecide={onDecide} />
                  : c.kind === 'goodwill' ? <GoodwillCard c={c} onDecide={onDecide} />
                  : c.kind === 'repair_plan' ? <RepairPlanCard c={c} onDecide={onDecide} role={role} />
                  : c.kind === 'threshold' ? <ThresholdCard c={c} onDecide={onDecide} />
                  : c.kind === 'nav' ? <NavCard c={c} onMove={onMove} />
                  : c.kind === 'tour' ? <TourCard onStart={onTour} />
                  : c.kind === 'case' ? <CaseCard c={c} /> : <RobotCard c={c} role={role} />}
              </div>
            ))}
            {last && !busy && m.suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {m.suggestions.map((s, i) => (
                  <button key={s} onClick={() => onAsk(s)} style={{ '--i': i * 5 } as React.CSSProperties}
                    className="u-rise text-sm text-ai bg-ai-fill border border-ai-line rounded-pill px-s3 py-1
                               hover:bg-surface-hover transition-colors duration-fast ease-out">{s}</button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** What the copilot did to answer: live while it works, folded to one line once it replies. */
function Trace({ m }: { m: BotMsg }) {
  const [open, setOpen] = useState(false);
  const working = m.phase === 'thinking';
  if (!working && m.steps.length === 0) return null;
  const groups = [...new Set(m.steps.map((s) => s.group))].join(', ');
  const rows = (
    <div className="flex flex-col gap-1 border-l border-line ml-1.5 pl-s3">
      {m.steps.map((s, i) => (
        <motion.div key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease: ENTER }}
          className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs">
            <Icon name={s.ok ? 'check' : 'x'} size={11} className={s.ok ? 'text-ok' : 'text-warn'} />
            <span className="text-ink-emphasis">{s.label}</span>
            <span className="font-mono text-2xs text-ink-secondary">{s.group}</span>
          </span>
          <span className="text-xs text-ink-secondary leading-snug pl-[17px]">{s.summary}</span>
        </motion.div>
      ))}
      {working && <span className="py-0.5"><Spinner label={`${m.note}…`} /></span>}
    </div>
  );
  if (working) return rows;
  return (
    <div className="flex flex-col gap-s2">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="self-start flex items-center gap-1.5 text-xs text-ink-secondary hover:text-ink-primary transition-colors duration-fast ease-out">
        <Icon name="plug" size={12} />
        Used {m.steps.length} tool{m.steps.length === 1 ? '' : 's'} · {groups}{m.ms ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}
        <Icon name="chevron" size={10} className={`transition-transform duration-fast ease-out ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: ENTER }} className="overflow-hidden">{rows}</motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- cards

/** Shared shell for every card that waits on a click: status pill, body, and the two buttons, or what ran. */
function DecisionCard({ c, onDecide, yes, no = 'Not now', yesFirst = true, blocked, pending, done, link, children }: {
  c: Decidable; onDecide: (c: Decidable, yes: boolean) => Promise<void>; yes: string; no?: string; yesFirst?: boolean;
  blocked?: boolean; pending: string; done: (d: Decided) => string; link?: React.ReactNode; children: React.ReactNode;
}) {
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = c.decided;
  const go = async (ok: boolean) => {
    setBusy(ok ? 'yes' : 'no'); setError(null);
    try { await onDecide(c, ok); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const btn = (ok: boolean, primary: boolean) => (
    <button key={String(ok)} onClick={() => go(ok)} disabled={!!busy || (ok && blocked)}
      className={`inline-flex items-center gap-1.5 h-8 px-s3 rounded-ctl border text-smd disabled:opacity-40
                  transition-colors duration-fast ease-out ${primary ? 'bg-accent text-[var(--accent-ink)] border-accent font-semibold'
                    : 'bg-surface-raised text-ink-emphasis border-line hover:bg-surface-hover'}`}>
      {busy === (ok ? 'yes' : 'no') ? <Spinner /> : <Icon name={ok ? 'check' : 'x'} size={14} />} {ok ? yes : no}
    </button>
  );
  return (
    <div className={`rounded-card border p-s3 flex flex-col gap-s2
                     ${d ? 'bg-surface-inset border-line' : blocked ? 'bg-surface-raised border-crit' : 'bg-surface-raised border-warn'}`}>
      <div className="flex items-center justify-between gap-s2">
        {d ? <Pill kind={d.approved ? 'ok' : 'muted'}>{done(d)}</Pill>
          : blocked ? <Pill kind="crit">Blocked by a guardrail</Pill> : <Pill kind="warn">{pending}</Pill>}
      </div>
      {children}
      {error && <span className="text-xs text-crit-text">{error}</span>}
      <div className="flex items-center gap-s2 pt-1">
        {!d && (yesFirst ? [btn(true, true), btn(false, false)] : [btn(false, true), btn(true, false)])}
        {link && <span className="ml-auto">{link}</span>}
      </div>
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 text-sm text-accent-bright hover:text-ink-primary transition-colors duration-fast ease-out">
      {children} <Icon name="arrow" size={12} />
    </button>
  );
}

function ApprovalCard({ c, onDecide }: { c: Card<'approval'>; onDecide: (c: Decidable, yes: boolean) => Promise<void> }) {
  const { openCase } = useApp();
  const d = c.decided;
  return (
    <DecisionCard c={c} onDecide={onDecide} yes="Approve" no="Decline" yesFirst={c.approve} pending="Needs your decision"
      done={(x) => (x.approved ? 'Approved by you' : 'Declined by you')}
      link={<LinkButton onClick={() => openCase(c.contact_id)}>Case Room</LinkButton>}>
      <div className="flex items-baseline justify-between gap-s2">
        <span className="text-smd font-semibold text-ink-primary">{c.customer}</span>
        <span className="font-mono text-xs text-ink-secondary tabular-nums">{c.contact_id}{c.confidence != null ? ` · ${c.confidence.toFixed(2)}` : ''}</span>
      </div>
      <span className="text-sm text-ink-secondary leading-snug">“{c.message}”</span>
      {c.recommendation && !d && (
        <div className="text-sm text-ink-emphasis leading-snug border-l-2 border-ai-line pl-s2">
          <span className="text-ai font-medium">Crew recommends: </span>{c.recommendation}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-sm">
        <Icon name="bolt" size={12} className="text-ink-secondary" />
        <span className="text-ink-secondary">{d ? 'Ran:' : 'On approve:'}</span>
        <span className="font-mono text-ink-primary">{d ? (d.details.join(', ') || 'nothing') : c.on_approve}</span>
      </div>
    </DecisionCard>
  );
}

function GoodwillCard({ c, onDecide }: { c: Card<'goodwill'>; onDecide: (c: Decidable, yes: boolean) => Promise<void> }) {
  const first = c.customer.split(' ')[0];
  return (
    <DecisionCard c={c} onDecide={onDecide} yes={`Send ${usd(c.amount)}`} blocked={c.blocked} pending="Needs your approval"
      done={(x) => (x.approved ? 'Sent by you' : 'Not sent')}>
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-lg font-bold text-ink-primary tabular-nums">{usd(c.amount)} goodwill</span>
        <span className="text-sm text-ink-secondary">
          to {c.customer} on <span className="font-mono">{c.order_id ?? 'no order'}</span> · <span className="font-mono">{c.contact_id}</span>
        </span>
      </div>
      {c.pending && c.replaces && !c.decided && (
        <span className="text-xs text-ink-secondary">Replaces the crew's {c.replaces} and closes {c.contact_id}.</span>
      )}
      <ul className="flex flex-col gap-1 rounded-chip bg-surface-inset border border-line px-s3 py-s2">
        {c.checks.map((k) => {
          const tone = !k.ok ? 'text-crit-text' : k.warn ? 'text-warn-text' : 'text-ok';
          return (
            <li key={k.label} className="flex items-start gap-1.5 text-xs leading-snug">
              <Icon name={!k.ok ? 'x' : k.warn ? 'bolt' : 'check'} size={11} className={`${tone} mt-px shrink-0`} />
              <span><span className="text-ink-emphasis">{k.label}</span> <span className="text-ink-secondary">· {k.detail}</span></span>
            </li>
          );
        })}
      </ul>
      {!c.blocked && (
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-mono uppercase tracking-wider text-ink-secondary">What {first} gets</span>
          <div className="self-start rounded-card rounded-bl-ctl bg-surface-inset border border-line px-s3 py-s2 text-sm text-ink-primary leading-snug">
            {c.message}
          </div>
        </div>
      )}
    </DecisionCard>
  );
}

function RepairPlanCard({ c, onDecide, role }: { c: Card<'repair_plan'>; onDecide: (c: Decidable, yes: boolean) => Promise<void>; role: Role }) {
  const { go } = useApp();
  const runner = c.runner_trips[0];
  return (
    <DecisionCard c={c} onDecide={onDecide} yes={`Approve ${c.feasible}`} blocked={c.feasible === 0} pending="Needs your approval"
      done={(x) => (x.approved ? `Booked by you · ${x.details[0]}` : 'Not booked')}
      link={PERSONAS[role].tabs.includes('repair') ? <LinkButton onClick={() => go('repair')}>Repair Queue</LinkButton> : undefined}>
      <span className="text-smd text-ink-primary">
        <span className="font-semibold">{c.feasible} of {c.count}</span> fit ·{' '}
        <span className="font-semibold">{c.before_dinner_rush}</span> back before the {c.dinner_rush} dinner rush
      </span>
      <div className="flex flex-col rounded-chip bg-surface-inset border border-line divide-y divide-line">
        {c.plans.map((p) => (
          <div key={p.wo_id} className="grid grid-cols-[56px_1fr_auto] items-baseline gap-s2 px-s3 py-1.5 text-xs">
            <span className="font-mono text-ink-primary">{p.robot_id}</span>
            <span className="min-w-0">
              <span className="text-ink-emphasis">{p.part_name}</span>
              <span className="block text-ink-secondary truncate">{p.feasible ? `${p.mechanic} · ${p.depot}${p.bin ? ` · bin ${p.bin}` : ''}` : p.blocked_reason}</span>
            </span>
            <span className={`font-mono tabular-nums ${p.feasible ? 'text-ink-primary' : 'text-crit-text'}`}>
              {p.feasible ? `${hhmm(p.start)}–${hhmm(p.end)}` : 'blocked'}
            </span>
          </div>
        ))}
      </div>
      {runner && (
        <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <Icon name="send" size={11} />
          <span><span className="font-mono text-ink-primary">{runner.runner_id}</span> carries parts {runner.from} {hhmm(runner.pickup)} → {runner.to} {hhmm(runner.arrive)}</span>
        </span>
      )}
    </DecisionCard>
  );
}

function ThresholdCard({ c, onDecide }: { c: Card<'threshold'>; onDecide: (c: Decidable, yes: boolean) => Promise<void> }) {
  const rows: { k: string; now: number; then: number; fmt: (v: number) => string; better: 'up' | 'down' }[] = [
    { k: 'Answered alone', now: c.current.containment, then: c.proposed.containment, fmt: (v) => `${Math.round(v * 100)}%`, better: 'up' },
    { k: 'Right when alone', now: c.current.auto_accuracy, then: c.proposed.auto_accuracy, fmt: (v) => `${Math.round(v * 100)}%`, better: 'up' },
    { k: 'Wrong, sent alone', now: c.current.wrong_auto, then: c.proposed.wrong_auto, fmt: (v) => String(v), better: 'down' },
  ];
  return (
    <DecisionCard c={c} onDecide={onDecide} yes={`Set to ${c.proposed_threshold.toFixed(2)}`} no={`Keep ${c.current_threshold.toFixed(2)}`}
      pending="What if" done={(x) => (x.approved ? `Set to ${c.proposed_threshold.toFixed(2)}` : 'Kept as is')}>
      <span className="text-xs text-ink-secondary">On the {c.cases}-case test set ({c.engine === 'live' ? 'Claude' : 'rules'} engine)</span>
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-s3 gap-y-1 items-baseline text-xs rounded-chip bg-surface-inset border border-line px-s3 py-s2">
        <span />
        <span className="font-mono text-ink-secondary text-right">now {c.current_threshold.toFixed(2)}</span>
        <span className="font-mono text-ink-secondary text-right">at {c.proposed_threshold.toFixed(2)}</span>
        <span />
        {rows.map((r) => {
          const delta = r.then - r.now;
          const good = r.better === 'up' ? delta > 0 : delta < 0;
          const shown = r.better === 'down' ? `${delta > 0 ? '+' : ''}${delta}` : `${delta > 0 ? '+' : ''}${Math.round(delta * 100)} pts`;
          return [
            <span key={`${r.k}k`} className="text-ink-emphasis">{r.k}</span>,
            <span key={`${r.k}n`} className="font-mono tabular-nums text-ink-secondary text-right">{r.fmt(r.now)}</span>,
            <span key={`${r.k}t`} className="font-mono tabular-nums text-ink-primary text-right font-semibold">{r.fmt(r.then)}</span>,
            <span key={`${r.k}d`} className={`font-mono tabular-nums text-right ${delta === 0 ? 'text-ink-secondary' : good ? 'text-ok-text' : 'text-crit-text'}`}>
              {delta === 0 ? '·' : shown}
            </span>,
          ];
        })}
      </div>
      <SweepChart data={c.sweep} threshold={c.proposed_threshold} height={150} />
    </DecisionCard>
  );
}

function NavCard({ c, onMove }: { c: Card<'nav'>; onMove: (c: Card<'nav'>) => void }) {
  const what = c.cue?.kind === 'story' ? 'Replaying on' : 'Moved you to';
  return (
    <div className="flex items-center gap-s2 rounded-card bg-surface-inset border border-line px-s3 py-s2">
      <Icon name="map" size={14} className="text-info shrink-0" />
      <span className="text-sm text-ink-emphasis flex-1 min-w-0 truncate">{what} <span className="font-mono text-ink-primary">{c.label}</span></span>
      <button onClick={() => onMove(c)} className="text-sm text-accent-bright hover:text-ink-primary transition-colors duration-fast ease-out shrink-0">Go again</button>
    </div>
  );
}

function TourCard({ onStart }: { onStart: () => void }) {
  return (
    <button onClick={onStart}
      className="w-full flex items-center gap-s3 text-left rounded-card bg-surface-raised border border-accent-line p-s3
                 hover:bg-surface-hover transition-colors duration-fast ease-out">
      <span className="grid place-items-center w-8 h-8 rounded-ctl bg-accent-fill text-accent-bright shrink-0"><Icon name="map" /></span>
      <span className="flex flex-col flex-1">
        <span className="text-smd text-ink-primary font-medium">Start the tour</span>
        <span className="text-xs text-ink-secondary">Customer, crew, specialist, repair lead, mechanic, head of care</span>
      </span>
      <Icon name="arrow" size={14} className="text-accent-bright" />
    </button>
  );
}

function CaseCard({ c }: { c: Card<'case'> }) {
  const { openCase } = useApp();
  const pill = c.resolved_by ? <Pill kind="muted">Resolved</Pill>
    : c.decision === 'human' ? <Pill kind="warn">Needs a person</Pill> : <Pill kind="ok">Crew answered</Pill>;
  return (
    <button onClick={() => openCase(c.contact_id)}
      className="w-full text-left rounded-card bg-surface-raised border border-line p-s3 flex flex-col gap-1.5
                 hover:border-line-hover hover:bg-surface-hover transition-colors duration-fast ease-out">
      <span className="flex items-center justify-between gap-s2">
        <span className="font-mono text-sm text-ink-primary">{c.contact_id} · {c.customer}</span>{pill}
      </span>
      <span className="text-sm text-ink-secondary leading-snug line-clamp-2">“{c.message}”</span>
      <span className="flex items-center justify-between text-xs text-ink-secondary">
        <span className="font-mono tabular-nums">{c.intent ? sentence(c.intent) : ''}{c.confidence != null ? ` · confidence ${c.confidence.toFixed(2)}` : ''}</span>
        <span className="inline-flex items-center gap-1 text-accent-bright">Open <Icon name="arrow" size={11} /></span>
      </span>
    </button>
  );
}

function RobotCard({ c, role }: { c: Card<'robot'>; role: Role }) {
  const { go, setCue } = useApp();
  const tone = c.status === 'active' ? 'ok' : c.status === 'in_repair' ? 'info' : 'crit';
  const canMap = PERSONAS[role].tabs.includes('city');
  return (
    <div className="rounded-card bg-surface-raised border border-line p-s3 flex flex-col gap-s2">
      <span className="flex items-center justify-between gap-s2">
        <span className="font-mono text-smd font-semibold text-ink-primary">{c.robot_id}</span>
        <Pill kind={tone}>{sentence(c.status)}</Pill>
      </span>
      <div className="grid grid-cols-3 gap-s2 text-xs">
        <Stat k="Battery" v={`${c.battery_pct}%`} />
        <Stat k="Fault" v={c.fault_code ?? 'none'} />
        <Stat k="Batch" v={c.batch} />
      </div>
      <div className="h-1 rounded-pill bg-surface-inset overflow-hidden">
        <div className={`h-full rounded-pill ${c.battery_pct < 30 ? 'bg-crit' : c.battery_pct < 60 ? 'bg-warn' : 'bg-ok'}`}
          style={{ width: `${c.battery_pct}%` }} />
      </div>
      {canMap && (
        <button onClick={() => { setCue({ kind: 'robot', id: c.robot_id }); go('city'); }}
          className="self-start inline-flex items-center gap-1 text-sm text-accent-bright hover:text-ink-primary transition-colors duration-fast ease-out">
          <Icon name="map" size={12} /> See it on Live City
        </button>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex flex-col gap-0.5 min-w-0">
      <span className="text-ink-secondary">{k}</span>
      <span className="font-mono text-ink-primary truncate">{v}</span>
    </span>
  );
}
