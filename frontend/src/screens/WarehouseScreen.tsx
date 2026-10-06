import { useApp } from '../App';
import { Kicker, Panel, Pill, Skeleton } from '../components/ui';
import { useApi } from '../lib/hooks';

interface Bin { sku: string; location_id: string; location_name: string; bin: string; qty_on_hand: number; qty_reserved: number;
  reorder_point: number; name: string; part_key: string; unit_cost: number }

export default function WarehouseScreen() {
  const { tick } = useApp();
  const { data } = useApi<Bin[]>('/api/inventory', tick);
  if (!data) return <Skeleton className="h-96" />;
  const locs = Array.from(new Set(data.map((b) => b.location_name)));
  return (
    <div className="flex flex-col gap-s4">
      {locs.map((loc, li) => {
        const bins = data.filter((b) => b.location_name === loc);
        return (
          <Panel key={loc} kicker={`${loc} · ${bins.length} bins`} delay={li * 0.05}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-s2">
              {bins.map((b) => {
                const free = b.qty_on_hand - b.qty_reserved;
                const tone = b.qty_on_hand === 0 ? 'crit' : free < b.reorder_point ? 'warn' : null;
                return (
                  <div key={`${b.sku}${b.bin}`} className={`rounded-card border px-s3 py-s3 flex flex-col gap-1.5
                    ${tone === 'crit' ? 'border-crit bg-crit-fill' : tone === 'warn' ? 'border-warn bg-warn-fill' : 'border-line bg-surface-inset'}`}>
                    <div className="flex items-center justify-between">
                      <Kicker>Bin {b.bin}</Kicker>
                      {tone === 'crit' && <Pill kind="crit">Out</Pill>}
                      {tone === 'warn' && <Pill kind="warn">Reorder</Pill>}
                    </div>
                    <span className="text-smd text-ink-primary">{b.name}</span>
                    <span className="text-xs font-mono text-ink-secondary">{b.sku}</span>
                    <div className="flex items-baseline gap-s2 mt-1">
                      <span className="font-mono text-[24px] font-bold tabular-nums leading-none text-ink-primary">{free}</span>
                      <span className="text-xs font-mono text-ink-secondary">free · {b.qty_on_hand} on hand · {b.qty_reserved} reserved</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
