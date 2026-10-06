export const hhmm = (iso?: string | null) => (iso ? iso.slice(11, 16) : '—');
export const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
export const usd = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const human = (s: string) => s.replace(/_/g, ' ');
export const sentence = (s: string) => { const h = human(s); return h.charAt(0).toUpperCase() + h.slice(1); };

/** Hours since midnight from an ISO timestamp. */
export const hoursOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
};

/** `does` is the plain-language summary shown on each bot: its job, what it can use, and who does the work. */
export const BOTS: Record<string, { name: string; glyph: string; role: string; does: string }> = {
  dispatcher: { name: 'Dispatcher', glyph: 'DS', role: 'Reads the message, routes the crew',
    does: 'Reads the customer\'s message and decides what it is about, which bots are needed, and any red flags like a legal threat or a safety incident. Claude, with no tools: it only reads.' },
  orders: { name: 'Orders', glyph: 'OR', role: 'Orders, payments, tickets',
    does: 'Looks up the customer\'s account, orders, payments, credits, and tickets. Claude decides which of its 7 read-only lookups to run; each lookup only sees this customer\'s data.' },
  fleet: { name: 'Fleet', glyph: 'FL', role: 'Robot telemetry',
    does: 'Checks the robot that carried the order: faults, the warming box record, a backup robot, and whether other robots show the same problem. Claude decides which of its 4 lookups to run.' },
  menu: { name: 'Menu', glyph: 'MN', role: 'Builds an order that meets every need',
    does: 'Turns "what should we order?" into searches and needs (party size, budget, diets, allergies). Claude reads the request; code picks the items, so an allergy can never slip through.' },
  librarian: { name: 'Librarian', glyph: 'LB', role: 'Searches policies, manuals, past cases',
    does: 'Searches the policies, the service manual, bulletins, and past cases, and quotes the passages that apply, word for word. Code, no model.' },
  resolver: { name: 'Resolver', glyph: 'RS', role: 'Writes the reply, picks actions',
    does: 'Writes the reply from the case file and proposes actions (credit, refund, reroute, repair). Every fact must cite a source. Claude; it proposes, it never acts.' },
  checker: { name: 'Checker', glyph: 'CK', role: 'Verifies claims, scores confidence',
    does: 'Checks every claim against its source in code (does the source exist, is the quote exact, is the amount there), then Claude reviews. Can send the draft back once.' },
  diagnostician: { name: 'Diagnostician', glyph: 'DX', role: 'Finds the broken part',
    does: 'Decides which part is broken from the robot\'s readings, the service manual, and past repairs. When under 90% sure, it asks Fleet one question first. Claude.' },
  parts: { name: 'Parts', glyph: 'PT', role: 'Stock and bins',
    does: 'Finds the part in stock and reserves a bin for it. Code, no model.' },
  runner: { name: 'Runner', glyph: 'RN', role: 'Moves parts by robot',
    does: 'Sends an idle robot to carry the part to the repair depot, by real street route. Code, no model.' },
  scheduler: { name: 'Scheduler', glyph: 'SC', role: 'Mechanics, shifts, peaks',
    does: 'Fits each repair around mechanics\' shifts, stock, travel time, and the dinner rush. Code, no model: these are hard constraints.' },
};

export const PART_LABEL: Record<string, string> = {
  wheel_motor: 'Drive wheel motor', tire: 'Wheel tire', battery_pack: 'Battery pack', heater: 'Warming box heater',
  lid_seal: 'Lid seal gasket', lid_lock: 'Lid lock actuator', camera_mast: 'Camera mast', mainboard: 'Mainboard',
  bumper: 'Front bumper', flag: 'Safety flag',
};

export const KIND_LABEL: Record<string, string> = {
  db: 'Warehouse', policy: 'Policy', manual: 'Manual', bulletin: 'Bulletin', transcript: 'Transcript',
  case_note: 'Case note',
};
