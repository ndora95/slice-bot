/* The SliceBot robot, drawn in vector so it can act. On the sign-in it is a character: its eyes follow the pointer and the
 * seat you hover, it blinks now and then, it beams when you pick a seat, and for the customer it pops its lid and lets the
 * steam out. On the order tracker it rides the track carrying the box. Colors are the --bot-* and --box-* tokens.
 *
 * Illustration slots: to swap in a rendered image, put it in src/assets/illustrations/ and import it into ART below.
 * The slot keeps its size, so swapping the art never moves the layout. */
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useId, useState } from 'react';

export type Slot = 'vehicle' | 'courier';
const ART: Partial<Record<Slot, string>> = {};

export type Mood = 'idle' | 'happy';

/** The sign-in hero: the robot on a lit stage. `look` is where it looks, -1..1 on each axis. */
export function HeroVehicle({ className = '', look = { x: 0, y: 0 }, mood = 'idle', lid = false }: {
  className?: string; look?: { x: number; y: number }; mood?: Mood; lid?: boolean;
}) {
  const reduce = useReducedMotion();
  const art = ART.vehicle;
  return (
    <div className={`relative h-[168px] overflow-hidden ${className}`} data-illustration-slot="vehicle">
      {/* the stage: a floor ring under the robot so it sits in space */}
      <div aria-hidden className="absolute left-1/2 bottom-[18px] -translate-x-1/2 w-[250px] h-[38px] rounded-[50%] border border-accent-line opacity-60" />
      <div aria-hidden className="absolute left-1/2 bottom-[8px] -translate-x-1/2 w-[340px] h-[56px] rounded-[50%] border border-line-strong opacity-70" />
      <motion.div className="absolute inset-0 grid place-items-center"
        animate={reduce ? undefined : { y: mood === 'happy' ? [0, -9, 0] : [0, -4, 0] }}
        transition={mood === 'happy' ? { duration: 0.5, ease: [0.22, 1, 0.36, 1] } : { duration: 4, repeat: Infinity, ease: 'easeInOut' }}>
        {art ? <img src={art} alt="SliceBot delivery vehicle" className="h-[150px] w-auto object-contain" />
          : <RobotSvg width={220} look={look} mood={mood} lid={lid} />}
      </motion.div>
    </div>
  );
}

/** The little robot carrying a pizza that rides the delivery track. */
export function CourierBot({ size = 64, late }: { size?: number; late?: boolean }) {
  const art = ART.courier;
  return art
    ? <img src={art} alt="" style={{ width: size }} className="h-auto object-contain" data-illustration-slot="courier" />
    : <span data-illustration-slot="courier" className="block"><RobotSvg width={size} pizza late={late} /></span>;
}

const stop = (offset: string, token: string) => <stop offset={offset} style={{ stopColor: `var(${token})` }} />;

