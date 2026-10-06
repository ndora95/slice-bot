/* The customer's side of the counter: cream and tomato, like the app on their phone. The order is the hero: when it
 * arrives, in big type, with a live map of the robot driving their route. If something went wrong on the way, SliceBot
 * says so first, before they have to ask. The chat sits beside it: suggested questions when it is empty, and under every
 * answer a quiet line saying what SliceBot checked to give it. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { HandCoins, Receipt } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../App';
import { CourierBot } from '../components/Illustration';
import { LogoMark } from '../components/Logo';
import { RouteMap } from '../components/RouteMap';
import { Button, ENTER, Icon, Skeleton } from '../components/ui';
import { api, streamCase } from '../lib/api';
import { hhmm, usd } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { CaseEvent, City, Contact } from '../lib/types';

interface View {
  customer: { customer_id: string; name: string; plan: string; zone: string };
  orders: { order_id: string; status: string; robot_id: string; backup_robot_id: string | null; revised_eta: string | null;
            promised_at: string; delivered_at: string | null; total: number; items: { name: string; price: number }[];
            placed_at?: string; subtotal?: number; delivery_fee?: number; tip?: number }[];
  adjustments: { kind: string; amount: number; reason: string }[];
  conversation: { contact_id: string; message: string; reply: string | null; followup: string | null; decision: string | null;
                  resolved_by: string | null }[];
}

const STARTERS = ["Where's my pizza?", 'My pizza arrived cold', 'I was charged twice', 'What can I get that’s vegetarian?'];

export default function CustomerScreen() {
  const { tick, bump, engine, threshold, status, demoCustomer: who } = useApp();
  const { data, reload } = useApi<View>(`/api/customers/${who}`, tick);
  const { data: city } = useApi<City>('/api/city', tick);
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [checking, setChecking] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // Keep the chat on its latest message, scrolling only the chat itself (never the page, which holds the order).
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, [data, pending, checking.length, reduce]);

  const send = async (raw = msg) => {
    const text = raw.trim();
    if (!text || pending) return;
    setMsg(''); setPending(text); setChecking([]);
    const c = await api.post<Contact>('/api/contacts', { customer_id: who, verified: true, channel: 'app', message: text });
    setPendingId(c.contact_id);
    // While the crew works, the typing bubble says what it is checking, in the customer's words.
    streamCase(c.contact_id, { threshold, engine }, (e: CaseEvent) => {
      if (e.type === 'tool') { const f = friendly(e.name, e.args); if (f) setChecking((xs) => (xs.includes(f) ? xs : [...xs, f])); }
    }, () => { setPending(null); setPendingId(null); reload(); bump(); });
  };

  const o = data?.orders[0];
  const first = data?.customer.name.split(' ')[0] ?? '';
  const robot = o ? o.backup_robot_id ?? o.robot_id : null;
  const route = city?.robots.find((r) => r.robot_id === robot)?.route ?? null;
  const eta = o ? o.delivered_at ?? o.revised_eta ?? o.promised_at : null;
  const delivered = o?.status === 'delivered';
  const late = o?.status === 'delayed';

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,480px)] max-lg:grid-cols-1 gap-s5 min-h-full max-w-[1240px] mx-auto">
      {/* the order */}
      <div className="flex flex-col gap-s4 min-w-0">
        {!o ? <Skeleton className="h-[520px] rounded-panel" /> : (
          <motion.section initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: ENTER }}
            className="surface-card rounded-panel overflow-hidden">
            <div className="px-s6 pt-s6 pb-s5 max-md:px-s4 flex flex-col gap-s2">
              <span className={`flex items-center gap-s2 text-xs font-semibold uppercase tracking-[0.1em] ${late ? 'text-warn-text' : delivered ? 'text-ok-text' : 'text-accent-bright'}`}>
                <span className={`w-1.5 h-1.5 rounded-pill ${late ? 'bg-warn' : delivered ? 'bg-ok' : 'bg-accent'}`} />
                {delivered ? 'Delivered' : late ? 'Running late' : 'On its way'} · {o.order_id}
              </span>
              <h1 className="font-display text-headline-xl font-semibold text-ink-primary">
                {delivered ? <>Delivered at {hhmm(eta)}</> : <>Arriving <span className="text-accent-bright">{hhmm(eta)}</span></>}
              </h1>
              <p className="text-md text-ink-secondary max-w-[56ch]">
                {o.backup_robot_id
                  ? `${o.robot_id} had a problem on the way, so ${o.backup_robot_id} picked up your order and is bringing it now.`
                  : delivered ? 'Hope it was hot. If anything was off, tell us in the chat.' : `${o.robot_id} is bringing it from the Capitol Hill kitchen.`}
              </p>
            </div>
            {route && !delivered && (
              <div className="relative border-y border-line">
                <RouteMap path={route.path} progress={Math.max(0.12, Math.min(0.9, route.progress ?? 0.5))} label={robot ?? undefined} className="h-[280px]" />
              </div>
            )}
            <div className="px-s6 max-md:px-s4 py-s5">
              <DeliveryTrack status={o.status} placed={o.placed_at} eta={eta!} clock={status?.clock} />
            </div>
          </motion.section>
        )}

        {o && <ReceiptCard order={o} />}

        {data && data.adjustments.length > 0 && (
          <section className="surface-card rounded-panel p-s5 flex flex-col gap-s3">
            <span className="text-sm font-semibold text-ink-primary">Credits and refunds</span>
            {data.adjustments.map((a, i) => (
              <div key={i} className="flex items-center gap-s3 rounded-card border border-line bg-surface-inset px-s3 py-s3">
                <span className="grid place-items-center w-9 h-9 rounded-chip bg-ok-fill text-ok-text shrink-0"><HandCoins size={17} /></span>
                <span className="flex-1 min-w-0 text-sm text-ink-emphasis">{a.reason}</span>
                <span className="font-display text-lg font-semibold text-ok-text tabular-nums">{usd(a.amount)}</span>
              </div>
            ))}
          </section>
        )}
      </div>

      {/* the chat */}
      <section className="surface-card rounded-panel flex flex-col min-h-[560px] lg:sticky lg:top-0 lg:max-h-[calc(100vh-108px)] overflow-hidden">
        <header className="flex items-center gap-s3 px-s5 py-s4 border-b border-line">
          <LogoMark size={36} />
          <div className="flex flex-col leading-tight">
            <span className="text-smd font-semibold text-ink-primary">SliceBot Care</span>
            <span className="flex items-center gap-1.5 text-xs text-ink-secondary"><span className="w-1.5 h-1.5 rounded-pill bg-ok" />Replies in seconds, any time</span>
          </div>
        </header>

        <div ref={scroller} className="flex-1 overflow-y-auto px-s5 py-s4 flex flex-col gap-s4 min-h-0 max-lg:max-h-[60vh]">
          <span className="self-center text-2xs font-medium text-ink-secondary">Today {hhmm(status?.clock)}</span>
          {/* SliceBot speaks first when the order hit a problem */}
          {o?.backup_robot_id && !delivered && (
            <Bubble who="SliceBot · heads up" text={`Hi ${first}, ${o.robot_id} had a problem on the way, so ${o.backup_robot_id} picked up your order. New arrival ${hhmm(o.revised_eta ?? o.promised_at)}. You can follow it on the map.`} />
          )}
          <AnimatePresence initial={false}>
            {data?.conversation.map((c) => (
              <motion.div key={c.contact_id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: ENTER }}
                className="flex flex-col gap-s3">
                <Bubble me text={c.message} />
                {!c.reply && c.contact_id !== pendingId && <span className="self-end text-xs text-ink-secondary">Not answered yet. A specialist will pick it up.</span>}
                {c.reply && <Bubble text={c.reply} checked={c.contact_id}
                  note={c.decision === 'human' ? (c.resolved_by ? 'A specialist reviewed this.' : 'A specialist will follow up shortly.') : undefined} />}
                {c.followup && <Bubble text={c.followup} who="SliceBot Care" />}
              </motion.div>
            ))}
          </AnimatePresence>
          {pending && (
            <div className="flex flex-col gap-s3">
              <Bubble me text={pending} />
              <Typing checking={checking} />
            </div>
          )}
        </div>

        {!pending && (
          <div className="px-s5 pb-s2 flex gap-s2 overflow-x-auto">
            {STARTERS.map((q, i) => (
              <motion.button key={q} onClick={() => send(q)} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: ENTER, delay: 0.1 + i * 0.04 }}
                className="shrink-0 h-8 px-s3 rounded-pill border border-line-strong bg-surface-panel text-sm text-ink-emphasis
                           hover:border-accent-line hover:text-accent-bright transition-colors duration-fast ease-out">{q}</motion.button>
            ))}
          </div>
        )}
        <form className="m-s4 mt-s2 flex items-center gap-s2 p-1.5 pl-s4 rounded-pill bg-surface-inset border border-line-strong focus-within:border-accent-line
                         focus-within:ring-2 focus-within:ring-[var(--accent-fill)] transition-[border-color] duration-fast" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message SliceBot"
            className="flex-1 min-w-0 h-9 bg-transparent text-smd text-ink-primary placeholder:text-ink-secondary focus:outline-none focus:ring-0" />
          <Button type="submit" variant="primary" disabled={!msg.trim() || !!pending}><Icon name="send" /> Send</Button>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- what SliceBot checked, in the customer's words

