/* The console's component kit: frosted slate cards, soft pill badges, Lucide icons, and one sans face throughout. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Braces, ChevronDown, Copy, Check as CheckIcon, Inbox, ListChecks, LoaderCircle, Sparkles, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { glyphIcon, ICONS } from './icons';
import { Roll } from './Roll';

export const ENTER = [0.22, 1, 0.36, 1] as const;

type Dot = 'crit' | 'warn' | 'ok' | 'info' | 'ai' | 'accent';
const DOTS: Record<Dot, string> = {
  crit: 'bg-crit', warn: 'bg-warn', ok: 'bg-ok', info: 'bg-info', ai: 'bg-ai', accent: 'bg-accent',
};

export function Kicker({ children, dot }: { children: ReactNode; dot?: Dot }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink-primary tracking-[-0.005em]">
      {dot && <span className={`w-1.5 h-1.5 rounded-pill ${DOTS[dot]}`} />}
      {children}
    </span>
  );
}

export function Panel({ kicker, dot, action, delay = 0, className = '', bodyClass = '', children }: {
  kicker?: ReactNode; dot?: Dot; action?: ReactNode; delay?: number;
  className?: string; bodyClass?: string; children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { delay, duration: 0.4, ease: ENTER }}
      className={`surface-card rounded-panel p-s5 max-md:p-s4 flex flex-col gap-s4 min-h-0 ${className}`}
    >
      {(kicker || action) && (
        <header className="flex items-center justify-between gap-s3 shrink-0">
          {kicker ? <Kicker dot={dot}>{kicker}</Kicker> : <span />}
          {action}
        </header>
      )}
      <div className={`min-h-0 ${bodyClass}`}>{children}</div>
    </motion.section>
  );
}

/** A card that folds away. The header always shows what is inside (title, a count or verdict), so a closed stack
 *  still reads as a summary of the case. */
export function Accordion({ title, icon: IconC, meta, dot, defaultOpen = true, delay = 0, highlight, children }: {
  title: ReactNode; icon?: LucideIcon; meta?: ReactNode; dot?: Dot; defaultOpen?: boolean; delay?: number;
  highlight?: boolean; children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { delay, duration: 0.35, ease: ENTER }}
      className={`surface-card rounded-panel overflow-hidden ${highlight ? 'ring-1 ring-accent-line' : ''}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex items-center gap-s3 px-s5 max-md:px-s4 py-s4 text-left hover:bg-surface-raised transition-colors duration-fast ease-out">
        {IconC && (
          <span className="grid place-items-center w-8 h-8 rounded-chip bg-surface-raised border border-line text-ink-emphasis shrink-0">
            <IconC size={16} strokeWidth={1.75} />
          </span>
        )}
        <span className="flex-1 min-w-0 flex items-center gap-s2 flex-wrap">
          {dot && <span className={`w-1.5 h-1.5 rounded-pill ${DOTS[dot]}`} />}
          <span className="text-md font-semibold text-ink-primary">{title}</span>
        </span>
        {meta && <span className="text-sm text-ink-secondary tabular-nums text-right max-md:hidden">{meta}</span>}
        <ChevronDown size={18} className={`shrink-0 text-ink-secondary transition-transform duration-med ease-out ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="body" initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: ENTER }}>
            <div className="px-s5 max-md:px-s4 pb-s5 pt-s1 border-t border-line">
              <div className="pt-s4">{children}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

export function StatRail({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`surface-card grid grid-flow-col auto-cols-fr rounded-panel overflow-hidden
                     max-lg:grid-flow-row max-lg:grid-cols-2 ${className}`}>
      {children}
    </div>
  );
}

/** A KPI tile. With a `target`, the bar carries a tick at the target and takes its color from how close it is:
 *  basil when met, cheese when within reach, tomato when far off. `lowerIsBetter` flips the comparison. */
