export type Role = 'customer' | 'specialist' | 'head' | 'repair_lead' | 'mechanic';
export type Engine = 'live' | 'offline' | 'replay';
export type Decision = 'auto' | 'human';

export interface Status {
  engine: 'live' | 'offline'; model: string; clock: string; sim_now: string;
  robots: Record<string, number>; robots_total: number; open_cases: number; search_tier: string;
  auto_refund_cap: number; default_threshold: number; recordings: string[];
  needs_specialist: number; queue: Queue;
  peaks: { lunch: [number, number]; dinner: [number, number] };
  weather: Weather | null; place: string;
}

export interface Weather {
  hour: number; temp_f: number; precip_prob: number; precip_in: number; wind_mph: number; summary: string;
  kind: 'forecast' | 'observed'; fetched: string; source: string;
}

export interface Queue {
  running: boolean; current: string | null; done: number; total: number; engine: string | null; error: string | null;
}

export interface Route {
  robot_id: string; order_id: string | null; kind: 'deliver' | 'return' | 'stalled' | 'backup' | 'runner';
  path: [number, number][]; progress: number; arrive_at?: string | null; km?: number; label?: string; wo_id?: string;
}
export interface Robot {
  robot_id: string; model: string; batch: string; status: string; activity: string; zone: string;
  x: number; y: number; battery_pct: number; fault_code: string | null; home_depot: string;
  work_order: { wo_id: string; part_key: string; status: string } | null; route: Route | null;
}
export interface Depot { depot_id: string; name: string; kind: string; x: number; y: number; address?: string }
export interface KitchenOrder { order_id: string; status: string; placed_at: string; zone: string; items: string[]; name: string }
export interface Kitchen {
  hub: Depot; preparing: KitchenOrder[]; ready: KitchenOrder[];
  on_road: { robot_id: string; order_id: string | null; arrive_at?: string | null; km?: number; kind: string }[];
}
export interface MapData {
  roads: { k: 'freeway' | 'major' | 'minor' | 'service' | 'path'; n: string; p: [number, number][] }[];
  buildings: { h: number; p: [number, number][]; landmark?: string }[];
  parks: [number, number][][]; water: [number, number][][]; stadiums: [number, number][][];
  landmarks: { name: string; x: number; y: number }[]; source: string;
}
export interface Contact {
  contact_id: string; customer_id: string | null; channel: string; verified: boolean; message: string;
  received_at: string; customer_name?: string | null; decision?: Decision | null; confidence?: number | null;
  intent?: string | null; robot_id?: string | null; resolved_by?: string | null;
}
export interface City {
  robots: Robot[]; depots: Depot[]; contacts: (Contact & { home?: { x: number; y: number } | null })[];
  zones: Record<string, number[]>; kitchen: Kitchen; weather: Weather | null;
}
export interface Inbox {
  specialist: number; specialist_cases: string[]; repair_lead: number; mechanic: Record<string, number>; head: number;
  customer: number;
}
export interface TimelineStep {
  stage: string; actor: string; actor_kind: 'customer' | 'bot' | 'llm' | 'code' | 'human';
  status: 'done' | 'waiting' | 'pending'; at: string | null; detail: string; bots?: string[]; decision?: Decision;
}

