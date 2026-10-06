/* Decisions with an undo window instead of a confirm dialog. A person's click queues the decision and shows a toast;
 * nothing is sent until the window closes, so Undo really undoes. The queue lives at the app root, so leaving the screen
 * mid-countdown still commits. Only one decision waits at a time: queuing a second commits the first straight away. */
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ENTER, Icon } from './ui';

export const UNDO_MS = 5000;

export interface Decision {
  /** What it is about (a contact or work order id). Screens hide the item while its decision waits. */
  id: string;
  /** "Approved $10.00 credit for Marcus" */
  label: string;
  commit: () => Promise<unknown>;
  /** Runs after a successful commit (refresh data). */
  after?: () => void;
}

export function useDecisionQueue() {
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const current = useRef<Decision | null>(null);

  const commit = useCallback(async (d: Decision) => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null; current.current = null; setPending(null);
    try {
      await d.commit();
      setLanded(d.label); window.setTimeout(() => setLanded((l) => (l === d.label ? null : l)), 2600);
      d.after?.();
    } catch (e) {
      setError(`${d.label} did not go through: ${(e as Error).message}`);
      window.setTimeout(() => setError(null), 6000);
    }
  }, []);

  const queue = useCallback((d: Decision) => {
    if (current.current) void commit(current.current);
    current.current = d; setPending(d); setLanded(null);
    timer.current = window.setTimeout(() => { if (current.current === d) void commit(d); }, UNDO_MS);
  }, [commit]);

  const undo = useCallback(() => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null; current.current = null; setPending(null);
  }, []);

  const now = useCallback(() => { if (current.current) void commit(current.current); }, [commit]);

  // Leaving the page mid-countdown: send it rather than lose the decision.
  useEffect(() => {
    const flush = () => { const d = current.current; if (d) { current.current = null; void d.commit(); } };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  return { pending, queue, undo, now, error, landed };
}

/** The undo toast, bottom centre. A thin bar runs down the window; Undo cancels, "Send now" skips the wait. */
export function DecisionToast({ pending, undo, now, error, landed }: ReturnType<typeof useDecisionQueue>) {
  const reduce = useReducedMotion();
  const show = pending ? 'pending' : error ? 'error' : landed ? 'landed' : null;
  return (
    <div className="fixed inset-x-0 bottom-s6 z-[90] flex justify-center pointer-events-none px-s4" aria-live="polite">
      <AnimatePresence mode="wait">
        {show && (
          <motion.div key={show === 'pending' ? `p-${pending!.id}` : show}
            initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: 8 }} transition={{ duration: 0.25, ease: ENTER }}
            className="toast pointer-events-auto relative overflow-hidden min-w-[340px] max-w-[560px] rounded-card bg-surface-solid border border-line-strong shadow-overlay">
            <div className="flex items-center gap-s3 pl-s4 pr-s2 py-s2">
              <span className={`grid place-items-center w-7 h-7 rounded-pill shrink-0 ${show === 'error' ? 'bg-crit-fill text-crit-text' : 'bg-ok-fill text-ok-text'}`}>
                <Icon name={show === 'error' ? 'x' : 'check'} size={14} />
              </span>
              <span className="flex-1 min-w-0 text-smd text-ink-primary leading-snug">
                {show === 'pending' ? pending!.label : show === 'error' ? error : `${landed}. Done.`}
              </span>
              {show === 'pending' && (
                <>
                  <button onClick={now} className="h-8 px-s3 rounded-ctl text-sm text-ink-secondary hover:text-ink-primary hover:bg-surface-hover transition-colors duration-fast ease-out">Send now</button>
                  <button onClick={undo} className="h-8 px-s3 rounded-ctl text-sm font-semibold text-accent-bright hover:bg-accent-fill transition-colors duration-fast ease-out">Undo</button>
                </>
              )}
            </div>
            {show === 'pending' && (
              /* the undo window, as a progress bar draining over its width */
              <motion.span aria-hidden className="absolute left-0 bottom-0 h-0.5 bg-accent" initial={{ width: '100%' }} animate={{ width: '0%' }}
                transition={{ duration: UNDO_MS / 1000, ease: 'linear' }} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
