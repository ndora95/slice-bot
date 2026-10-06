/* Scene colors come from tokens.css (--scene-*, --status-*, --accent*), never from literals. */
const cache = new Map<string, string>();

export function token(name: string): string {
  if (!cache.has(name)) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    cache.set(name, v || 'gray');
  }
  return cache.get(name)!;
}

export const STATUS_TOKEN: Record<string, string> = {
  active: 'map-robot', fault: 'status-crit', grounded: 'status-crit', in_repair: 'status-warn', charging: 'status-info',
};

/** The city's light. Night is the --map-* set; dusk and day override some of it. */
export type Light = 'day' | 'dusk' | 'night';
export interface MapLook {
  light: Light; bg: string; ground: string; water: string; park: string; roadMinor: string; roadMajor: string; freeway: string;
  building: string; buildingTall: string; landmark: string; label: string; labelStrong: string;
  sky: string; sun: string; sunI: number; sunPos: [number, number, number]; fill: string; hemiI: number; ambientI: number;
  route: string; backup: string; runner: string; stalled: string; robot: string; depot: string; hub: string; pin: string;
}

const looks = new Map<Light, MapLook>();
export function mapLook(light: Light): MapLook {
  if (looks.has(light)) return looks.get(light)!;
  const pick = (name: string) => (light === 'night' ? '' : token(`map-${light}-${name}`) === 'gray' ? '' : token(`map-${light}-${name}`)) || token(`map-${name}`);
  const look: MapLook = {
    light, bg: pick('bg'), ground: pick('ground'), water: pick('water'), park: pick('park'),
    roadMinor: pick('road-minor'), roadMajor: pick('road-major'), freeway: pick('freeway'),
    building: pick('building'), buildingTall: pick('building-tall'), landmark: pick('landmark'),
    label: pick('label'), labelStrong: pick('label-strong'), sky: pick('sky'), sun: pick('sun'), fill: pick('fill'),
    sunI: light === 'day' ? 1.7 : light === 'dusk' ? 1.5 : 1.1,
    sunPos: light === 'day' ? [5, 12, 6] : light === 'dusk' ? [-10, 3.2, 3] : [5, 11, 7],
    hemiI: light === 'day' ? 1.05 : light === 'dusk' ? 0.7 : 0.75, ambientI: light === 'day' ? 0.55 : 0.35,
    route: pick('route'), backup: pick('route-backup'), runner: pick('route-runner'), stalled: token('map-route-stalled'),
    robot: pick('robot'), depot: token('map-depot'), hub: token('scene-hub'), pin: token('map-pin-customer'),
  };
  looks.set(light, look);
  return look;
}

/** The light for an in-app clock time: day through the afternoon, dusk for the dinner rush, night after. */
export function lightAt(clock?: string | null): Light {
  if (!clock) return 'night';
  const h = Number(clock.slice(11, 13)) + Number(clock.slice(14, 16)) / 60;
  return h >= 7 && h < 16.5 ? 'day' : h >= 16.5 && h < 20 ? 'dusk' : 'night';
}