export interface Claim { text: string; source_ids: string[]; supported: boolean; notes: string[] }
export interface Action {
  type: string; order_id: string | null; robot_id: string | null; amount: number | null; items: string[];
  part_key: string | null; reason: string;
}
export interface Revision { round: number; accepted: boolean; fixed: number; problems: string[] }
export interface Handoff { summary: string; recommendation: string; policy_source_id: string }
export interface CaseResult {
  contact_id: string; engine: string; intent?: string; decision: Decision; reasons: string[]; confidence: number;
  components?: Record<string, number>; reply: string; claims?: Claim[]; blocks?: string[]; actions?: Action[];
  executed?: { action: string; detail: string; status: string; by: string }[]; handoff?: Handoff | null;
  risk_flags?: string[]; revisions?: Revision[]; usage?: { cost_usd: number; calls: number; input_tokens: number; output_tokens: number };
  latency_ms?: number; brief?: string; error?: string; resolved_by?: string; specialist_actions?: { detail: string }[]; specialist_decision?: string;
}
export interface Evidence {
  source_id: string; title: string; kind: string; text: string; quote?: string | null; quote_verified?: boolean;
}
export type CaseEvent =
  | { type: 'case_start'; t_ms: number; contact: Contact; customer: Record<string, string> | null; engine: string; threshold: number }
  | { type: 'step'; t_ms: number; bot: string; status: 'start' | 'done'; kind: 'ai' | 'rules' | 'code'; say?: string; ms?: number;
      output?: Record<string, unknown>; search_tier?: string; top_score?: number; round?: number;
      to?: string[]; note?: string; usage?: { cost_usd: number; calls: number; input_tokens: number; output_tokens: number } }
  | { type: 'revision'; t_ms: number; round: number; status: 'start' | 'done';
      failed?: { index: number; text: string; notes: string[] }[]; accepted?: boolean; fixed?: number; problems?: string[] }
  | { type: 'tool'; t_ms: number; bot: string; name: string; args: Record<string, unknown>; ok: boolean; source_id: string; summary: string }
  | ({ type: 'evidence'; t_ms: number } & Evidence)
  | { type: 'brief'; t_ms: number; markdown: string }
  | { type: 'decision'; t_ms: number; decision: Decision; reasons: string[]; confidence: number;
      components: Record<string, number>; threshold: number; blocks: string[] }
  | { type: 'action'; t_ms: number; action: string; detail: string; status: string; by: string }
  | { type: 'handoff'; t_ms: number; ticket_id: string; handoff: Handoff | null; proposed: Action[] }
  | { type: 'error'; t_ms: number; message: string }
  | { type: 'final'; t_ms: number; result: CaseResult };

export interface WorkOrder {
  wo_id: string; robot_id: string; part_key: string; sku: string; status: string; priority: string; reason: string;
  source: string; created_at: string; scheduled_start: string | null; scheduled_end: string | null;
  mechanic_id: string | null; depot_id: string; robot_status: string; zone: string; batch: string; model: string;
  fault_code: string | null; part_name: string; repair_minutes: number; off_road: boolean;
  orders_lost_per_hour: number; plan: Plan | null;
}
export interface TimelineItem { lane: string; label: string; start: string; end: string; kind: string }
export interface Plan {
  wo_id: string; robot_id: string; part_key: string; sku?: string; part_name?: string; feasible: boolean; ok?: boolean;
  blocked_reason?: string; mechanic?: string; mechanic_id?: string; depot?: string; start?: string; end?: string;
  back_on_road?: string; runner?: { runner_id: string; pickup: string; arrive: string; from: string; to: string; bin: string } | null;
  timeline: TimelineItem[]; checks: { label: string; ok: boolean; detail: string }[];
  bots: { bot: string; say: string }[]; orders_lost_offpeak?: number; orders_lost_if_rush?: number;
  source?: { location: string; bin: string; available_before: number };
}
export interface Diagnosis {
  wo_id: string; robot_id: string; suspected_part: string; confidence: number; signature_part: string | null;
  alternatives: { part_key: string; likelihood: number }[]; rationale: string; say: string; engine: string;
  evidence: Evidence[]; telemetry: { ts: string; motor_l_amps: number; box_temp_c: number; speed_kph: number; fault_code: string | null }[];
  trips: { order_id: string; arrived_at: string; box_temp_departure: number; box_temp_arrival: number }[];
}
export interface SweepPoint { threshold: number; containment: number; auto_accuracy: number; wrong_auto: number }
export interface EvalKpis {
  cases: number; containment: number; correct: number; auto_accuracy: number; escalation_precision: number;
  escalation_recall: number; grounded_claims: number; safety_violations: number; intent_accuracy: number;
  revised?: number; revisions_kept?: number;
  latency_p50_ms: number; latency_p95_ms: number; cost_per_conversation: number; threshold: number;
}
export interface EvalRow {
  id: string; message: string; expected: { decision: Decision; intent?: string }; decision: Decision; intent: string;
  confidence: number; reply: string; checks: Record<string, boolean>; correct: boolean; answer_ok: boolean;
  reasons: string[]; hard_block: boolean; safety_issues: string[];
}
export interface Kpis {
  baseline: { aht_min: number; fcr: number; tickets: number; cost_per_contact: number; loaded_rate_assumption: number };
  eval: { engine: string; ran_at: string; kpis: EvalKpis; sweep: SweepPoint[] } | null;
  session: { handled: number; auto: number; human: number };
  ops: { uptime: number; mttr_h: number; first_time_fix: number; orders_lost_per_hour: number; parts_below_reorder: number;
         open_work_orders: number; scheduled: number };
  money: { created_by: string; kind: string; total: number; n: number }[];
  money_events?: { at: string; amount: number; created_by: string }[];
}

