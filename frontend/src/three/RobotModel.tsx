/* The SliceBot M2, built from primitives so nothing is borrowed from anywhere.
 * Every replaceable part is its own group keyed by part_key (matches the backend). */
import { Html, RoundedBox } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { token } from './palette';
import { PART_LABEL } from '../lib/format';

type V3 = [number, number, number];
interface PartDef { key: string; selectable: boolean; explode: V3; render: (mat: (base: string) => ReactNode) => ReactNode }

const WHEEL_X = [-0.45, 0, 0.45];

const PARTS: PartDef[] = [
  { key: 'chassis', selectable: false, explode: [0, 0, 0], render: (m) => (
    <>
      <RoundedBox args={[1.3, 0.55, 0.86]} radius={0.08} smoothness={4} position={[0, 0.5, 0]}>{m('scene-robot')}</RoundedBox>
      <mesh position={[0.652, 0.58, 0]}><boxGeometry args={[0.01, 0.12, 0.5]} />{m('scene-glass')}</mesh>
      <mesh position={[0, 0.25, 0]}><boxGeometry args={[1.22, 0.06, 0.8]} />{m('scene-robot-trim')}</mesh>
    </>) },
  { key: 'lid', selectable: false, explode: [0, 1.25, 0], render: (m) => (
    <RoundedBox args={[1.1, 0.1, 0.74]} radius={0.04} smoothness={3} position={[-0.05, 0.86, 0]}>{m('scene-robot')}</RoundedBox>) },
  { key: 'lid_seal', selectable: true, explode: [0, 0.8, 0], render: (m) => (
    <group position={[-0.05, 0.8, 0]}>
      {([[0.51, 0], [-0.51, 0]] as const).map(([x], i) => (
        <mesh key={`a${i}`} position={[x, 0, 0]}><boxGeometry args={[0.04, 0.035, 0.7]} />{m('scene-seal')}</mesh>))}
      {([0.33, -0.33] as const).map((z, i) => (
        <mesh key={`b${i}`} position={[0, 0, z]}><boxGeometry args={[1.06, 0.035, 0.04]} />{m('scene-seal')}</mesh>))}
    </group>) },
  { key: 'heater', selectable: true, explode: [0, 0.42, 0], render: (m) => (
    <mesh position={[-0.05, 0.62, 0]}><boxGeometry args={[0.9, 0.04, 0.58]} />{m('scene-heater')}</mesh>) },
  { key: 'lid_lock', selectable: true, explode: [0.7, 0.35, 0], render: (m) => (
    <mesh position={[0.56, 0.8, 0]}><boxGeometry args={[0.1, 0.1, 0.16]} />{m('scene-lock')}</mesh>) },
  { key: 'battery_pack', selectable: true, explode: [0, -0.75, 0], render: (m) => (
    <mesh position={[0, 0.34, 0]}><boxGeometry args={[0.8, 0.14, 0.5]} />{m('scene-battery')}</mesh>) },
  { key: 'mainboard', selectable: true, explode: [-1.25, 0.15, 0], render: (m) => (
    <mesh position={[-0.2, 0.46, 0]}><boxGeometry args={[0.5, 0.03, 0.36]} />{m('scene-board')}</mesh>) },
  { key: 'tire', selectable: true, explode: [0, 0, 0.8], render: (m) => (
    <>{WHEEL_X.flatMap((x) => [0.5, -0.5].map((z) => (
      <mesh key={`${x}${z}`} position={[x, 0.17, z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.17, 0.17, 0.12, 24]} />{m('scene-wheel')}
      </mesh>)))}</>) },
  { key: 'wheel_motor', selectable: true, explode: [0, 0, 0.42], render: (m) => (
    <>{WHEEL_X.flatMap((x) => [0.37, -0.37].map((z) => (
      <mesh key={`${x}${z}`} position={[x, 0.17, z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 0.14, 16]} />{m('scene-motor')}
      </mesh>)))}</>) },
  { key: 'camera_mast', selectable: true, explode: [0.45, 0.75, 0], render: (m) => (
    <>
      <mesh position={[0.5, 0.98, 0]}><cylinderGeometry args={[0.025, 0.025, 0.36, 12]} />{m('scene-camera')}</mesh>
      <mesh position={[0.52, 1.18, 0]}><boxGeometry args={[0.12, 0.09, 0.22]} />{m('scene-camera')}</mesh>
      <mesh position={[0.585, 1.18, 0]}><boxGeometry args={[0.01, 0.05, 0.14]} />{m('scene-glass')}</mesh>
    </>) },
  { key: 'flag', selectable: true, explode: [-0.45, 0.6, 0], render: (m) => (
    <>
      <mesh position={[-0.55, 1.25, 0.3]}><cylinderGeometry args={[0.012, 0.012, 0.95, 8]} />{m('scene-robot-trim')}</mesh>
      <mesh position={[-0.44, 1.64, 0.3]}><boxGeometry args={[0.22, 0.14, 0.01]} />{m('scene-flag')}</mesh>
    </>) },
  { key: 'bumper', selectable: true, explode: [0.85, 0, 0], render: (m) => (
    <mesh position={[0.69, 0.33, 0]}><boxGeometry args={[0.08, 0.16, 0.8]} />{m('scene-robot-trim')}</mesh>) },
];

