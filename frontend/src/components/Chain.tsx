/* A case as a chain of hands: each node is a bot, a code check, or a person, and the connectors fill as the work moves
 * along. The node doing the work pulses, a packet travels the link into it, and a send-back runs the packet backwards. */
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { BOTS } from '../lib/format';
import { glyphIcon, ICONS } from './icons';
import { Icon } from './ui';

export type NodeState = 'pending' | 'active' | 'done' | 'skipped' | 'waiting' | 'ok';
export interface ChainNode {
  id: string; name: string; glyph?: string; icon?: string; status?: string; badge?: string;
  tone: 'customer' | 'bot' | 'ai' | 'code' | 'person'; state: NodeState;
}
export interface BackEdge { from: number; to: number; live: boolean; label: string }

const REACHED: NodeState[] = ['done', 'active', 'ok', 'waiting'];

function circleClass(n: ChainNode) {
  if (n.state === 'pending') return 'border-line bg-surface-inset text-ink-faint';
  if (n.state === 'skipped') return 'border-dashed border-line bg-transparent text-ink-faint';
  if (n.state === 'active') return 'border-accent bg-accent-fill text-accent-bright breathe';
  if (n.state === 'waiting') return 'border-warn bg-warn-fill text-warn-text';
  if (n.state === 'ok') return 'border-ok bg-ok-fill text-ok-text';
  return {
    customer: 'border-accent-line bg-accent-fill text-accent-bright',
    ai: 'border-ai-line bg-ai-fill text-ai',
    code: 'border-line-strong bg-surface-inset text-ink-emphasis',
    person: 'border-warn bg-warn-fill text-warn-text',
    bot: 'border-line-strong bg-surface-raised text-ink-primary',
  }[n.tone];
}

/** The picture on a node: its own icon if it has one, else the icon for its two-letter code. */
function NodeIcon({ n }: { n: ChainNode }) {
  const C = n.icon ? (ICONS[n.icon] ?? ICONS.dot) : glyphIcon(n.glyph ?? '');
  return <C size={22} strokeWidth={1.75} aria-hidden />;
}

