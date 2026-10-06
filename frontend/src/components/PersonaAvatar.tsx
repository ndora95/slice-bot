/* Each of the five seats has an avatar that says what the person does: a customer, a headset for care, a chart for
 * the head of care, a clipboard for the repair lead, a wrench for the mechanic. One style for all five: a line glyph on
 * a warm matte tile. Active, the tile takes the oven orange. Pass layoutId to let it fly between screens. */
import { motion } from 'framer-motion';
import { ChartLine, ClipboardCheck, Headset, User, Wrench, type LucideIcon } from 'lucide-react';
import type { Role } from '../lib/types';

const ICON: Record<Role, LucideIcon> = {
  customer: User, specialist: Headset, head: ChartLine, repair_lead: ClipboardCheck, mechanic: Wrench,
};

export function PersonaAvatar({ role, size = 40, active, layoutId }: { role: Role; size?: number; active?: boolean; layoutId?: string }) {
  const I = ICON[role];
  return (
    <motion.span aria-hidden layoutId={layoutId} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      className={`relative grid place-items-center shrink-0 border transition-[background-color,border-color,color] duration-med ease-out
                  ${active ? 'bg-accent text-[var(--accent-ink)] border-transparent' : 'bg-surface-raised text-ink-emphasis border-line-strong'}`}>
      <I size={Math.round(size * 0.46)} strokeWidth={1.8} className="relative" />
    </motion.span>
  );
}