/** Where a part sits (exploded or assembled), in the scene's coordinates: for the camera to frame it. */
export function partFocus(key: string, exploded: boolean): V3 | null {
  const c = CENTER[key], def = PARTS.find((p) => p.key === key);
  if (!c || !def) return null;
  const k = exploded ? 1 : 0;
  return [c[0] + def.explode[0] * k, c[1] + def.explode[1] * k + 0.2, c[2] + def.explode[2] * k];
}

const CENTER: Record<string, V3> = {
  lid_seal: [-0.05, 0.8, 0.33], heater: [-0.05, 0.62, 0], lid_lock: [0.56, 0.8, 0], battery_pack: [0, 0.34, 0],
  mainboard: [-0.2, 0.46, 0], tire: [0.45, 0.17, 0.5], wheel_motor: [0.45, 0.17, 0.37], camera_mast: [0.52, 1.18, 0],
  flag: [-0.44, 1.64, 0.3], bumper: [0.69, 0.33, 0],
};

function Part({ def, progress, state, onPick, onHover, reduce }: {
  def: PartDef; progress: React.MutableRefObject<number>; state: 'suspect' | 'selected' | 'hover' | 'dim' | 'normal';
  onPick: (k: string) => void; onHover: (k: string | null) => void; reduce: boolean;
}) {
  const g = useRef<THREE.Group>(null);
  const mats = useRef<THREE.MeshStandardMaterial[]>([]);
  mats.current = [];
  const shell = !def.selectable;
  useFrame(({ clock }) => {
    if (!g.current) return;
    const p = progress.current;
    g.current.position.set(def.explode[0] * p, def.explode[1] * p, def.explode[2] * p);
    if (shell) {
      // The body turns to surface-card as it explodes, so the parts inside read clearly.
      for (const mat of mats.current) {
        mat.transparent = true;
        mat.opacity = 1 - 0.78 * p;
        mat.depthWrite = p < 0.5;
      }
      return;
    }
    const pulse = reduce ? 0.6 : 0.45 + 0.35 * Math.sin(clock.elapsedTime * 3);
    for (const mat of mats.current) {
      if (state === 'suspect') mat.emissiveIntensity = pulse;
      else if (state === 'selected') mat.emissiveIntensity = 0.55;
      else if (state === 'hover') mat.emissiveIntensity = 0.25;
      else mat.emissiveIntensity = 0;
    }
  });
  const emissive = state === 'suspect' ? token('status-warn') : state === 'selected' ? token('accent') : token('text-emphasis');
  const mat = (base: string) => (
    <meshStandardMaterial
      ref={(m) => { if (m && !mats.current.includes(m)) mats.current.push(m); }}
      color={token(base)} emissive={emissive} emissiveIntensity={0} roughness={0.42} metalness={0.12} envMapIntensity={0.9}
      transparent={state === 'dim'} opacity={state === 'dim' ? 0.35 : 1} />
  );
  const handlers = def.selectable ? {
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onPick(def.key); },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(def.key); document.body.style.cursor = 'pointer'; },
    onPointerOut: () => { onHover(null); document.body.style.cursor = ''; },
  } : {};
  return <group ref={g} {...handlers}>{def.render(mat)}</group>;
}