export function Chain({ nodes, selected, onSelect, back }: {
  nodes: ChainNode[]; selected: string | null; onSelect: (id: string) => void; back?: BackEdge | null;
}) {
  const reduce = useReducedMotion();
  const active = nodes.findIndex((n) => n.state === 'active');
  // The packet runs from the last node that did something into the one working now, across any skipped bots.
  let from = active - 1;
  while (from > 0 && nodes[from].state === 'skipped') from--;
  const forwardLive = active > 0 && !(back?.live && back.to === active);
  // Nodes give up some width before the chain scrolls; on a narrow screen it scrolls sideways and keeps the step being shown in view.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[aria-current="step"]');
    const box = scroller.current;
    if (!el || !box || box.scrollWidth <= box.clientWidth) return;
    box.scrollTo({ left: el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2, behavior: reduce ? 'auto' : 'smooth' });
  }, [selected, reduce]);

  return (
    <div ref={scroller} className="relative overflow-x-auto -mx-s4 px-s4 pt-s4 pb-s1">
      <ol className="flex items-start min-w-[900px]" aria-label="Who handled this case, in order">
        {nodes.map((n, i) => {
          const sel = n.id === selected;
          const clickable = n.state !== 'pending' && n.state !== 'skipped';
          const next = nodes[i + 1];
          const filled = next ? nodes.slice(i + 1).some((x) => REACHED.includes(x.state)) : false;
          const packet = forwardLive && i >= from && i < active;
          const inBack = back && i >= back.to && i < back.from;
          return (
            <li key={n.id} className="contents">
              <button type="button" onClick={() => clickable && onSelect(n.id)} disabled={!clickable}
                title={BOTS[n.id]?.does} aria-current={sel ? 'step' : undefined}
                className={`group flex flex-col items-center gap-2 w-[96px] min-w-[76px] text-center rounded-card py-1
                            ${clickable ? 'cursor-pointer' : 'cursor-default'} ${n.state === 'skipped' ? 'opacity-50' : ''}`}>
                <span className={`relative grid place-items-center w-14 h-14 rounded-[18px] border
                                  transition-[background-color,border-color,color,box-shadow] duration-med ease-out ${circleClass(n)}
                                  ${sel ? 'ring-2 ring-accent-bright ring-offset-[3px] ring-offset-[var(--surface-panel)]' : clickable ? 'group-hover:border-line-hover group-hover:-translate-y-0.5' : ''}`}>
                  {(n.state === 'active' || n.state === 'waiting') && !reduce && (
                    <motion.span aria-hidden className={`absolute -inset-1 rounded-[22px] border-2 ${n.state === 'waiting' ? 'border-warn' : 'border-accent'}`}
                      initial={{ scale: 1, opacity: 0.7 }} animate={{ scale: 1.35, opacity: 0 }}
                      transition={{ repeat: Infinity, duration: 1.5, ease: 'easeOut' }} />
                  )}
                  <NodeIcon n={n} />
                  {(n.state === 'done' || n.state === 'ok') && (
                    <motion.span initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 26 }}
                      className="absolute -right-1.5 -bottom-1.5 grid place-items-center w-5 h-5 rounded-pill bg-ok text-[var(--accent-ink)] border-2 border-[var(--surface-panel)]">
                      <Icon name="check" size={11} />
                    </motion.span>
                  )}
                  {n.badge && (
                    <span className="absolute -right-3 -top-2 px-1.5 py-px rounded-pill bg-surface-panel border border-ai-line text-ai text-2xs font-semibold leading-tight whitespace-nowrap">
                      {n.badge}
                    </span>
                  )}
                </span>
                <span className={`text-sm font-semibold leading-tight ${sel ? 'text-accent-bright' : n.state === 'pending' || n.state === 'skipped' ? 'text-ink-secondary' : 'text-ink-primary'}`}>
                  {n.name}
                </span>
                <span className="text-xs text-ink-secondary leading-snug line-clamp-2 px-0.5 min-h-[2.6em]" title={n.status}>
                  {n.state === 'active' ? <span className="text-accent-bright">working…</span> : n.status}
                </span>
              </button>

              {next && (
                <span aria-hidden className="relative flex-1 min-w-[14px] h-14 mt-1 flex items-center">
                  <span className="absolute inset-x-1 h-[3px] rounded-pill bg-[var(--hairline-strong)]" />
                  {/* completed links fill basil; the link into the bot working now runs oven orange */}
                  <motion.span className={`absolute left-1 h-[3px] rounded-pill ${packet ? 'bg-accent' : 'bg-ok'}`}
                    initial={false} animate={{ width: filled ? 'calc(100% - 8px)' : '0%' }}
                    transition={reduce ? { duration: 0 } : { duration: 0.5, ease: 'easeOut' }} />
                  {/* the case file itself, carried along the link to the bot that has it now */}
                  {packet && !reduce && (
                    <motion.span className="absolute -ml-[11px] grid place-items-center w-[22px] h-[16px] rounded-[4px] bg-accent text-[var(--accent-ink)]"
                      initial={{ left: '0%', opacity: 0 }} animate={{ left: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
                      transition={{ repeat: Infinity, duration: 1.3, ease: [0.4, 0, 0.2, 1], times: [0, 0.15, 0.85, 1] }}>
                      <Icon name="doc" size={10} />
                    </motion.span>
                  )}
                  {inBack && (
                    <>
                      <span className="absolute inset-x-0 top-0 h-4 border-t-2 border-dashed border-ai-line rounded-t-[18px]" />
                      {back.live && !reduce && (
                        <motion.span className="absolute -top-[5px] w-2.5 h-2.5 -ml-[5px] rounded-pill bg-ai"
                          initial={{ left: '100%' }} animate={{ left: '0%' }}
                          transition={{ repeat: Infinity, duration: 1.1, ease: 'easeInOut' }} />
                      )}
                      {i === back.to && (
                        <span className="absolute left-1/2 -translate-x-1/2 -top-3 px-2 py-px rounded-pill bg-surface-panel border border-ai-line text-ai text-2xs font-semibold whitespace-nowrap">
                          {back.label}
                        </span>
                      )}
                    </>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