/** A six-wheeled sidewalk robot with a face screen, an orange lid, and a safety flag. */
function RobotSvg({ width, pizza, late, look = { x: 0, y: 0 }, mood = 'idle', lid = false }: {
  width: number; pizza?: boolean; late?: boolean; look?: { x: number; y: number }; mood?: Mood; lid?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  const g = (n: string) => `url(#${n}-${id})`;
  const eye = late ? 'var(--bot-eye-late)' : 'var(--bot-eye)';
  const [blink, setBlink] = useState(false);
  // Blink every few seconds, at a slightly different interval each time, so it reads as alive rather than looped.
  useEffect(() => {
    if (reduce || pizza) return;
    let t: number;
    const next = () => { t = window.setTimeout(() => { setBlink(true); window.setTimeout(() => setBlink(false), 140); next(); }, 2600 + Math.random() * 2600); };
    next();
    return () => clearTimeout(t);
  }, [reduce, pizza]);
  const lx = Math.max(-1, Math.min(1, look.x)) * 6, ly = Math.max(-1, Math.min(1, look.y)) * 3.5;
  const happy = mood === 'happy' || !!pizza;
  const spring = reduce ? { duration: 0 } : { type: 'spring' as const, stiffness: 220, damping: 22 };
  return (
    <svg width={width} viewBox="0 0 240 170" fill="none" role="img" aria-label="SliceBot delivery robot" overflow="visible">
      <defs>
        <linearGradient id={`body-${id}`} x1="0" y1="0" x2="0" y2="1">{stop('0', '--bot-body-hi')}{stop('0.55', '--bot-body-mid')}{stop('1', '--bot-body-lo')}</linearGradient>
        <linearGradient id={`side-${id}`} x1="0" y1="0" x2="1" y2="0">{stop('0', '--bot-side-hi')}{stop('1', '--bot-side-lo')}</linearGradient>
        <linearGradient id={`lid-${id}`} x1="0" y1="0" x2="1" y2="1">{stop('0', '--bot-lid-hi')}{stop('0.5', '--bot-lid-mid')}{stop('1', '--bot-lid-lo')}</linearGradient>
        <linearGradient id={`screen-${id}`} x1="0" y1="0" x2="0" y2="1">{stop('0', '--bot-screen-hi')}{stop('1', '--bot-screen-lo')}</linearGradient>
        <radialGradient id={`tire-${id}`} cx="0.4" cy="0.35" r="0.7">{stop('0', '--bot-tire-hi')}{stop('1', '--bot-tire-lo')}</radialGradient>
        <linearGradient id={`box-${id}`} x1="0" y1="0" x2="0" y2="1">{stop('0', '--box-hi')}{stop('1', '--box-lo')}</linearGradient>
        <filter id={`soft-${id}`} x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5" /></filter>
        <filter id={`glow-${id}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" /></filter>
        <clipPath id={`screenclip-${id}`}><rect x="70" y="78" width="92" height="40" rx="15" /></clipPath>
      </defs>
      {/* ground shadow */}
      <ellipse cx="122" cy="150" rx="86" ry="11" fill="var(--bot-shadow)" opacity="0.5" filter={g('soft')} />
      {/* antenna and flag */}
      <path d="M176 52 L184 12" stroke="var(--bot-mast)" strokeWidth="3" strokeLinecap="round" />
      <path d="M184 12 C196 14 204 10 214 16 C204 20 198 24 186 24 Z" fill={g('lid')} className={reduce ? '' : 'flag-flutter'} />
      <circle cx="184" cy="11" r="3.2" fill="var(--bot-light)" />
      {/* side face, for depth */}
      <path d="M190 64 L206 74 L206 124 L190 132 Z" fill={g('side')} />
      {/* body */}
      <rect x="38" y="62" width="154" height="72" rx="22" fill={g('body')} />
      <rect x="44" y="66" width="142" height="26" rx="13" fill="var(--bot-shine)" opacity="0.45" />
      {/* steam, when the lid is up */}
      {lid && !reduce && (
        <g>
          {[112, 132, 152].map((x) => (
            <path key={x} className="steam" d={`M${x} 52 C${x - 6} 42 ${x + 6} 34 ${x} 22`} stroke="var(--steam)" strokeWidth="3.2" strokeLinecap="round" opacity="0" />
          ))}
        </g>
      )}
      {/* lid, hinged at the back so it lifts toward the flag */}
      <g style={{ transform: lid ? 'rotate(-14deg)' : 'none', transformOrigin: '46px 64px', transformBox: 'view-box',
                  transition: reduce ? 'none' : 'transform 420ms var(--ease-enter)' }}>
        <path d="M46 64 Q46 46 64 46 L176 46 Q194 46 196 62 L204 72 Q186 66 160 64 Z" fill={g('lid')} />
        <rect x="44" y="56" width="152" height="12" rx="6" fill={g('lid')} />
        <rect x="60" y="50" width="96" height="4" rx="2" fill="var(--bot-shine)" opacity="0.4" />
      </g>
      {/* face screen */}
      <rect x="70" y="78" width="92" height="40" rx="15" fill={g('screen')} stroke="var(--bot-screen-edge)" strokeWidth="1.5" />
      <g clipPath={`url(#screenclip-${id})`}>
        {/* open eyes: rounded pupils that look where you point, and blink */}
        <motion.g animate={{ x: lx, y: ly, opacity: happy ? 0 : 1 }} transition={spring}>
          {[99, 133].map((cx) => (
            <g key={cx} style={{ transform: blink ? 'scaleY(0.12)' : 'none', transformOrigin: `${cx}px 98px`, transformBox: 'view-box', transition: 'transform 80ms var(--ease-out)' }}>
              <rect x={cx - 7} y="89" width="14" height="18" rx="7" fill={eye} filter={g('glow')} opacity="0.85" />
              <rect x={cx - 5} y="91" width="10" height="14" rx="5" fill="var(--bot-eye-core)" />
            </g>
          ))}
        </motion.g>
        {/* happy eyes: two arcs and a smile */}
        <motion.g initial={false} animate={{ opacity: happy ? 1 : 0, y: happy ? 0 : 3 }} transition={reduce ? { duration: 0 } : { duration: 0.2 }}>
          <g filter={g('glow')} opacity="0.9">
            <path d="M92 101 Q99 91 106 101" stroke={eye} strokeWidth="5" strokeLinecap="round" />
            <path d="M126 101 Q133 91 140 101" stroke={eye} strokeWidth="5" strokeLinecap="round" />
          </g>
          <path d="M92 101 Q99 91 106 101" stroke="var(--bot-eye-core)" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M126 101 Q133 91 140 101" stroke="var(--bot-eye-core)" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M108 108 Q116 113 124 108" stroke={eye} strokeWidth="2.4" strokeLinecap="round" opacity="0.85" />
        </motion.g>
      </g>
      {/* headlights */}
      <circle cx="54" cy="104" r="5" fill="var(--bot-light)" /><circle cx="54" cy="104" r="9" fill="var(--bot-light)" opacity="0.25" filter={g('glow')} />
      <circle cx="178" cy="104" r="5" fill="var(--bot-light)" /><circle cx="178" cy="104" r="9" fill="var(--bot-light)" opacity="0.25" filter={g('glow')} />
      {/* slice decal */}
      <path d="M176 82 L190 82 L183 96 Z" fill="var(--bot-lid-mid)" opacity="0.9" />
      {/* wheels */}
      {[62, 116, 170].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="138" r="15" fill={g('tire')} stroke="var(--bot-tire-edge)" strokeWidth="2" />
          <circle cx={cx} cy="138" r="6" fill="var(--bot-hub)" /><circle cx={cx - 1.5} cy="136.5" r="2" fill="var(--bot-hub-shine)" />
        </g>
      ))}
      {/* the pizza it carries, on the courier */}
      {pizza && (
        <g>
          <rect x="78" y="30" width="80" height="18" rx="5" fill={g('box')} stroke="var(--box-edge)" strokeWidth="1.2" />
          <rect x="82" y="32" width="72" height="4" rx="2" fill="var(--bot-shine)" opacity="0.4" />
          <circle cx="118" cy="39" r="5" fill="var(--pizza-pepperoni)" />
        </g>
      )}
    </svg>
  );
}
