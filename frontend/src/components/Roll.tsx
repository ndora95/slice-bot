/* A number that rolls to its new value like an odometer, digit by digit, when it changes. Anything that is not a digit
 * ($ , . % : h) stays put. Digits are keyed from the right, so "$9.50" rolling to "$10.25" keeps the cents in place.
 * It renders the value as text for screen readers and the rolling columns for everyone else. */
import { motion, useReducedMotion } from 'framer-motion';

const DIGITS = '0123456789';

export function Roll({ value, className = '' }: { value: string | number; className?: string }) {
  const reduce = useReducedMotion();
  const s = String(value);
  const chars = [...s];
  return (
    <span className={`inline-flex items-end tabular-nums leading-none ${className}`} aria-label={s} role="text">
      {chars.map((c, i) => {
        const key = chars.length - i;
        if (!DIGITS.includes(c)) return <span key={`s${key}`} aria-hidden className="inline-block whitespace-pre" style={{ height: '1em', lineHeight: 1 }}>{c}</span>;
        return (
          <span key={`d${key}`} aria-hidden className="relative inline-block overflow-hidden" style={{ height: '1em', lineHeight: 1 }}>
            <span className="invisible">0</span>
            <motion.span className="absolute left-0 top-0 flex flex-col" initial={false}
              animate={{ y: `${-Number(c)}em` }}
              transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 170, damping: 24, mass: 0.9 }}>
              {[...DIGITS].map((d) => <span key={d} style={{ height: '1em', lineHeight: 1 }}>{d}</span>)}
            </motion.span>
          </span>
        );
      })}
    </span>
  );
}