function friendly(name: string, args: Record<string, unknown>): string | null {
  const id = (k: string) => (typeof args[k] === 'string' ? ` ${args[k]}` : '');
  return ({
    lookup_customer: 'your account', list_orders: 'your recent orders', get_order: `order${id('order_id')}`, get_payments: 'your payments',
    get_adjustments: 'credits and refunds', get_ticket: `ticket${id('ticket_id')}`, list_tickets: 'your tickets',
    get_robot: `robot${id('robot_id')}`, get_delivery_telemetry: 'the warming box readings', scan_fleet: 'the rest of the fleet',
    find_backup_robot: 'nearby robots',
  } as Record<string, string>)[name] ?? null;
}

/** "Checked your order, your payments, and our refund policy." Read from the saved run, after the reply lands. */
function Checked({ contactId }: { contactId: string }) {
  const { data } = useApi<{ events: CaseEvent[] }>(`/api/cases/${contactId}`);
  const items: string[] = [];
  for (const e of data?.events ?? []) {
    if (e.type === 'tool') { const f = friendly(e.name, e.args); if (f && !items.includes(f)) items.push(f); }
    if (e.type === 'evidence' && e.kind === 'policy' && !items.includes('our policy')) items.push('our policy');
  }
  if (!items.length) return null;
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
  return (
    <span className="flex items-start gap-1.5 text-xs text-ink-secondary px-s2 leading-snug">
      <Icon name="check" size={12} className="text-ok-text mt-0.5 shrink-0" />Checked {list}
    </span>
  );
}

