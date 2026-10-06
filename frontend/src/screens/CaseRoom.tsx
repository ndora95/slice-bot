import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FileSearch, FileText, Gauge, Route, Workflow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App';
import { Chain } from '../components/Chain';
import { Sparkline } from '../components/charts';
import { Journey } from '../components/Journey';
import { foldService, followNode, ServiceDetail, serviceChain, StepNav, usePlayer, type ServiceView } from '../components/ServiceRun';
import { Accordion, Button, CodeBlock, ENTER, Icon, Kicker, Panel, Pill, Segmented, Spinner } from '../components/ui';
import { api, streamCase } from '../lib/api';
import { hhmm, human, KIND_LABEL, sentence, usd } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { CaseEvent, CaseResult, Contact, Evidence, Queue } from '../lib/types';

export default function CaseRoom() {
  const { tick, bump, caseId, setCaseId, engine, threshold, status } = useApp();
  const { data: contacts, reload } = useApi<Contact[]>('/api/contacts', tick);
  // Runs play through the same paced player as the Agent Floor, so a live run reads hand by hand instead of all at once.
  const player = usePlayer();
  const [running, setRunning] = useState(false);
  const stopRef = useRef<() => void>();
  const selected = contacts?.find((c) => c.contact_id === caseId) ?? null;

  // Open on the case that needs a person, if there is one: everything else the crew has already handled.
  useEffect(() => {
    if (caseId || !contacts?.length) return;
    setCaseId((contacts.find(needsYou) ?? contacts[0]).contact_id);
  }, [contacts, caseId, setCaseId]);

  useEffect(() => {
    stopRef.current?.();
    setRunning(false);
    player.clear();
    if (!caseId) return;
    api.get<{ events: CaseEvent[] }>(`/api/cases/${caseId}`).then((r) => player.load(r.events)).catch(() => player.clear());
  }, [caseId]);

  const run = (id = caseId) => {
    if (!id) return;
    stopRef.current?.();
    player.clear();
    setRunning(true);
    stopRef.current = streamCase(id, { threshold, engine }, (e) => player.push(e),
      () => player.whenDrained(() => { setRunning(false); reload(); bump(); }));
  };

  // When the queue worker finishes the open case, show its saved run.
  useEffect(() => {
    if (!caseId || running || !selected?.decision) return;
    api.get<{ events: CaseEvent[] }>(`/api/cases/${caseId}`).then((r) => player.load(r.events)).catch(() => { /* keep what we have */ });
  }, [selected?.decision, selected?.resolved_by]);

  const events = player.shown;
  const view = useMemo(() => foldService(events), [events]);
  const [composing, setComposing] = useState(false);
  const mineCount = contacts?.filter(needsYou).length ?? 0;
  const [filter, setFilter] = useState<'mine' | 'all' | null>(null);
  const show = filter ?? (mineCount ? 'mine' : 'all');
  const groups = [
    { label: 'Needs a specialist', dot: 'warn' as const, items: contacts?.filter(needsYou) ?? [] },
    { label: 'Crew working', dot: 'ai' as const, items: contacts?.filter((c) => !c.decision) ?? [] },
    { label: 'Handled by the crew', dot: 'ok' as const, items: contacts?.filter((c) => c.decision && !needsYou(c)) ?? [] },
  ].filter((g) => g.items.length > 0 && (show === 'all' || g.label === 'Needs a specialist'));

  return (
    <div className="grid grid-cols-[340px_1fr] max-lg:grid-cols-1 gap-s4 min-h-full">
      <div className="flex flex-col gap-s4 min-w-0">
        {composing && <Composer onClose={() => setComposing(false)}
          onCreated={(id) => { reload(); setCaseId(id); setFilter('all'); setComposing(false); setTimeout(() => run(id), 50); }} />}
        <Panel kicker="Contacts" bodyClass="flex flex-col gap-s3"
          action={!composing && <Button variant="ghost" onClick={() => setComposing(true)} title="Type a message as a customer and run the crew on it">
            <Icon name="send" size={14} /> Simulate</Button>}>
          <Segmented id="contacts-filter" size="sm" value={show} onChange={(v) => setFilter(v)}
            options={[{ id: 'mine', label: `Needs you · ${mineCount}` }, { id: 'all', label: `All · ${contacts?.length ?? 0}` }]} />
          <QueueBanner contacts={contacts ?? []} queue={status?.queue} />
          {show === 'mine' && mineCount === 0 && (
            <p className="text-sm text-ink-secondary py-s2">Nothing needs you. Switch to All to see what the crew handled.</p>
          )}
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col">
              <Kicker dot={g.dot}>{g.label} · {g.items.length}</Kicker>
          {g.items.map((c, i) => {
            const on = c.contact_id === caseId;
            return (
              <motion.button key={c.contact_id} onClick={() => setCaseId(c.contact_id)}
                initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i, 7) * 0.05, duration: 0.35, ease: ENTER }}
                className={`relative text-left px-s3 py-s3 mt-1 rounded-card border transition-colors duration-fast ease-out
                            ${on ? 'bg-accent-fill border-accent-line' : 'border-transparent hover:bg-surface-raised'}`}>
                {on && <motion.span layoutId="case-sel" className="absolute left-0 top-3 bottom-3 w-[3px] rounded-pill bg-accent" />}
                <span className="flex items-center justify-between gap-s2">
                  <span className="text-xs font-medium text-ink-secondary tabular-nums">{c.contact_id} · {c.customer_name ?? 'Web chat visitor'}</span>
                  {status?.queue.current === c.contact_id ? <Pill kind="ai">Crew working</Pill> : c.decision ? (
                    <Pill kind={c.resolved_by ? 'muted' : c.decision === 'auto' ? 'ok' : 'warn'}>
                      {c.resolved_by ? 'Specialist closed' : c.decision === 'auto' ? 'Resolved' : 'Specialist'}
                    </Pill>
                  ) : <Pill kind="accent">New</Pill>}
                </span>
                <span className="block text-smd text-ink-primary mt-1 line-clamp-2">{c.message}</span>
              </motion.button>
            );
          })}
            </div>
          ))}
        </Panel>
      </div>

      <div className="flex flex-col gap-s4 min-w-0">
        {selected ? (
          <>
            <CaseHeader contact={selected} running={running} hasRun={events.length > 0} onRun={() => run()}
              engine={view.start?.engine ?? engine} threshold={threshold} />
            {view.decision && !running && <DecisionBar view={view} contactId={selected.contact_id} name={selected.customer_name}
              onChange={() => { reload(); bump(); }} />}
            <CrewPanel view={view} running={running} contact={selected} />
            {view.decision && !running && <DecisionPanel view={view} />}
            {view.decision && !running && (view.brief ?? view.final?.result.brief) &&
              <CaseFilePanel markdown={(view.brief ?? view.final?.result.brief)!} handoff={view.decision.decision !== 'auto'} />}
            {view.decision && !running && (
              <Accordion key={`journey-${selected.contact_id}`} title="Case journey" icon={Route} defaultOpen={false} delay={0.08}
                meta="every hand it passed through">
                <Journey contactId={selected.contact_id} tick={tick} />
              </Accordion>
            )}
            {view.evidence.length > 0 && <EvidencePanel key={`ev-${selected.contact_id}`} view={view} />}
          </>
        ) : <Panel><p className="text-sm text-ink-secondary">Select a contact.</p></Panel>}
      </div>
    </div>
  );
}

