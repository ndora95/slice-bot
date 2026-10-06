import { ContactShadows, Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../App';
import { Gantt, Sparkline } from '../components/charts';
import { Button, EngineMark, ENTER, Glyph, Icon, Kicker, KV, Panel, Pill, Segmented, Skeleton, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { BOTS, hhmm, hoursOf, human, PART_LABEL } from '../lib/format';
import { useApi } from '../lib/hooks';
import type { Diagnosis, Plan, WorkOrder } from '../lib/types';
import { ExplodedRobot, partFocus } from '../three/RobotModel';
import { token } from '../three/palette';

const GROUPS: { id: string; label: string; test: (w: WorkOrder) => boolean; dot: 'crit' | 'warn' | 'ok' }[] = [
  { id: 'down', label: 'Off the road', test: (w) => w.off_road && !['scheduled', 'in_progress'].includes(w.status), dot: 'crit' },
  { id: 'prev', label: 'Preventive · fleet scan', test: (w) => !w.off_road && w.status === 'proposed', dot: 'warn' },
  { id: 'sched', label: 'Scheduled', test: (w) => ['scheduled', 'in_progress'].includes(w.status), dot: 'ok' },
];

export default function RepairScreen() {
  const { tick, bump, workOrderId, setWorkOrderId } = useApp();
  const { data: queue, reload } = useApi<WorkOrder[]>('/api/repair/queue', tick);
  const [batch, setBatch] = useState(false);
  const sel = queue?.find((w) => w.wo_id === workOrderId) ?? null;

  useEffect(() => {
    if (queue?.length && !queue.some((w) => w.wo_id === workOrderId)) setWorkOrderId(queue[0].wo_id);
  }, [queue, workOrderId, setWorkOrderId]);

  const proposed = queue?.filter((w) => w.status === 'proposed') ?? [];
  const lost = queue?.reduce((a, w) => a + w.orders_lost_per_hour, 0) ?? 0;

  return (
    <div className="grid grid-cols-[320px_1fr] max-lg:grid-cols-1 gap-s4 min-h-full">
      <div className="flex flex-col gap-s4 min-w-0">
        <Panel kicker={`Work orders · ${queue?.length ?? 0}`} dot={lost > 0 ? 'crit' : 'ok'}
          action={<span className="text-xs font-mono text-ink-secondary tabular-nums">{lost.toFixed(1)} orders/h lost</span>}>
          {!queue && <Skeleton className="h-64" />}
          {queue && GROUPS.map((g) => {
            const rows = queue.filter(g.test);
            if (!rows.length) return null;
            return (
              <div key={g.id} className="flex flex-col mb-s3 last:mb-0">
                <div className="flex items-center justify-between py-s2">
                  <Kicker dot={g.dot}>{g.label} · {rows.length}</Kicker>
                  {g.id === 'prev' && rows.length > 1 && (
                    <button onClick={() => setBatch(true)} className="text-xs text-accent-bright hover:text-ink-primary transition-colors duration-fast">
                      Plan all {rows.length}
                    </button>
                  )}
                </div>
                {rows.map((w) => {
                  const on = !batch && w.wo_id === workOrderId;
                  return (
                    <button key={w.wo_id} onClick={() => { setBatch(false); setWorkOrderId(w.wo_id); }}
                      className={`relative text-left grid grid-cols-[1fr_auto] gap-s2 px-s3 py-s2 rounded-ctl border-t border-line first:border-t-0
                                  transition-colors duration-fast ease-out ${on ? 'bg-accent-fill' : 'hover:bg-surface-hover'}`}>
                      {on && <motion.span layoutId="wo-sel" className="absolute left-0 top-2 bottom-2 w-0.5 rounded-pill bg-accent" />}
                      <span className="min-w-0">
                        <span className="block text-smd text-ink-primary">{w.robot_id} · {PART_LABEL[w.part_key]}</span>
                        <span className="block text-xs font-mono text-ink-secondary truncate">{w.wo_id} · {w.zone} · {w.fault_code ?? w.source.replace('_', ' ')}</span>
                      </span>
                      <span className="text-xs font-mono tabular-nums text-ink-secondary self-center">
                        {w.status === 'scheduled' ? hhmm(w.scheduled_start) : w.orders_lost_per_hour ? `${w.orders_lost_per_hour}/h` : '—'}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </Panel>
      </div>
      <div className="min-w-0">
        {batch ? <BatchPlan ids={proposed.map((w) => w.wo_id)} onDone={() => { setBatch(false); reload(); bump(); }} />
          : sel ? <WorkOrderDetail key={sel.wo_id} wo={sel} onChange={() => { reload(); bump(); }} />
          : <Panel><p className="text-sm text-ink-secondary">No open work orders. Run the cold-pizza case in the Case Room to create some.</p></Panel>}
      </div>
    </div>
  );
}

function WorkOrderDetail({ wo, onChange }: { wo: WorkOrder; onChange: () => void }) {
  const { engine } = useApp();
  const diagEngine = engine === 'live' ? 'live' : 'offline';
  const { data: diag } = useApi<Diagnosis>(`/api/repair/${wo.wo_id}/diagnose?engine=${diagEngine}`);
  const [exploded, setExploded] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(wo.plan);
  const [planning, setPlanning] = useState(false);
  const [approved, setApproved] = useState(wo.status === 'scheduled');
  const part = picked ?? diag?.suspected_part ?? wo.part_key;
  const scheduled = ['scheduled', 'in_progress'].includes(wo.status);

  useEffect(() => {
    if (scheduled || !diag) return;
    setPlanning(true);
    api.post<Plan>(`/api/repair/${wo.wo_id}/plan`, { part_key: part }).then(setPlan).finally(() => setPlanning(false));
  }, [part, diag, wo.wo_id, scheduled]);

  const approve = async () => {
    if (!plan) return;
    await api.post(`/api/repair/${wo.wo_id}/approve`, { plan });
    setApproved(true);
    onChange();
  };

  const motor = (diag?.telemetry ?? []).some((t) => (t.fault_code ?? '').startsWith('MTR'));
  return (
    <div className="flex flex-col gap-s4">
      <Panel>
        <div className="flex items-center justify-between gap-s4 flex-wrap">
          <div className="flex items-center gap-s3">
            <span className="text-md font-semibold text-ink-primary">{wo.robot_id}</span>
            <span className="text-xs font-mono text-ink-secondary">{wo.model} · batch {wo.batch} · {wo.zone} · {wo.wo_id}</span>
            <Pill kind={wo.off_road ? 'crit' : 'warn'}>{wo.off_road ? human(wo.robot_status) : 'in service'}</Pill>
            {scheduled && <Pill kind="ok">scheduled {hhmm(wo.scheduled_start)}</Pill>}
          </div>
          <span className="text-sm text-ink-secondary">{wo.reason}</span>
        </div>
      </Panel>

      <div className="grid grid-cols-[1fr_360px] max-xl:grid-cols-1 gap-s4">
        <section className="relative rounded-panel border border-line-shell overflow-hidden bg-surface-panel h-[460px]">
          {/* a photo studio: warm key light, cool rim, a soft floor shadow, and reflections from light panels */}
          <Canvas shadows camera={{ position: [3.8, 3.0, 4.2], fov: 38 }} dpr={[1, 2]} style={{ background: token('scene-bg') }}
            onPointerMissed={() => setPicked(null)}>
            <fog attach="fog" args={[token('scene-bg'), 7, 15]} />
            <ambientLight intensity={0.35} />
            <directionalLight position={[4, 6, 3]} intensity={1.5} color={token('scene-key')} castShadow />
            <directionalLight position={[-5, 3, -4]} intensity={0.9} color={token('scene-rim')} />
            <Environment resolution={128}>
              <Lightformer intensity={2.2} color={token('scene-key')} position={[0, 4, 3]} scale={[6, 2, 1]} />
              <Lightformer intensity={1.2} color={token('scene-rim')} position={[-5, 2, -2]} rotation-y={Math.PI / 2} scale={[4, 2, 1]} />
            </Environment>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.86, 0]} receiveShadow>
              <circleGeometry args={[6, 64]} /><meshStandardMaterial color={token('scene-floor')} roughness={0.9} />
            </mesh>
            <ContactShadows position={[0, -0.85, 0]} opacity={0.55} scale={7} blur={2.6} far={3} />
            <ExplodedRobot exploded={exploded} suspect={diag?.suspected_part ?? null} selected={picked}
              confidence={diag?.confidence} onPick={(k) => setPicked(k === diag?.suspected_part ? null : k)} />
            <FrameSuspect part={picked ?? diag?.suspected_part ?? null} exploded={exploded} />
            <OrbitControls makeDefault enablePan={false} minDistance={2.8} maxDistance={9} target={[0, 0.85, 0]} />
          </Canvas>
          <div className="absolute left-s4 top-s4 flex items-center gap-s2">
            <Segmented id="explode" size="sm" value={exploded ? 'x' : 'a'} onChange={(v) => setExploded(v === 'x')}
              options={[{ id: 'a', label: 'Assembled' }, { id: 'x', label: 'Exploded' }]} />
          </div>
          <div className="absolute left-s4 bottom-s4 right-s4 flex items-center justify-between text-xs text-ink-secondary pointer-events-none">
            <span>Disagree with the diagnosis? Click the part you think it is.</span>
            {picked && <span className="text-accent-bright font-medium">Your pick: {PART_LABEL[picked]}</span>}
          </div>
        </section>

        <Panel kicker="Diagnosis" dot="ai" action={diag && <EngineMark kind={diag.engine === 'live' ? 'ai' : 'rules'} />}>
          {!diag ? <Spinner label="Diagnostician reading telemetry…" /> : (
            <div className="flex flex-col gap-s3">
              <div className="flex items-start gap-s3">
                <Glyph text="DX" tone={diag.engine === 'live' ? 'ai' : 'neutral'} />
                <div className="flex flex-col gap-1">
                  <span className="text-smd font-semibold text-ink-primary">{PART_LABEL[diag.suspected_part]}</span>
                  <span className="text-sm text-ink-emphasis">{diag.rationale}</span>
                </div>
              </div>
              <div className="flex flex-col">
                <KV k="Confidence" v={`${Math.round(diag.confidence * 100)}%`} />
                <KV k="Telemetry signature" v={diag.signature_part ? PART_LABEL[diag.signature_part] : 'none'} />
                {diag.alternatives.map((a) => <KV key={a.part_key} k={`Alternative · ${PART_LABEL[a.part_key]}`} v={`${Math.round(a.likelihood * 100)}%`} />)}
              </div>
              {diag.telemetry.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-ink-secondary">
                    {motor ? 'Left motor current, last 6 h (A)' : diag.trips.length ? 'Warming box loss per trip (°C)' : 'Warming box (°C)'}
                  </span>
                  {motor
                    ? <Sparkline values={diag.telemetry.map((t) => t.motor_l_amps)} labels={diag.telemetry.map((t) => t.ts.slice(11, 16))} refLine={12} refLabel="stall 12 A" unit=" A" />
                    : diag.trips.length
                      ? <Sparkline values={diag.trips.map((t) => t.box_temp_departure - t.box_temp_arrival)} labels={diag.trips.map((t) => t.order_id)} refLine={8} refLabel="8°C limit" unit="°C" />
                      : <Sparkline values={diag.telemetry.map((t) => t.box_temp_c)} unit="°C" />}
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                {diag.evidence.map((e) => <code key={e.source_id} title={e.text} className="text-2xs font-mono px-1.5 py-0.5 rounded-ctl bg-surface-inset border border-line text-ink-secondary">{e.source_id}</code>)}
              </div>
            </div>
          )}
        </Panel>
      </div>

      <PlanPanel plan={plan} planning={planning} approved={approved || scheduled} onApprove={approve} override={picked} />
    </div>
  );
}

/** When the diagnosis lands (or you pick a part), the camera swings round to face that part and leans in. Drag to take over. */
function FrameSuspect({ part, exploded }: { part: string | null; exploded: boolean }) {
  const { camera, controls } = useThree() as unknown as { camera: THREE.Camera; controls: { target: THREE.Vector3; update: () => void;
    addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } | null };
  const goal = useRef<{ target: THREE.Vector3; pos: THREE.Vector3 } | null>(null);
  const reduce = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!part || !controls) return;
    const f = partFocus(part, exploded);
    if (!f) return;
    const target = new THREE.Vector3(f[0] * 0.6, 0.85 + (f[1] - 0.85) * 0.6, f[2] * 0.6);
    // look from the side the part sticks out on, a little above
    const out = new THREE.Vector3(f[0], 0, f[2]);
    if (out.lengthSq() < 0.01) out.set(1, 0, 0.8);
    out.normalize();
    const pos = target.clone().add(new THREE.Vector3(out.x * 3.3 + 0.9, 1.7, out.z * 3.3 + 1.6));
    goal.current = { target, pos };
    const cancel = () => { goal.current = null; };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [part, exploded, controls]);
  useFrame((_, dt) => {
    const g = goal.current;
    if (!g || !controls) return;
    const k = reduce.current ? 1 : Math.min(1, dt * 2.2);
    controls.target.lerp(g.target, k);
    camera.position.lerp(g.pos, k);
    controls.update();
    if (camera.position.distanceTo(g.pos) < 0.01) goal.current = null;
  });
  return null;
}

function PlanPanel({ plan, planning, approved, onApprove, override }: {
  plan: Plan | null; planning: boolean; approved: boolean; onApprove: () => void; override: string | null;
}) {
  const { status } = useApp();
  if (!plan) return <Panel kicker="Repair plan"><Spinner label="Planning around shifts, stock, and the dinner rush…" /></Panel>;
  const items = plan.timeline;
  const peaks = status ? [{ label: 'lunch peak', range: status.peaks.lunch }, { label: 'dinner rush', range: status.peaks.dinner }] : [];
  const lo = Math.min(13.5, ...items.map((i) => hoursOf(i.start))), hi = Math.max(17.5, ...items.map((i) => hoursOf(i.end)) );
  return (
    <Panel kicker={`Repair plan${override ? ' · with your override' : ''}`} dot={plan.feasible ? (plan.ok ? 'ok' : 'warn') : 'crit'}
      action={planning ? <Spinner label="Re-planning" /> : approved ? <Pill kind="ok">Approved, scheduled</Pill> :
        <Button variant="primary" onClick={onApprove} disabled={!plan.feasible}><Icon name="check" /> Approve plan</Button>}>
      <div className="grid grid-cols-[1fr_300px] max-xl:grid-cols-1 gap-s5">
        <div className="flex flex-col">
          {plan.bots.map((b, i) => (
            <motion.div key={`${b.bot}-${i}-${b.say.length}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 7) * 0.08, duration: 0.3, ease: ENTER }}
              className="grid grid-cols-[28px_1fr] gap-s3 py-s2 border-t border-line first:border-t-0">
              <Glyph text={BOTS[b.bot]?.glyph ?? 'BT'} />
              <div className="min-w-0">
                <div className="flex items-center gap-s2"><span className="text-smd font-semibold text-ink-primary">{BOTS[b.bot]?.name ?? b.bot}</span><EngineMark kind="rules" /></div>
                <p className="text-smd text-ink-emphasis mt-0.5">{b.say}</p>
              </div>
            </motion.div>
          ))}
        </div>
        <div className="flex flex-col gap-s2">
          <Kicker>Constraints</Kicker>
          {plan.checks.map((c) => (
            <div key={c.label} className="grid grid-cols-[16px_1fr] gap-s2 text-sm">
              <Icon name={c.ok ? 'check' : 'x'} className={c.ok ? 'text-ok-text' : 'text-crit-text'} />
              <span><span className="text-ink-primary">{c.label}</span> <span className="text-ink-secondary font-mono text-xs">{c.detail}</span></span>
            </div>
          ))}
          {plan.feasible && plan.orders_lost_if_rush != null && plan.orders_lost_if_rush > 0 && (
            <p className="text-xs text-ink-secondary mt-s2">Off-peak: about {plan.orders_lost_offpeak} orders lost while it's out. Same repair at 18:00: {plan.orders_lost_if_rush}.</p>
          )}
        </div>
      </div>
      {items.length > 0 && (
        <div className="mt-s4 pt-s4 border-t border-line">
          <Gantt items={items} from={Math.floor(lo)} to={Math.ceil(hi)} peaks={peaks} now={13 + 40 / 60} />
        </div>
      )}
    </Panel>
  );
}

function BatchPlan({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { status } = useApp();
  const [data, setData] = useState<{ plans: Plan[]; before_dinner_rush: number; feasible: number; runner_trips: Plan['runner'][] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.post<typeof data>('/api/repair/batch-plan', { wo_ids: ids }).then(setData); }, [ids.join()]);
  if (!data) return <Panel kicker="Batch plan"><Spinner label={`Planning ${ids.length} repairs together…`} /></Panel>;
  const items = data.plans.flatMap((p) => p.timeline.filter((t) => t.kind === 'repair').map((t) => ({ ...t, label: `${p.robot_id} · ${t.label}` })));
  const runners = data.runner_trips.filter(Boolean).map((r) => ({ lane: `Runner ${r!.runner_id}`, label: `${r!.from} → ${r!.to}`, start: r!.pickup, end: r!.arrive, kind: 'pickup' }));
  const lanes = Array.from(new Set([...runners.map((r) => r.lane), ...items.map((i) => i.lane)]));
  const approveAll = async () => { setBusy(true); await api.post('/api/repair/batch-approve', { wo_ids: ids }); setBusy(false); onDone(); };
  return (
    <div className="flex flex-col gap-s4">
      <Panel kicker={`Batch plan · lid seals on batch M2-B07 · ${ids.length} robots`} dot="warn"
        action={<Button variant="primary" onClick={approveAll} disabled={busy}><Icon name="check" /> Approve all {data.feasible}</Button>}>
        <div className="grid grid-cols-3 max-md:grid-cols-1 rounded-card border border-line overflow-hidden">
          <Stat v={`${data.feasible} / ${ids.length}`} l="fit today" />
          <Stat v={String(data.before_dinner_rush)} l="back before 17:00" border />
          <Stat v={String(data.runner_trips.length)} l="runner trips, all parts" border />
        </div>
        <Gantt items={[...runners, ...items]} laneOrder={lanes} from={13} to={18} now={13 + 40 / 60}
          peaks={status ? [{ label: 'dinner rush', range: status.peaks.dinner }] : []} />
      </Panel>
      <Panel kicker="Assignments">
        <div className="overflow-x-auto -mx-s4">
          <table className="w-full border-collapse min-w-[720px]">
            <thead><tr>{['Robot', 'Depot', 'Mechanic', 'Window', 'Back', 'Part from', 'Note'].map((h) => (
              <th key={h} className="text-left text-xs text-ink-secondary font-medium px-s4 py-s2 border-b border-line">{h}</th>))}</tr></thead>
            <tbody>
              {data.plans.map((p) => (
                <tr key={p.wo_id} className={`hover:bg-surface-hover transition-colors duration-fast ${p.feasible ? '' : 'bg-crit-fill'}`}>
                  <td className="px-s4 py-s2 border-b border-line font-mono text-smd">{p.robot_id}</td>
                  <td className="px-s4 py-s2 border-b border-line text-smd">{p.depot ?? '—'}</td>
                  <td className="px-s4 py-s2 border-b border-line text-smd">{p.mechanic ?? '—'}</td>
                  <td className="px-s4 py-s2 border-b border-line font-mono text-smd tabular-nums">{p.feasible ? `${hhmm(p.start)}–${hhmm(p.end)}` : '—'}</td>
                  <td className="px-s4 py-s2 border-b border-line font-mono text-smd tabular-nums">{hhmm(p.back_on_road)}</td>
                  <td className="px-s4 py-s2 border-b border-line text-sm text-ink-secondary">{p.source ? `${p.source.location} ${p.source.bin}` : '—'}</td>
                  <td className="px-s4 py-s2 border-b border-line text-sm text-ink-secondary">{p.blocked_reason ?? p.bots.find((b) => b.bot === 'scheduler')?.say.split('. ').slice(1).join('. ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Stat({ v, l, border }: { v: string; l: string; border?: boolean }) {
  return (
    <div className={`px-s4 py-s3 ${border ? 'border-l border-line max-md:border-l-0 max-md:border-t' : ''}`}>
      <div className="font-display text-metric font-semibold tabular-nums leading-none text-ink-primary">{v}</div>
      <div className="text-xs text-ink-secondary mt-1.5">{l}</div>
    </div>
  );
}