export type CrewEvent =
  | { type: 'crew_start'; wo_ids: string[]; robots: string[] }
  | { type: 'post'; bot: string; say: string; to: string[]; note: string; kind: string; robot_id?: string; part?: string;
      confidence?: number; round?: number; tool?: string; source_id?: string; consult?: boolean; rationale?: string;
      runner?: NonNullable<Plan['runner']> }
  | { type: 'approval'; plans: Plan[]; feasible: number; count: number; before_dinner_rush: number;
      runner_trips: NonNullable<Plan['runner']>[] }
  | { type: 'error'; message: string }
  | { type: 'final' };

export interface Mechanic {
  mechanic_id: string; name: string; depot_id: string; depot: string; skills: string; shift_start: string; shift_end: string;
  jobs: number;
}
export interface Job extends WorkOrder {
  part_name: string; depot: string; source_bin: string | null; source_location: string | null;
  runner: Plan['runner']; checks: { label: string; ok: boolean; detail: string }[]; completed_at: string | null;
}

// ---------------------------------------------------------------- console copilot

export interface CopilotStep { name: string; label: string; group: string; ok: boolean; summary: string; ms: number }
export interface CopilotSource { source_id: string; title: string; kind: string }
export type CopilotCard =
  | { kind: 'approval'; contact_id: string; customer: string; message: string; summary: string | null;
      recommendation: string | null; policy_source_id: string | null; on_approve: string; approve: boolean;
      confidence: number | null; decided?: { approved: boolean; details: string[] } }
  | { kind: 'case'; contact_id: string; customer: string; message: string; intent: string | null; decision: Decision;
      confidence: number | null; resolved_by: string | null }
  | { kind: 'robot'; robot_id: string; status: string; activity: string; battery_pct: number; fault_code: string | null;
      batch: string; zone: string }
  | { kind: 'goodwill'; contact_id: string; customer: string; order_id: string | null; amount: number; message: string;
      checks: { label: string; ok: boolean; blocks: boolean; warn?: boolean; detail: string }[]; blocked: boolean;
      pending: boolean; replaces: string | null; decided?: { approved: boolean; details: string[] } }
  | { kind: 'repair_plan'; wo_ids: string[]; count: number; feasible: number; before_dinner_rush: number; dinner_rush: string;
      plans: { wo_id: string; robot_id: string; part_name: string; feasible: boolean; blocked_reason: string | null;
               mechanic: string | null; depot: string | null; start: string | null; end: string | null;
               back_on_road: string | null; bin: string | null }[];
      runner_trips: NonNullable<Plan['runner']>[]; decided?: { approved: boolean; details: string[] } }
  | { kind: 'threshold'; current_threshold: number; proposed_threshold: number; current: SweepPoint; proposed: SweepPoint;
      sweep: SweepPoint[]; cases: number; engine: string; clamped: boolean; decided?: { approved: boolean; details: string[] } }
  | { kind: 'nav'; tab: string; label: string; cue: Cue | null }
  | { kind: 'tour' };
/** A nudge from the copilot to a screen: centre Live City on a robot, replay a story, open a case. */
export type Cue = { kind: 'robot'; id: string } | { kind: 'story'; id: string; replay: boolean } | { kind: 'case'; id: string };
export type CopilotEvent =
  | { type: 'thinking'; text: string }
  | ({ type: 'tool'; args: Record<string, unknown> } & CopilotStep)
  | { type: 'card'; card: CopilotCard }
  | { type: 'reply'; text: string; sources: CopilotSource[]; suggestions: string[] }
  | { type: 'done'; engine: string; ms: number }
  | { type: 'error'; message: string };
export interface CopilotManifest {
  tools: { name: string; group: string; group_label: string; description: string; effect: 'read' | 'proposes' | 'navigates' }[];
  starters: string[];
}