export function StatTile({ value, label, sub, pct, index = 0, tone, target, lowerIsBetter }: {
  value: ReactNode; label: string; sub?: ReactNode; pct?: number; index?: number; tone?: 'crit' | 'warn' | 'ok';
  target?: number; lowerIsBetter?: boolean;
}) {
  const reduce = useReducedMotion();
  const delay = Math.min(index, 7) * 0.06;
  const met = target == null || pct == null ? null : lowerIsBetter ? pct <= target : pct >= target;
  const near = target != null && pct != null && !met && Math.abs(pct - target) <= 0.1;
  const status = tone ?? (met == null ? undefined : met ? 'ok' : near ? 'warn' : 'crit');
  const bar = status === 'crit' ? 'bg-crit' : status === 'warn' ? 'bg-warn' : status === 'ok' ? 'bg-ok' : 'bg-info';
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { delay, duration: 0.35, ease: ENTER }}
      className="px-s5 py-s4 flex flex-col gap-s2 border-l border-line first:border-l-0 max-lg:border-l-0 max-lg:border-t
                 max-lg:[&:nth-child(-n+2)]:border-t-0 max-lg:[&:nth-child(even)]:border-l"
    >
      <span className="font-display text-metric font-semibold text-ink-primary leading-none">
        {typeof value === 'string' || typeof value === 'number' ? <Roll value={value} /> : value}
      </span>
      <span className="text-sm font-medium text-ink-emphasis leading-tight">{label}</span>
      {sub && <span className="text-sm text-ink-secondary leading-snug">{sub}</span>}
      {pct !== undefined && (
        <div className="relative mt-s1">
          <div className="h-1.5 rounded-pill bg-surface-inset overflow-hidden">
            <motion.div
              className={`h-full rounded-pill ${bar}`}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }}
              transition={reduce ? { duration: 0 } : { delay: delay + 0.12, duration: 0.7, ease: ENTER }}
            />
          </div>
          {target != null && (
            <span title={`target ${Math.round(target * 100)}%`} className="absolute -top-1 -bottom-1 w-0.5 rounded-pill bg-ink-primary"
              style={{ left: `calc(${Math.min(100, target * 100)}% - 1px)` }} />
          )}
        </div>
      )}
      {target != null && pct != null && (
        <span className={`text-xs tabular-nums ${status === 'ok' ? 'text-ok-text' : status === 'warn' ? 'text-warn-text' : 'text-crit-text'}`}>
          {met ? 'meets' : 'short of'} {Math.round(target * 100)}% target
        </span>
      )}
    </motion.div>
  );
}

const RING = 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_22%,transparent)]';