const needsYou = (c: Contact) => c.decision === 'human' && !c.resolved_by;

function QueueBanner({ contacts, queue }: { contacts: Contact[]; queue?: Queue }) {
  const handled = contacts.filter((c) => c.decision && !needsYou(c)).length;
  const waiting = contacts.filter(needsYou).length;
  if (queue?.running) {
    return (
      <div className="rounded-card border border-ai-line bg-ai-fill px-s3 py-2.5 flex items-center gap-s2 text-sm text-ink-primary">
        <Spinner /> Crew is working the queue · {queue.done} of {queue.total}{queue.current ? ` · ${queue.current}` : ''}
      </div>
    );
  }
  if (!contacts.length || contacts.some((c) => !c.decision)) return null;
  return (
    <div className="rounded-card border border-line bg-surface-inset px-s3 py-2.5 text-sm text-ink-emphasis">
      The crew handled <span className="font-semibold text-ink-primary">{handled} of {contacts.length}</span> on its own.{' '}
      {waiting > 0 ? <span className="text-warn-text font-semibold">{waiting} need{waiting === 1 ? 's' : ''} you.</span> : 'Nothing needs you.'}
      {queue?.error && <span className="block text-xs text-crit-text mt-1">Queue stopped: {queue.error}</span>}
    </div>
  );
}

