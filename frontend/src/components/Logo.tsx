/** SliceBot mark: a slice with a sensor mast and two eyes, cut out of an oven-orange tile. Reads at 20px and at 40px. */
export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <span className="grid place-items-center shrink-0 rounded-chip bg-accent-grad shadow-glow-accent"
      style={{ width: size, height: size }}>
      <svg width={size * 0.72} height={size * 0.72} viewBox="0 0 32 32" fill="none" aria-hidden>
        <path d="M16 7.2V3.6" stroke="var(--accent-ink)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="16" cy="2.9" r="1.6" fill="var(--accent-ink)" />
        <path d="M4.6 10.4Q16 4.4 27.4 10.4L16 28.2Z" fill="var(--accent-ink)" fillOpacity="0.14" stroke="var(--accent-ink)"
          strokeWidth="2" strokeLinejoin="round" />
        <path d="M7.2 13.2Q16 8.8 24.8 13.2" stroke="var(--accent-ink)" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12.7" cy="16.4" r="1.9" fill="var(--accent-ink)" />
        <circle cx="19.3" cy="16.4" r="1.9" fill="var(--accent-ink)" />
      </svg>
    </span>
  );
}

export function Wordmark({ sub, size = 22 }: { sub?: string; size?: number }) {
  return (
    <span className="flex flex-col gap-1 min-w-0">
      <span className="font-display leading-none font-bold text-ink-primary" style={{ fontSize: size }}>
        Slice<span className="text-accent-bright">Bot</span>
      </span>
      {sub && <span className="text-xs text-ink-secondary truncate">{sub}</span>}
    </span>
  );
}

export { PizzaMark } from './Pizza';
