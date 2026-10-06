/* One complaint, start to finish: every hand it passed through, bot or person, and what is still waiting. */
import { motion, useReducedMotion } from 'framer-motion';
import { useApi } from '../lib/hooks';
import type { TimelineStep } from '../lib/types';
import { ENTER } from './ui';

const KIND: Record<TimelineStep['actor_kind'], { label: string; cls: string }> = {
  customer: { label: 'Customer', cls: 'text-ink-primary border-line-strong bg-surface-raised' },
  bot: { label: 'Bots · rules', cls: 'text-ink-emphasis border-line bg-surface-raised' },
  llm: { label: 'Bots · Claude', cls: 'text-ai border-ai-line bg-ai-fill' },
  code: { label: 'Code', cls: 'text-ink-emphasis border-line bg-surface-inset' },
  human: { label: 'Person', cls: 'text-warn-text border-warn bg-warn-fill' },
};

export function Journey({ contactId, tick, compact }: { contactId: string; tick: number; compact?: boolean }) {
  const { data } = useApi<{ steps: TimelineStep[] }>(`/api/cases/${contactId}/timeline`, tick);
  const reduce = useReducedMotion();
  if (!data) return null;
  return (
    <div className="overflow-x-auto -mx-s1 px-s1 pb-s1">
      <ol className="flex items-stretch min-w-max gap-0" aria-label="Every hand this case passed through">
        {data.steps.map((s, i) => {
          const k = KIND[s.actor_kind];
          const live = s.status === 'waiting';
          const last = i === data.steps.length - 1;
          return (
            <motion.li key={`${s.stage}-${i}`} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              transition={reduce ? { duration: 0 } : { delay: i * 0.04, duration: 0.3, ease: ENTER }}
              className={`relative flex flex-col gap-s2 ${compact ? 'w-[150px]' : 'w-[184px]'} pr-s4 ${s.status === 'pending' ? 'opacity-55' : ''}`}>
              {/* the rail: a dot per hand, joined to the next by a line that glows once the work has passed */}
              <span className="relative flex items-center h-5">
                <span className={`relative z-10 w-3.5 h-3.5 rounded-pill border-2 border-[var(--surface-solid)]
                                  ${s.status === 'done' ? 'bg-ok' : live ? 'bg-warn ' : 'bg-surface-hover'}`} />
                {live && !reduce && <span className="absolute left-0 w-3.5 h-3.5 rounded-pill bg-warn animate-ping opacity-60" />}
                {!last && (
                  <span className={`absolute left-4 right-1 h-[2px] rounded-pill
                                    ${s.status === 'done' ? 'bg-ok' : 'bg-[var(--hairline-strong)]'}`} />
                )}
              </span>
              <span className="text-sm font-semibold text-ink-primary truncate">{s.actor}</span>
              <span className={`self-start text-2xs font-semibold px-2 py-0.5 rounded-pill border ${k.cls}`}>{k.label}</span>
              <span className={`text-xs text-ink-secondary leading-snug ${compact ? 'line-clamp-2' : 'line-clamp-3'}`} title={s.detail}>{s.detail}</span>
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}