function CaseHeader({ contact, running, hasRun, onRun, engine, threshold }: {
  contact: Contact; running: boolean; hasRun: boolean; onRun: () => void; engine: string; threshold: number;
}) {
  return (
    <Panel>
      <div className="flex items-start justify-between gap-s4 max-md:flex-col">
        <div className="min-w-0 flex flex-col gap-s2">
          <div className="flex items-center gap-s2 flex-wrap">
            <span className="text-lg font-semibold tracking-[-0.01em] text-ink-primary">{contact.customer_name ?? 'Web chat visitor'}</span>
            <span className="text-xs text-ink-secondary tabular-nums">{contact.contact_id} · {contact.customer_id ?? 'no account'} · {hhmm(contact.received_at)}</span>
            <Pill kind={contact.verified ? 'ok' : 'warn'}>{contact.verified ? 'Verified, app' : 'Unverified, web chat'}</Pill>
          </div>
          <p className="text-md text-ink-primary leading-relaxed max-w-[70ch] border-l-2 border-[var(--accent)] pl-s3">“{contact.message}”</p>
        </div>
        <div className="flex flex-col items-end gap-s2 shrink-0 max-md:items-start">
          <Button variant="primary" onClick={onRun} disabled={running}>
            {running ? <Spinner /> : <Icon name="play" size={14} />} {running ? 'Crew working…' : hasRun ? 'Run again' : 'Run the crew'}
          </Button>
          <span className="text-xs text-ink-secondary tabular-nums">
            {engine === 'live' ? 'Claude' : engine === 'replay' ? 'Recorded run' : 'Rules engine'} · threshold {threshold.toFixed(2)}
          </span>
        </div>
      </div>
    </Panel>
  );
}

/** The run as the Agent Floor draws it: a chain of hands across the top, and the card for the selected hand under it.
 *  It follows whoever is working until the specialist clicks a step, and a new run or a new case follows again. */
function CrewPanel({ view, running, contact }: { view: ServiceView; running: boolean; contact: Contact }) {
  const reduce = useReducedMotion();
  const resolved = !!contact.resolved_by;
  const customerName = view.start?.customer?.name ?? contact.customer_name ?? 'Web chat visitor';
  const chain = useMemo(() => serviceChain(view, running, resolved, customerName), [view, running, resolved, customerName]);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => setPick(null), [contact.contact_id]);
  useEffect(() => { if (running) setPick(null); }, [running]);
  const sel = pick ?? followNode(chain.nodes);
  const usage = view.final?.result.usage;
  const stepsDone = chain.nodes.filter((n) => n.state === 'done' || n.state === 'ok').length;
  const stepsAll = chain.nodes.filter((n) => n.state !== 'skipped').length;
  const empty = !view.runs.length && !running;

  return (
    <Accordion title="Service crew" icon={Workflow} dot={running ? 'ai' : view.decision ? 'ok' : undefined}
      meta={usage && !running
        ? `${usage.calls} model calls · ${usd(usage.cost_usd)} · ${((view.final?.result.latency_ms ?? 0) / 1000).toFixed(1)}s`
        : empty ? 'not run yet' : `${stepsDone} of ${stepsAll} steps`}>
      {pick && running && <button onClick={() => setPick(null)} className="text-xs text-accent-bright hover:underline mb-s2">Follow live</button>}
      <Chain nodes={chain.nodes} back={chain.back} selected={empty ? null : sel} onSelect={setPick} />
      {empty ? (
        <p className="text-sm text-ink-secondary mt-s2">Nobody has worked this contact yet. Press <span className="text-ink-primary">Run the crew</span> to
          watch each bot get its brief, do its part, and hand it on.</p>
      ) : (
        <div className="mt-s4 pt-s5 border-t border-line">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={sel} className="max-w-[760px]"
              initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: ENTER }}>
              <ServiceDetail nodeId={sel} view={view} customerName={customerName} contact={contact} resolved={resolved} />
            </motion.div>
          </AnimatePresence>
          <StepNav sel={sel} steps={chain.nodes.map((n) => ({ ...n, key: n.id }))} onPick={setPick} />
        </div>
      )}
      {view.error && <p className="text-sm text-crit-text mt-s2">{view.error}</p>}
    </Accordion>
  );
}