export function ExplodedRobot({ exploded, suspect, selected, confidence, onPick }: {
  exploded: boolean; suspect: string | null; selected: string | null; confidence?: number | null; onPick: (k: string) => void;
}) {
  const progress = useRef(exploded ? 1 : 0);
  const [hover, setHover] = useState<string | null>(null);
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useFrame((_, dt) => {
    const target = exploded ? 1 : 0;
    progress.current = reduce ? target : progress.current + (target - progress.current) * Math.min(1, dt * 5);
  });
  const focus = selected ?? suspect;
  const stateOf = (k: string) => k === selected ? 'selected' : k === suspect ? 'suspect' : k === hover ? 'hover'
    : (focus && exploded && k !== 'chassis' && k !== 'lid') ? 'dim' : 'normal';
  const label = (k: string | null, kind: 'suspect' | 'selected' | 'hover') => {
    if (!k || !CENTER[k]) return null;
    const def = PARTS.find((p) => p.key === k)!;
    const c = CENTER[k];
    return (
      <LabelAt key={`${kind}-${k}`} base={c} explode={def.explode} progress={progress}>
        <div className={`tooltip whitespace-nowrap rounded-chip border px-2.5 py-1 text-xs font-medium shadow-overlay pointer-events-none
          ${kind === 'suspect' ? 'bg-surface-solid border-warn text-warn-text' : kind === 'selected' ? 'bg-surface-solid border-accent-line text-accent-bright'
          : 'bg-surface-solid border-line text-ink-emphasis'}`}>
          {kind === 'suspect' && <span className="font-semibold mr-1.5">Suspect{confidence != null ? ` · ${Math.round(confidence * 100)}%` : ''}</span>}
          {kind === 'selected' && k !== suspect && <span className="font-semibold mr-1.5">Your pick</span>}
          {PART_LABEL[k] ?? k}
        </div>
      </LabelAt>
    );
  };
  return (
    <group position={[0, 0.2, 0]}>
      {PARTS.map((d) => (
        <Part key={d.key} def={d} progress={progress} state={stateOf(d.key)} onPick={onPick} onHover={setHover} reduce={reduce} />
      ))}
      {label(suspect, 'suspect')}
      {selected && selected !== suspect && label(selected, 'selected')}
      {hover && hover !== suspect && hover !== selected && label(hover, 'hover')}
    </group>
  );
}

function LabelAt({ base, explode, progress, children }: { base: V3; explode: V3; progress: React.MutableRefObject<number>; children: ReactNode }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = progress.current;
    g.current?.position.set(base[0] + explode[0] * p, base[1] + explode[1] * p + 0.18, base[2] + explode[2] * p);
  });
  return <group ref={g}><Html center zIndexRange={[20, 0]}>{children}</Html></group>;
}

/** Small robot for the city view. */
export function MiniRobot({ color, flag = true }: { color: string; flag?: boolean }) {
  return (
    <group>
      <mesh position={[0, 0.1, 0]} castShadow>
        <boxGeometry args={[0.26, 0.13, 0.18]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.17, 0]}>
        <boxGeometry args={[0.22, 0.02, 0.15]} />
        <meshStandardMaterial color={token('scene-robot-trim')} />
      </mesh>
      {[-0.08, 0.08].map((x) => [-0.1, 0.1].map((z) => (
        <mesh key={`${x}${z}`} position={[x, 0.035, z]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.035, 0.035, 0.03, 10]} />
          <meshStandardMaterial color={token('scene-wheel')} />
        </mesh>)))}
      {flag && (
        <>
          <mesh position={[-0.1, 0.3, 0.06]}><cylinderGeometry args={[0.006, 0.006, 0.3, 6]} /><meshStandardMaterial color={token('scene-robot-trim')} /></mesh>
          <mesh position={[-0.07, 0.43, 0.06]}><boxGeometry args={[0.06, 0.04, 0.005]} /><meshStandardMaterial color={token('scene-flag')} /></mesh>
        </>
      )}
    </group>
  );
}