// ---------------------------------------------------------------- delivery track

const STAGES = ['Placed', 'In the oven', 'On the way', 'At your door'];

/** Where the order is, as a track the courier robot rides. Out for delivery, it moves along the last leg by the clock. */
function DeliveryTrack({ status, placed, eta, clock }: { status: string; placed?: string; eta: string; clock?: string }) {
  const reduce = useReducedMotion();
  const stage = status === 'delivered' ? 3 : status === 'preparing' || status === 'ready' || status === 'placed' ? 1 : 2;
  const late = status === 'delayed';
  let pos = stage / 3;
  if (stage === 2 && placed && clock) {
    const f = (Date.parse(clock) - Date.parse(placed)) / Math.max(1, Date.parse(eta) - Date.parse(placed));
    pos = 2 / 3 + Math.min(0.85, Math.max(0.1, f)) / 3;
  }
  const fill = late ? 'bg-warn' : stage === 3 ? 'bg-ok' : 'bg-accent';
  return (
    <div className="flex flex-col gap-s2">
      <div className="relative h-[78px]" aria-label={`Order ${STAGES[stage].toLowerCase()}`} role="img">
        {/* the robot and its pizza, riding the track at the order's current phase */}
        <motion.div className="absolute bottom-[16px] -translate-x-1/2"
          initial={reduce ? false : { left: '0%' }} animate={{ left: `${pos * 100}%` }}
          transition={reduce ? { duration: 0 } : { duration: 1.1, ease: ENTER }}>
          <motion.div animate={reduce || stage === 3 ? undefined : { y: [0, -2, 0] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}>
            <CourierBot size={62} late={late} />
          </motion.div>
        </motion.div>
        <div className="absolute inset-x-0 bottom-[8px] h-1.5 rounded-pill bg-surface-hover overflow-hidden">
          <motion.div className={`h-full rounded-pill ${fill}`}
            initial={reduce ? false : { width: 0 }} animate={{ width: `${pos * 100}%` }}
            transition={reduce ? { duration: 0 } : { duration: 1.1, ease: ENTER }} />
        </div>
        {STAGES.map((_, i) => (
          <span key={i} className={`absolute bottom-[3px] -translate-x-1/2 w-4 h-4 rounded-pill border-[3px] border-[var(--surface-panel)]
                                    ${i <= stage ? (late && i === stage ? 'bg-warn' : i === 3 ? 'bg-ok' : 'bg-accent') : 'bg-surface-hover'}`}
            style={{ left: `${(i / 3) * 100}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-4 text-xs">
        {STAGES.map((label, i) => (
          <span key={label} className={`flex flex-col ${i === 0 ? 'items-start' : i === 3 ? 'items-end text-right' : 'items-center text-center'}`}>
            <span className={`font-semibold ${i === stage ? (late ? 'text-warn-text' : 'text-ink-primary') : i < stage ? 'text-ink-emphasis' : 'text-ink-faint'}`}>{label}</span>
            <span className="text-ink-secondary tabular-nums">{i === 0 && placed ? hhmm(placed) : i === 3 ? hhmm(eta) : ' '}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function ReceiptCard({ order: o }: { order: View['orders'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="surface-card rounded-panel overflow-hidden">
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex items-center gap-s3 px-s5 py-s4 text-left hover:bg-surface-raised transition-colors duration-fast ease-out">
        <span className="grid place-items-center w-9 h-9 rounded-chip bg-surface-raised border border-line text-ink-secondary"><Receipt size={16} /></span>
        <span className="flex-1 min-w-0">
          <span className="block text-smd font-semibold text-ink-primary">{o.items.map((i) => i.name).join(', ')}</span>
          <span className="block text-xs text-ink-secondary">Receipt · {o.order_id}</span>
        </span>
        <span className="font-display text-lg font-semibold text-ink-primary tabular-nums">{usd(o.total)}</span>
        <Icon name="chevron" size={16} className={`text-ink-secondary transition-transform duration-med ease-out ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: ENTER }} className="overflow-hidden">
            <div className="flex flex-col gap-s2 px-s5 py-s3 border-t border-line">
              {o.items.map((i, k) => (
                <div key={k} className="flex items-baseline justify-between gap-s3 text-smd">
                  <span className="text-ink-emphasis">{i.name}</span><span className="text-ink-primary tabular-nums">{usd(i.price)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1 px-s5 py-s3 border-t border-dashed border-line-strong text-sm">
              {o.subtotal != null && <Row k="Subtotal" v={usd(o.subtotal)} />}
              {o.delivery_fee != null && <Row k="Delivery" v={usd(o.delivery_fee)} />}
              {!!o.tip && <Row k="Tip" v={usd(o.tip)} />}
              <div className="flex items-baseline justify-between pt-s2">
                <span className="text-smd font-semibold text-ink-primary">Total</span>
                <span className="text-lg font-semibold text-ink-primary tabular-nums">{usd(o.total)}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex items-baseline justify-between text-ink-secondary"><span>{k}</span><span className="tabular-nums">{v}</span></div>;
}

// ---------------------------------------------------------------- chat

/** A message bubble with a tail: tomato for the customer, a warm raised card for SliceBot. */
function Bubble({ text, me, note, who, checked }: { text: string; me?: boolean; note?: string; who?: string; checked?: string }) {
  return (
    <div className={`flex items-end gap-s2 max-w-[86%] ${me ? 'self-end flex-row-reverse' : 'self-start'}`}>
      {!me && <LogoMark size={28} />}
      <div className={`flex flex-col gap-1 min-w-0 ${me ? 'items-end' : 'items-start'}`}>
        <span className="text-2xs font-medium text-ink-secondary px-s2">{me ? 'You' : who ?? 'SliceBot'}</span>
        <div className="relative">
          <div className={`px-s4 py-2.5 text-smd leading-relaxed rounded-[20px] ${me ? 'rounded-br-[6px] bg-accent text-[var(--accent-ink)]'
            : 'rounded-bl-[6px] bg-surface-raised text-ink-primary'}`}>{text}</div>
          <svg aria-hidden width="12" height="16" viewBox="0 0 12 16" className={`absolute bottom-0 ${me ? '-right-[6px]' : '-left-[6px] -scale-x-100'}`}>
            <path d="M0 0 C1 9 5 14 12 16 L0 16 Z" style={{ fill: me ? 'var(--accent)' : 'var(--surface-raised)' }} />
          </svg>
        </div>
        {checked && <Checked contactId={checked} />}
        {note && <span className="text-xs text-warn-text px-s2">{note}</span>}
      </div>
    </div>
  );
}

/** The typing bubble, with what SliceBot is checking right now underneath it. */
function Typing({ checking }: { checking: string[] }) {
  return (
    <div className="self-start flex items-end gap-s2">
      <LogoMark size={28} />
      <div className="flex flex-col gap-1 items-start">
        <span className="text-2xs font-medium text-ink-secondary px-s2">SliceBot</span>
        <div className="flex items-center gap-1 px-s4 py-3.5 rounded-[20px] rounded-bl-[6px] bg-surface-raised">
          {[0, 1, 2].map((i) => <span key={i} className="typing-dot w-2 h-2 rounded-pill bg-ink-secondary" />)}
        </div>
        <AnimatePresence initial={false}>
          {checking.slice(-1).map((c) => (
            <motion.span key={c} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="text-xs text-ink-secondary px-s2">Checking {c}…</motion.span>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