function ConfidenceMeter({ value, threshold }: { value: number; threshold: number }) {
  const ok = value >= threshold;
  return (
    <div className="flex flex-col gap-s2">
      <div className="flex items-end justify-between">
        <span className="font-display text-metric font-semibold tabular-nums leading-none text-ink-primary">{value.toFixed(2)}</span>
        <span className="text-xs text-ink-secondary tabular-nums">threshold {threshold.toFixed(2)}</span>
      </div>
      <div className="relative h-2 rounded-pill bg-surface-inset border border-line">
        <motion.div className={`absolute left-0 top-0 h-full rounded-pill ${ok ? 'bg-ok' : 'bg-warn'}`}
          initial={{ width: 0 }} animate={{ width: `${value * 100}%` }} transition={{ duration: 0.7, ease: ENTER }} />
        <span className="absolute -top-1 bottom-[-4px] w-0.5 bg-ink-primary rounded-pill" style={{ left: `${threshold * 100}%` }} />
      </div>
    </div>
  );
}

const COMP_HELP: Record<string, string> = {
  support: 'Claims the Checker could verify', retrieval: 'How well the documents matched',
  grounding: 'Claims that cite a source', intent: 'Dispatcher certainty (scales the rest)',
};

function DecisionPanel({ view }: { view: ServiceView }) {
  const d = view.decision!;
  const r = view.final?.result;
  const auto = d.decision === 'auto';
  return (
    <Accordion title="How the crew decided" icon={Gauge} dot={auto ? 'ok' : 'warn'} delay={0.05}
      meta={`${auto ? 'Answered automatically' : 'Sent to a specialist'} · confidence ${d.confidence.toFixed(2)}`}>
      <div className="grid grid-cols-[260px_1fr] max-md:grid-cols-1 gap-s5">
        <div className="flex flex-col gap-s4">
          <Pill kind={auto ? 'ok' : 'warn'}>{auto ? 'Answered automatically' : 'Sent to a specialist'}</Pill>
          <ConfidenceMeter value={d.confidence} threshold={d.threshold} />
          <div className="grid grid-cols-2 rounded-card border border-line overflow-hidden">
            {Object.entries(d.components).map(([k, v], i) => (
              <div key={k} title={COMP_HELP[k]} className={`px-s3 py-2.5 bg-surface-inset ${i % 2 ? 'border-l border-line' : ''} ${i > 1 ? 'border-t border-line' : ''}`}>
                <div className="text-lg font-semibold tabular-nums text-ink-primary">{Math.round(v * 100)}%</div>
                <div className="text-xs font-medium text-ink-secondary capitalize">{k}</div>
              </div>
            ))}
          </div>
          <ul className="flex flex-col gap-1">
            {d.reasons.map((x, i) => (
              <li key={i} className="text-sm text-ink-secondary flex gap-2"><span className={auto ? 'text-ok-text' : 'text-warn-text'}>•</span>{x}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-s4 min-w-0">
          {r?.reply && (
            <div className="flex flex-col gap-s2">
              <Kicker>{auto ? 'Reply sent to customer' : 'Holding reply (sent with the handoff)'}</Kicker>
              <div className="rounded-card bg-surface-raised border border-line px-s4 py-s3 text-smd text-ink-primary leading-relaxed">{r.reply}</div>
            </div>
          )}
          {r?.claims && r.claims.length > 0 && (
            <div className="flex flex-col gap-s2">
              <Kicker>Claims checked · {r.claims.filter((c) => c.supported).length} of {r.claims.length}</Kicker>
              {r.claims.map((c, i) => (
                <div key={i} className="grid grid-cols-[16px_1fr] gap-s2 text-sm">
                  <Icon name={c.supported ? 'check' : 'x'} className={c.supported ? 'text-ok-text' : 'text-crit-text'} />
                  <span className="min-w-0">
                    <span className="text-ink-emphasis">{c.text}</span>
                    <span className="flex flex-wrap gap-1 mt-1">
                      {c.source_ids.map((s) => <code key={s} className="text-2xs font-code px-2 py-0.5 rounded-pill bg-surface-inset border border-line text-info-text">{s}</code>)}
                    </span>
                    {c.notes.map((n, j) => <span key={j} className="block text-xs text-crit-text mt-1">{n}</span>)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {view.actions.length > 0 && (
            <div className="flex flex-col gap-s2">
              <Kicker dot="ok">Actions taken</Kicker>
              {view.actions.map((a, i) => (
                <div key={i} className="flex items-center gap-s2 text-sm">
                  <Icon name="bolt" className="text-ink-secondary" />
                  <span className="font-medium text-ink-primary whitespace-nowrap">{human(a.action)}</span>
                  <span className="text-ink-secondary">{a.detail}</span>
                  {a.status === 'skipped' && <Pill kind="muted">skipped</Pill>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Accordion>
  );
}

/** The one thing a specialist does here, at the top of the case: the crew's recommendation and the buttons to act on it.
 *  A decision waits out the undo window (the toast at the bottom) before it is sent. */
function DecisionBar({ view, contactId, name, onChange }: { view: ServiceView; contactId: string; name?: string | null; onChange: () => void }) {
  const { queueDecision, pendingDecision } = useApp();
  const d = view.decision!;
  const r = view.final?.result;
  const first = name?.split(' ')[0] ?? 'the customer';
  const resolved = r?.resolved_by ? r : null;
  const h = view.handoff?.handoff ?? r?.handoff;
  const money = (r?.actions ?? []).find((a) => a.amount);
  const waiting = pendingDecision === contactId;
  const decide = (ok: boolean) => queueDecision({
    id: contactId,
    label: ok ? `Approved${money ? ` the ${usd(money.amount)} ${human(money.type.replace(/^issue_/, ''))}` : ''} for ${first}` : `Declined ${first}'s request`,
    commit: () => api.post<CaseResult>(`/api/cases/${contactId}/approve`, { approve: ok }),
    after: onChange,
  });

  if (d.decision === 'auto' || resolved) {
    return (
      <div className="surface-card rounded-panel px-s5 py-s4 flex items-center gap-s3 flex-wrap border-[color-mix(in_srgb,var(--status-ok)_35%,transparent)]">
        <span className="grid place-items-center w-9 h-9 rounded-pill bg-ok-fill text-ok-text shrink-0"><Icon name="check" size={16} /></span>
        <span className="text-smd text-ink-primary font-medium">
          {resolved ? `You ${resolved.specialist_decision ?? 'closed'} this case.` : `Answered automatically. ${first} has the reply.`}
        </span>
        <span className="text-sm text-ink-secondary">
          {resolved ? (resolved.specialist_actions ?? []).map((a) => a.detail).join(' · ') : `confidence ${d.confidence.toFixed(2)} vs bar ${d.threshold.toFixed(2)}`}
        </span>
      </div>
    );
  }
  return (
    <motion.div layout className="xl:sticky xl:top-0 z-20 relative rounded-panel overflow-hidden border border-accent-line bg-surface-solid">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="relative px-s6 py-s5 max-md:px-s4 flex items-center justify-between gap-s5 max-lg:flex-col max-lg:items-start">
        <div className="min-w-0 flex flex-col gap-s2">
          <span className="flex items-center gap-s2 flex-wrap">
            <Pill kind={waiting ? 'ok' : 'accent'}>{waiting ? 'Sending your decision' : 'Needs your decision'}</Pill>
            <span className="text-sm text-ink-secondary">crew {Math.round(d.confidence * 100)}% sure · {d.reasons[0]}</span>
          </span>
          {money && (
            <span className="font-display text-headline-md font-semibold text-ink-primary">
              {sentence(money.type)} <span className="text-accent-bright tabular-nums">{usd(money.amount)}</span>
            </span>
          )}
          {h && <p className="text-smd text-ink-emphasis leading-relaxed max-w-[80ch]"><span className="text-ink-secondary">The crew recommends: </span>{h.recommendation}</p>}
        </div>
        <div className="flex items-center gap-s2 shrink-0">
          {waiting ? <span className="text-sm text-ink-secondary">Undo from the bar below for a few seconds.</span> : (
            <>
              <Button variant="primary" size="lg" onClick={() => decide(true)}><Icon name="check" size={16} /> {money ? `Approve ${usd(money.amount)}` : 'Approve'}</Button>
              <Button size="lg" onClick={() => decide(false)}>Decline</Button>
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** The case file the Resolver and Checker read, built by code (brief.py). On a handoff it is the specialist's brief. */
function CaseFilePanel({ markdown, handoff }: { markdown: string; handoff: boolean }) {
  const [open, setOpen] = useState(handoff);
  return (
    <Accordion title="Case file" icon={FileText} defaultOpen={handoff} delay={0.06}
      meta="built by code, read by the Resolver, the Checker, and you">
      <div className={`relative flex flex-col gap-1.5 ${open ? '' : 'max-h-[260px] overflow-hidden'}`}>
        {markdown.split('\n').map((line, i) => <BriefLine key={i} line={line} />)}
        {/* a fade where the clipped file is cut off */}
        {!open && <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[var(--surface-panel)] to-transparent pointer-events-none" />} {/* smooth-ui-ignore */}
      </div>
      <div className="mt-s3"><Button variant="ghost" onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Show the whole file'}</Button></div>
    </Accordion>
  );
}

/** One line of the case file. Source IDs render as code so they read as the citations they are. */
function BriefLine({ line }: { line: string }) {
  const ids = (t: string) => t.split(/(\[[a-z_]+:[^\]]+\])/).map((part, i) =>
    /^\[[a-z_]+:/.test(part) ? <code key={i} className="text-2xs font-code px-1.5 py-px rounded-ctl bg-surface-inset border border-line text-info-text break-all">{part}</code> : part);
  if (!line.trim()) return <span className="h-s2" />;
  if (line.startsWith('# ')) return <h3 className="text-md font-semibold text-ink-primary">{line.slice(2)}</h3>;
  if (line.startsWith('## ')) return <span className="mt-s3"><Kicker dot="accent">{line.slice(3)}</Kicker></span>;
  if (line.startsWith('### ')) return <span className="text-sm font-medium text-ink-primary mt-s2">{ids(line.slice(4))}</span>;
  if (line.startsWith('> ')) return <blockquote className="text-sm text-ink-emphasis border-l-2 border-accent-line pl-s3">{line.slice(2)}</blockquote>;
  if (line.startsWith('  Record: ')) return <code className="code-block block text-2xs px-s3 py-1.5 ml-s4 break-all line-clamp-2" title={line.slice(10)}>{line.slice(2)}</code>;
  if (line.startsWith('Key line: ')) return <p className="text-sm text-ink-emphasis"><mark className="quote">{line.slice(10)}</mark></p>;
  if (/^(- |\d+\. )/.test(line)) return <p className="text-sm text-ink-emphasis leading-relaxed pl-s3 -indent-s3">{ids(line)}</p>;
  return <p className="text-sm text-ink-emphasis leading-relaxed">{ids(line)}</p>;
}

/** What the reply stands on, at the foot of the case: the cited sources in a grid, the rest one click away. */
function EvidencePanel({ view }: { view: ServiceView }) {
  const cited = new Set((view.final?.result.claims ?? []).flatMap((c) => c.source_ids));
  const [all, setAll] = useState(false);
  const citedOnly = cited.size > 0 && !all;
  const list = citedOnly ? view.evidence.filter((e) => cited.has(e.source_id)) : view.evidence;
  const hidden = view.evidence.length - list.length;
  return (
    <Accordion title={cited.size ? `Evidence the reply cites · ${cited.size}` : `Evidence · ${view.evidence.length}`} icon={FileSearch}
      defaultOpen={false} delay={0.1} meta={`${view.evidence.length} sources looked at`}>
      <div className="grid grid-cols-2 max-lg:grid-cols-1 gap-s3 items-start">
        <AnimatePresence initial={false} mode="sync">
          {list.map((e) => <EvidenceCard key={e.source_id} e={e} cited={cited.has(e.source_id)} />)}
        </AnimatePresence>
      </div>
      {(hidden > 0 || (all && cited.size > 0)) && (
        <div className="mt-s3"><Button variant="ghost" onClick={() => setAll(!all)}>
          {all ? 'Only what the reply cites' : `Show ${hidden} more the crew looked at`}
        </Button></div>
      )}
    </Accordion>
  );
}

function highlight(text: string, quote?: string | null) {
  if (!quote) return text;
  const norm = (s: string) => s.replace(/\s+/g, ' ');
  const t = norm(text), q = norm(quote);
  const i = t.indexOf(q);
  if (i < 0) return t;
  return <>{t.slice(0, i)}<mark className="quote">{q}</mark>{t.slice(i + q.length)}</>;
}

function EvidenceCard({ e, cited }: { e: Evidence; cited: boolean }) {
  const [open, setOpen] = useState(false);
  const db = e.kind === 'db';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: ENTER }}
      className={`rounded-card border px-s4 py-s3 flex flex-col gap-s2 shadow-card ${cited ? 'border-accent-line bg-surface-raised' : 'border-line bg-surface-inset'}`}>
      <div className="flex items-center gap-s2">
        <span className="grid place-items-center w-7 h-7 rounded-chip bg-surface-hover text-ink-emphasis shrink-0"><Icon name={db ? 'db' : 'doc'} size={14} /></span>
        <span className="text-xs font-semibold text-ink-secondary">{KIND_LABEL[e.kind] ?? e.kind}</span>
        {cited && <Pill kind="accent">Cited</Pill>}
        {e.quote_verified === false && <Pill kind="crit">Quote not found</Pill>}
      </div>
      <span className="text-sm font-medium text-ink-primary">{e.title}</span>
      {db ? <CodeBlock code={e.text} label={e.source_id} json={false} maxH={open ? 'max-h-none' : 'max-h-32'} />
        : <>
          <code className="self-start text-2xs font-code px-2 py-0.5 rounded-pill bg-surface-inset border border-line text-info-text break-all">{e.source_id}</code>
          <p className={`text-sm text-ink-emphasis leading-relaxed ${open ? '' : 'line-clamp-4'}`}>{highlight(e.text, e.quote)}</p>
        </>}
      {e.text.length > 220 && (
        <button onClick={() => setOpen(!open)} className="self-start text-xs text-ink-secondary hover:text-ink-primary transition-colors duration-fast">
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
      {e.source_id.startsWith('db:robots/') && <RobotTrace id={e.source_id.split('/')[1]} />}
    </motion.div>
  );
}

function RobotTrace({ id }: { id: string }) {
  const { data } = useApi<{ telemetry: { ts: string; motor_l_amps: number; box_temp_c: number }[]; fault_code: string | null }>(`/api/robots/${id}`);
  if (!data) return null;
  const tel = data.telemetry.slice(-18);
  const motor = (data.fault_code ?? '').startsWith('MTR');
  return (
    <div className="mt-1">
      <span className="text-xs font-medium text-ink-secondary">{motor ? 'Left motor current, last 3 h (A)' : 'Warming box, last 3 h (°C)'}</span>
      <Sparkline values={tel.map((t) => (motor ? t.motor_l_amps : t.box_temp_c))} labels={tel.map((t) => t.ts.slice(11, 16))}
        refLine={motor ? 12 : 57} refLabel={motor ? 'stall 12 A' : 'cold 57°C'} unit={motor ? ' A' : '°C'} height={56} />
    </div>
  );
}

function Composer({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const { data: customers } = useApi<{ customer_id: string; name: string }[]>('/api/customers');
  const [who, setWho] = useState('C-1042');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!msg.trim()) return;
    setBusy(true);
    try {
      const anon = who === 'anon';
      const c = await api.post<Contact>('/api/contacts', { customer_id: anon ? null : who, verified: !anon,
        channel: anon ? 'web_chat' : 'app', message: msg });
      setMsg('');
      onCreated(c.contact_id);
    } finally { setBusy(false); }
  };
  return (
    <Panel kicker="Simulate a customer message"
      action={<button onClick={onClose} className="text-ink-secondary hover:text-ink-primary transition-colors duration-fast" aria-label="Close"><Icon name="x" size={14} /></button>}>
      <div className="flex flex-col gap-s2">
        <select value={who} onChange={(e) => setWho(e.target.value)}
          className="h-9 rounded-ctl bg-surface-inset border border-line px-s3 text-smd text-ink-primary focus:outline-none focus:border-accent-line">
          {customers?.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.name} · {c.customer_id} · app</option>)}
          <option value="anon">Web chat visitor · unverified</option>
        </select>
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={3} placeholder="Type as the customer, e.g. “my lid won't open”"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
          className="rounded-chip bg-surface-inset border border-line px-s3 py-s2 text-smd text-ink-primary placeholder:text-ink-secondary resize-none
                     focus:outline-none focus:border-accent-line" />
        <div className="flex items-center justify-between">
          <span className="text-2xs text-ink-secondary">Ctrl + Enter to send</span>
          <Button variant="primary" onClick={send} disabled={busy || !msg.trim()}><Icon name="send" /> Send and run</Button>
        </div>
      </div>
    </Panel>
  );
}
