/* Every icon in the console comes from Lucide. Screens keep asking for icons by the short names they always used
 * ('check', 'arrow', 'db'…), and every bot, person, and check keeps its two-letter code (DS, OR, GT…); both resolve
 * here, so a code that used to be drawn as letters now shows a picture of its job. */
import {
  ArrowRight, BatteryMedium, Bot, CalendarClock, Check, CheckCheck, ChevronDown, ChartLine, Circle, ClipboardCheck,
  Clock, Database, FileText, Gauge, Headset, Layers, LibraryBig, LogOut, Map, Minus, Navigation, Package, PenLine,
  Pizza, Play, Plug, Radio, Receipt, RotateCcw, SendHorizontal, ShieldCheck, SlidersHorizontal, Crosshair, ChevronsRight,
  Stethoscope, Truck, User, Wrench, X, Zap, type LucideIcon,
} from 'lucide-react';

export const ICONS: Record<string, LucideIcon> = {
  dot: Circle, check: Check, x: X, play: Play, reset: RotateCcw, arrow: ArrowRight, db: Database, doc: FileText,
  bolt: Zap, wrench: Wrench, clock: Clock, send: SendHorizontal, person: User, forward: ChevronsRight, layers: Layers,
  logout: LogOut, chevron: ChevronDown, sliders: SlidersHorizontal, map: Map, target: Crosshair, minus: Minus, plug: Plug,
  battery: BatteryMedium,
};

/** Bots, the gate, and the people, by the two-letter code each one has always carried. */
export const GLYPH_ICONS: Record<string, LucideIcon> = {
  // service crew
  DS: Radio, OR: Receipt, FL: Truck, MN: Pizza, LB: LibraryBig, RS: PenLine, CK: ShieldCheck,
  // the gate and a sent reply
  GT: Gauge, OK: CheckCheck,
  // repair crew
  DX: Stethoscope, PT: Package, RN: Navigation, SC: CalendarClock,
  // people
  MC: User, DK: Headset, RA: ChartLine, IW: ClipboardCheck, LF: Wrench,
};

/** Any other code is a customer's initials: draw a person. */
export function glyphIcon(code: string): LucideIcon {
  return GLYPH_ICONS[code] ?? (code === 'BT' ? Bot : User);
}
