/* The front door. The city is the hero: the real streets of Capitol Hill and Navy Yard, full-bleed, with the fleet
 * driving them. The seats sit in a column on the left; hovering one points the map at what that person watches and the
 * caption on the right says it in a sentence. The robot watches you choose. Picking a seat dives the camera into the city,
 * the avatar flies up into the console's header, and the console builds around you. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useRef, useState } from 'react';
import { inboxCount, PERSONAS } from '../App';
import { HeroVehicle } from '../components/Illustration';
import { LogoMark, Wordmark } from '../components/Logo';
import { PersonaAvatar } from '../components/PersonaAvatar';
import StreetField from '../components/StreetField';
import { ENTER, Icon } from '../components/ui';
import { hhmm } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { City, Inbox, Role, Status } from '../lib/types';

const ORDER: Role[] = ['customer', 'specialist', 'head', 'repair_lead', 'mechanic'];
const PANEL_W = 440;

function waiting(role: Role, n: number): string {
  if (role === 'specialist') return `${n} handoff${n === 1 ? '' : 's'} waiting`;
  if (role === 'repair_lead') return `${n} repair${n === 1 ? '' : 's'} to approve`;
  return `${n} job${n === 1 ? '' : 's'} booked`;
}

function service(clock?: string) {
  const h = clock ? Number(clock.slice(11, 13)) + Number(clock.slice(14, 16)) / 60 : 13;
  return h < 11 ? 'Morning prep' : h < 15 ? 'Lunch service' : h < 17 ? 'Afternoon lull' : h < 20.5 ? 'Dinner rush' : 'Late night';
}

interface CustomerView { customer: { name: string; zone: string }; orders: { robot_id: string; backup_robot_id: string | null; revised_eta: string | null; promised_at: string; status: string }[] }

export default function SignIn({ onPick, inbox, status }: { onPick: (r: Role) => void; inbox: Inbox | null; status: Status | null }) {
  const reduce = !!useReducedMotion();
  const { data: city } = useApi<City>('/api/city');
  const { data: maya } = useApi<CustomerView>('/api/customers/C-1042');
  const [active, setActive] = useState<Role | null>(null);
  const [picked, setPicked] = useState<Role | null>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const hero = useRef<HTMLDivElement>(null);
  const r = status?.robots ?? {};
  const offRoad = (r.fault ?? 0) + (r.grounded ?? 0) + (r.in_repair ?? 0);
  const t = (delay: number, duration = 0.45) => (reduce ? { duration: 0 } : { delay, duration, ease: ENTER });
  const order = maya?.orders[0];
  const mine = order ? order.backup_robot_id ?? order.robot_id : null;
  const k = city?.kitchen;
  const w = status?.weather;

  // The robot looks at the pointer; hovering a seat, it looks at that seat.
  const lookAt = (x: number, y: number) => {
    const b = hero.current?.getBoundingClientRect();
    if (!b) return;
    setLook({ x: (x - (b.left + b.width / 2)) / (b.width * 0.9), y: (y - (b.top + b.height / 2)) / (b.height * 1.6) });
  };
  const hover = (role: Role | null, el?: HTMLElement | null) => {
    if (picked) return;
    setActive(role);
    if (el) { const b = el.getBoundingClientRect(); lookAt(b.left + 60, b.top + b.height / 2); }
  };
  const pick = (role: Role) => {
    if (picked) return;
    setPicked(role); setActive(role);
    window.setTimeout(() => onPick(role), reduce ? 0 : 720);
  };

  // Up and down move between seats, so the list works like a menu from the keyboard.
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    rows.current[(next + ORDER.length) % ORDER.length]?.focus();
  };

  const caption = (role: Role) => {
    const n = inboxCount(role, inbox);
    if (role === 'customer') return order ? `Her pizza is on ${mine}${order.backup_robot_id ? ` (it took over from ${order.robot_id})` : ''}, arriving ${hhmm(order.revised_eta ?? order.promised_at)}.` : 'Her order, live.';
    if (role === 'specialist') return n ? `${waiting(role, n)}. The research on ${n === 1 ? 'it' : 'each'} is already done.` : 'Nothing waiting. The crew is handling the inbox.';
    if (role === 'head') return `${r.active ?? 0} robots on the road, ${status?.open_cases ?? 0} open cases, one dial for how sure the crew must be.`;
    if (role === 'repair_lead') return `${offRoad} robots off the road and ${n} repair${n === 1 ? '' : 's'} to approve before the dinner rush.`;
    return 'Navy Yard Depot. Jobs arrive with the part and the bin already reserved.';
  };

  return (
    <div className="grain relative min-h-screen overflow-hidden bg-surface" onPointerMove={(e) => !active && !picked && lookAt(e.clientX, e.clientY)}>
      <StreetField reduce={reduce} city={city} focus={picked ?? active} mine={mine} leaving={!!picked}
        mineLabel={maya ? `${maya.customer.name.split(' ')[0]}, ${maya.customer.zone}` : 'Customer'}
        anchorX={(vw) => (vw >= 1024 ? PANEL_W + 48 + (vw - PANEL_W - 48) / 2 : vw / 2)} />
      {/* a scrim behind the seats, so the column reads over the streets; the right side stays clear for the city */}
      <div aria-hidden className="absolute inset-y-0 left-0 w-[min(760px,100%)] pointer-events-none max-lg:w-full max-lg:opacity-70
                                  bg-[linear-gradient(90deg,var(--surface-bg)_0%,var(--surface-bg)_28%,transparent_100%)]" /> {/* smooth-ui-ignore: scrim over the map */}
      <motion.div aria-hidden className="absolute inset-0 pointer-events-none bg-surface" initial={false}
        animate={{ opacity: picked ? 1 : 0 }} transition={t(0.32, 0.4)} />

      <div className="relative min-h-screen flex items-center lg:pl-s8 px-s4 py-s6 max-lg:justify-center">
        <motion.main initial={reduce ? false : { opacity: 0, x: -24 }} animate={picked ? { opacity: 0, x: -32 } : { opacity: 1, x: 0 }}
          transition={picked ? t(0.05, 0.35) : t(0.05, 0.6)}
          className="surface-card w-full rounded-[28px] overflow-hidden" style={{ maxWidth: PANEL_W }}>
          <div ref={hero}>
            <HeroVehicle className="border-b border-line" look={look} mood={picked ? 'happy' : 'idle'} lid={picked === 'customer' || active === 'customer'} />
          </div>
          <header className="flex flex-col gap-s4 px-s6 pt-s5 pb-s4 max-md:px-s5">
            <div className="flex items-center gap-s3">
              <LogoMark size={40} />
              <Wordmark sub={status?.place ?? 'Capitol Hill & Navy Yard · DC'} size={24} />
            </div>
            <h1 className="font-display text-headline-md leading-[1.15] font-semibold text-ink-primary">
              Pick a seat.
              <span className="block text-md font-sans font-normal tracking-normal text-ink-secondary mt-s2 leading-relaxed">
                The bots work every complaint and repair first. Each seat sees only the calls that need a person.
              </span>
            </h1>
          </header>

          <ul className="flex flex-col gap-0.5 px-s3 pb-s3" onMouseLeave={() => hover(null)}>
            {ORDER.map((role, i) => {
              const p = PERSONAS[role];
              const n = inboxCount(role, inbox);
              const on = active === role;
              const dim = picked && picked !== role;
              return (
                <motion.li key={role} initial={reduce ? false : { opacity: 0, x: -10 }} animate={{ opacity: dim ? 0.25 : 1, x: 0 }}
                  transition={t(dim ? 0 : 0.18 + i * 0.05, 0.4)}>
                  <button ref={(el) => { rows.current[i] = el; }} onClick={() => pick(role)}
                    onMouseEnter={(e) => hover(role, e.currentTarget)} onFocus={(e) => hover(role, e.currentTarget)} onBlur={() => hover(null)}
                    onKeyDown={(e) => onKey(e, i)} aria-label={`Sign in as ${p.name}, ${p.title}${n ? `, ${waiting(role, n)}` : ''}`}
                    className="relative w-full grid grid-cols-[40px_1fr_auto] items-center gap-s3 px-s3 py-2.5 rounded-card text-left">
                    {on && (
                      <motion.span layoutId="seat-hover" aria-hidden className="absolute inset-0 rounded-card bg-surface-raised border border-line-strong"
                        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 38 }} />
                    )}
                    <span className="relative"><PersonaAvatar role={role} size={40} active={on} layoutId={picked === role ? 'persona-avatar' : undefined} /></span>
                    <span className="relative min-w-0">
                      <span className="block text-smd font-semibold text-ink-primary truncate">{p.name}</span>
                      <span className={`block text-sm truncate transition-colors duration-fast ease-out ${on ? 'text-ink-emphasis' : 'text-ink-secondary'}`}>{p.title}</span>
                    </span>
                    <span className="relative flex items-center gap-s3">
                      {n > 0 && (
                        <span title={waiting(role, n)} className="min-w-[24px] text-center text-xs font-semibold tabular-nums px-2 py-0.5 rounded-pill bg-warn-fill text-warn-text">{n}</span>
                      )}
                      <span className={`grid place-items-center w-7 h-7 rounded-pill transition-[background-color,color,transform] duration-fast ease-out
                                        ${on ? 'bg-accent text-[var(--accent-ink)] translate-x-0.5' : 'text-ink-faint'}`}>
                        <Icon name="arrow" size={14} />
                      </span>
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ul>

          <footer className="flex items-center gap-s2 px-s6 max-md:px-s5 py-s3 border-t border-line text-xs tabular-nums text-ink-secondary bg-surface-inset">
            <span className={`w-1.5 h-1.5 rounded-pill ${status ? 'bg-ok' : 'bg-ink-faint'}`} />
            {status ? <>{status.robots_total} robots · {r.active ?? 0} active · {offRoad} off the road</> : 'Connecting to the service API…'}
          </footer>
        </motion.main>
      </div>

      {/* top right: where and when */}
      <motion.div initial={reduce ? false : { opacity: 0, y: -8 }} animate={{ opacity: picked ? 0 : 1, y: 0 }} transition={t(0.3)}
        className="absolute right-s8 top-s6 max-lg:hidden flex items-center gap-s3 text-sm text-ink-emphasis tabular-nums">
        {status && <span className="flex items-center gap-1.5"><Icon name="clock" size={14} className="text-ink-secondary" />{hhmm(status.clock)}</span>}
        {w && <><span className="w-px h-4 bg-line-strong" /><span>{Math.round(w.temp_f)}°F, {w.summary.toLowerCase()}</span></>}
        <span className="w-px h-4 bg-line-strong" /><span className="text-ink-secondary">Washington, DC</span>
      </motion.div>

      {/* bottom right: the kitchen, live; or, hovering a seat, what that person sees */}
      <div className="absolute right-s8 bottom-s8 max-lg:hidden w-[min(560px,calc(100vw-560px))] pointer-events-none">
        <AnimatePresence mode="wait">
          {!picked && (active ? (
            <motion.div key={active} initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.28, ease: ENTER }} className="flex flex-col gap-s2 text-right items-end">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-bright">{PERSONAS[active].title}</span>
              <span className="font-display text-headline-lg font-semibold text-ink-primary leading-[1.05]">{PERSONAS[active].name.split(' ')[0]}&apos;s view</span>
              <span className="text-md text-ink-emphasis leading-relaxed max-w-[46ch]">{caption(active)}</span>
            </motion.div>
          ) : (
            <motion.div key="live" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.35, ease: ENTER, delay: 0.25 }} className="flex flex-col gap-s4 items-end text-right">
              <span className="flex items-center gap-s2 text-xs font-semibold uppercase tracking-[0.12em] text-accent-bright">
                <span className="w-1.5 h-1.5 rounded-pill bg-accent" />{service(status?.clock)} · live
              </span>
              {k ? (
                <div className="flex items-end gap-s7">
                  <Ticker n={k.preparing.length} label="in the oven" />
                  <Ticker n={k.ready.length} label="boxed, waiting" />
                  <Ticker n={k.on_road.length} label="on the road" />
                </div>
              ) : <span className="h-[72px]" />}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <span className="absolute left-s4 bottom-s3 text-2xs text-ink-faint pointer-events-none max-lg:hidden">Streets © OpenStreetMap contributors</span>
    </div>
  );
}

function Ticker({ n, label }: { n: number; label: string }) {
  return (
    <span className="flex flex-col items-end">
      <span className="font-display text-[64px] leading-none font-semibold text-ink-primary tabular-nums">{n}</span>
      <span className="text-sm text-ink-secondary mt-1">{label}</span>
    </span>
  );
}
