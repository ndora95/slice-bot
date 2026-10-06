/* The pizza, as a working part of the UI rather than decoration. It is always eight slices:
 *   PizzaMark     the copilot's mark. Each case waiting on this person pulls one slice out of the pie.
 *   PizzaProgress the crew working the inbox: one slice per contact, filled as each one is worked.
 * Colors come from the --pizza-* tokens. */
import { motion, useReducedMotion } from 'framer-motion';

const N = 8;
const C = 16;

/** One wedge from angle a0 to a1 (radians, 0 = up, clockwise), radius r, around the centre. */
function wedge(a0: number, a1: number, r: number) {
  const p = (a: number) => `${C + r * Math.sin(a)},${C - r * Math.cos(a)}`;
  return `M${C},${C} L${p(a0)} A${r},${r} 0 0 1 ${p(a1)} Z`;
}

const SLICES = Array.from({ length: N }, (_, i) => {
  const a0 = (i / N) * Math.PI * 2 + 0.02, a1 = ((i + 1) / N) * Math.PI * 2 - 0.02, mid = (a0 + a1) / 2;
  return {
    crust: wedge(a0, a1, 13), cheese: wedge(a0 + 0.03, a1 - 0.03, 10.6),
    // one pepperoni per slice, two-thirds of the way out
    pep: [C + 7 * Math.sin(mid), C - 7 * Math.cos(mid)] as const,
    dir: [Math.sin(mid), -Math.cos(mid)] as const,
  };
});

/** The copilot's pizza. `out` slices are pulled out of the pie: one per thing waiting on you (0 = whole). */
export function PizzaMark({ size = 32, out = 0 }: { size?: number; out?: number }) {
  const reduce = useReducedMotion();
  const pulled = Math.min(N, Math.max(0, out));
  return (
    <svg width={size} height={size} viewBox="-3 -3 38 38" fill="none" aria-hidden>
      {SLICES.map((s, i) => {
        const away = i < pulled ? 2.8 : 0;
        return (
          <motion.g key={i} initial={false} animate={{ x: s.dir[0] * away, y: s.dir[1] * away }}
            transition={reduce ? { duration: 0 } : { duration: 0.3, ease: [0.22, 1, 0.36, 1], delay: i * 0.03 }}>
            <path d={s.crust} fill="var(--pizza-crust)" />
            <path d={s.cheese} fill="var(--pizza-cheese)" />
            <circle cx={s.pep[0]} cy={s.pep[1]} r="1.6" fill="var(--pizza-pepperoni)" />
          </motion.g>
        );
      })}
    </svg>
  );
}

/** The crew working the inbox: one slice per contact (scaled to eight), baked slices fill in with cheese. */
export function PizzaProgress({ done, total, size = 22 }: { done: number; total: number; size?: number }) {
  const reduce = useReducedMotion();
  const filled = total ? Math.round((Math.min(done, total) / total) * N) : 0;
  return (
    <svg width={size} height={size} viewBox="-1 -1 34 34" fill="none" role="img" aria-label={`${done} of ${total} worked`}>
      {SLICES.map((s, i) => {
        const baked = i < filled, next = i === filled;
        return (
          <g key={i}>
            <path d={s.crust} fill={baked ? 'var(--pizza-crust)' : 'var(--surface-raised)'} stroke="var(--hairline-strong)" strokeWidth={baked ? 0 : 0.6} />
            {baked && (
              <motion.g initial={reduce ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
                style={{ transformOrigin: '16px 16px' }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
                <path d={s.cheese} fill="var(--pizza-cheese)" />
                <circle cx={s.pep[0]} cy={s.pep[1]} r="1.6" fill="var(--pizza-pepperoni)" />
              </motion.g>
            )}
            {next && !reduce && (
              <motion.path d={s.cheese} fill="var(--pizza-cheese)" initial={{ opacity: 0.1 }} animate={{ opacity: [0.1, 0.45, 0.1] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }} />
            )}
          </g>
        );
      })}
    </svg>
  );
}