/** Soft, color-coded status badge. */
export function Pill({ kind, children }: { kind: 'crit' | 'warn' | 'ok' | 'info' | 'ai' | 'muted' | 'accent'; children: ReactNode }) {
  const map = {
    crit: 'text-crit-text bg-crit-fill', warn: 'text-warn-text bg-warn-fill', ok: 'text-ok-text bg-ok-fill',
    info: 'text-info-text bg-info-fill', ai: 'text-ai bg-ai-fill', muted: 'text-ink-secondary bg-surface-raised',
    accent: 'text-accent-bright bg-accent-fill',
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] leading-none
                      px-2.5 py-1.5 rounded-pill whitespace-nowrap ${RING} ${map[kind]}`}>
      <span className="w-1.5 h-1.5 rounded-pill bg-current" />
      {children}
    </span>
  );
}

/** Who did a step: Claude, the rules brain standing in for Claude offline, or code that is code on every engine. */
export function EngineMark({ kind }: { kind: 'ai' | 'rules' | 'code' | string }) {
  const base = `inline-flex items-center gap-1 text-2xs font-semibold leading-none px-2 py-1 rounded-pill ${RING}`;
  return kind === 'ai'
    ? <span className={`${base} text-ai bg-ai-fill`}><Sparkles size={11} />Claude</span>
    : kind === 'code'
    ? <span className={`${base} text-ink-emphasis bg-surface-inset`}><Braces size={11} />Code</span>
    : <span className={`${base} text-ink-secondary bg-surface-raised`}><ListChecks size={11} />Rules</span>;
}

export function Button({ children, onClick, variant = 'quiet', disabled, title, type = 'button', size = 'md' }: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'success' | 'quiet' | 'ghost'; disabled?: boolean; title?: string;
  type?: 'button' | 'submit'; size?: 'md' | 'lg';
}) {
  const v = {
    primary: 'bg-accent-grad text-[var(--accent-ink)] border-transparent font-semibold shadow-glow-accent hover:brightness-110 active:translate-y-px',
    success: 'bg-ok text-[var(--accent-ink)] border-transparent font-semibold shadow-glow-ok hover:brightness-110 active:translate-y-px',
    quiet: 'bg-surface-raised text-ink-emphasis border-line-strong hover:bg-surface-hover hover:text-ink-primary hover:border-line-hover',
    ghost: 'bg-transparent text-ink-secondary border-transparent hover:text-ink-primary hover:bg-surface-hover',
  }[variant];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 ${size === 'lg' ? 'h-11 px-s5 text-md' : 'h-9 px-s4 text-smd'}
                  rounded-ctl border font-medium whitespace-nowrap
                  transition-[background-color,border-color,color,transform,filter] duration-fast ease-out
                  disabled:opacity-40 disabled:pointer-events-none ${v}`}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ options, value, onChange, id, size = 'md' }: {
  options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; id: string; size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" className="inline-flex flex-wrap p-1 rounded-pill bg-surface-inset border border-line">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} role="tab" aria-selected={on} onClick={() => onChange(o.id)}
            className={`relative ${size === 'sm' ? 'h-7 px-3 text-sm' : 'h-8 px-4 text-smd'} rounded-pill font-medium
                        transition-colors duration-fast ease-out ${on ? 'text-ink-primary' : 'text-ink-secondary hover:text-ink-primary'}`}>
            {on && (
              <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-pill bg-surface-hover border border-line-strong shadow-card"
                transition={{ type: 'spring', stiffness: 400, damping: 35 }} />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-secondary">
      <LoaderCircle size={15} className="spin" aria-hidden />
      {label}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-surface-raised rounded-card animate-[skeleton_1s_var(--ease-in-out)_infinite_alternate] ${className}`} />;
}

export function Empty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-s3 py-s8 text-center">
      <div className="grid place-items-center w-12 h-12 rounded-card bg-surface-raised border border-line text-ink-secondary">
        <Inbox size={20} strokeWidth={1.75} />
      </div>
      <div className="text-md text-ink-primary">{title}</div>
      {detail && <div className="text-sm text-ink-secondary max-w-[42ch]">{detail}</div>}
      {action}
    </div>
  );
}

/** An avatar for a bot, a check, or a person: the picture of its job, keyed by its two-letter code. */
export function Glyph({ text, tone = 'neutral', size = 36 }: { text: string; tone?: 'neutral' | 'ai' | 'accent'; size?: number }) {
  const t = tone === 'ai' ? 'text-ai bg-ai-fill border-ai-line' : tone === 'accent' ? 'text-accent-bright bg-accent-fill border-accent-line'
    : 'text-ink-emphasis bg-surface-raised border-line-strong';
  const G = glyphIcon(text);
  return (
    <span title={text} className={`grid place-items-center shrink-0 rounded-chip border shadow-card ${t}`} style={{ width: size, height: size }}>
      <G size={Math.round(size * 0.46)} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

export function Icon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  const C = ICONS[name] ?? ICONS.dot;
  return <C size={size} strokeWidth={1.9} aria-hidden className={className} fill={name === 'play' ? 'currentColor' : 'none'} />;
}

export function KV({ k, v, mono = true }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-s3 py-2.5 border-t border-line first:border-t-0">
      <span className="text-sm text-ink-secondary">{k}</span>
      <span className={`text-smd font-medium text-ink-primary text-right ${mono ? 'tabular-nums' : ''}`}>{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------- code

const JSON_TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],])/g;

function highlightJson(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of src.matchAll(JSON_TOKEN)) {
    const t = m[0], i = m.index ?? 0;
    if (i > last) out.push(src.slice(last, i));
    const cls = t.startsWith('"') ? (t.trimEnd().endsWith(':') ? 'tok-key' : 'tok-str')
      : /^(true|false|null)$/.test(t) ? 'tok-lit' : /^[{}[\],]$/.test(t) ? 'tok-punc' : 'tok-num';
    out.push(<span key={k++} className={cls}>{t}</span>);
    last = i + t.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** Raw technical evidence (a bot's JSON, a warehouse record) in a code block with a label and a copy button. */
export function CodeBlock({ code, label = 'JSON', json = true, maxH = 'max-h-72' }: { code: string; label?: string; json?: boolean; maxH?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => undefined);
  };
  return (
    <div className="code-block overflow-hidden">
      <div className="flex items-center justify-between px-s3 py-1.5 border-b border-line bg-surface-raised">
        <span className="flex items-center gap-1.5 text-2xs font-sans font-semibold text-ink-secondary"><Braces size={12} />{label}</span>
        <button type="button" onClick={copy} className="flex items-center gap-1 text-2xs font-sans text-ink-secondary hover:text-ink-primary transition-colors duration-fast">
          {copied ? <CheckIcon size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`${maxH} overflow-auto px-s3 py-s2 whitespace-pre-wrap break-words`}>{json ? highlightJson(code) : code}</pre>
    </div>
  );
}
