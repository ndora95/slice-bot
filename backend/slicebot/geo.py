"""Where SliceBot runs: a 2.4 km square of Capitol Hill and Navy Yard in
Washington, DC, mapped onto the 12 x 12 grid the rest of the code uses
(one unit is 200 m, x east, y north).

The streets come from OpenStreetMap (data/dc_map.json, built once by
data/fetch_map.py). Robots route over that street graph with plain
Dijkstra, so every route drawn on the map is a real walkable path.
"""
from __future__ import annotations

import heapq
import json
import math
from functools import lru_cache
from pathlib import Path

# (south, west, north, east): from the Capitol and Eastern Market down to Nationals Park and the Anacostia.
BBOX = (38.8697, -77.0199, 38.8913, -76.9921)
MAP_PATH = Path(__file__).resolve().parent / "data" / "dc_map.json"
WEATHER_PATH = Path(__file__).resolve().parent / "data" / "dc_weather.json"
ROUTABLE = {"major", "minor", "service", "path"}  # sidewalk robots stay off the freeway

# Four delivery zones, split along I-695 and South Capitol Street: (x0, x1, y0, y1).
ZONE_BOUNDS = {
    "Capitol Hill": (0.0, 7.0, 6.5, 12.0),
    "Eastern Market": (7.0, 12.0, 6.5, 12.0),
    "Southwest Waterfront": (0.0, 5.0, 0.0, 6.5),
    "Navy Yard": (5.0, 12.0, 0.0, 6.5),
}
ZONES = list(ZONE_BOUNDS)

# Street-graph nodes (snapped once) for the places robots start and end their trips.
HUB_XY = (7.71, 4.688)       # SliceBot Kitchen Hub, 3rd St SE by Canal Park
NORTH_XY = (10.499, 9.218)   # Eastern Market repair depot
SOUTH_XY = (9.052, 2.889)    # Navy Yard repair depot, Tingey St SE


def zone_of(x: float, y: float) -> str:
    for name, (x0, x1, y0, y1) in ZONE_BOUNDS.items():
        if x0 <= x <= x1 and y0 <= y <= y1:
            return name
    return "Navy Yard"


SHORT = [(" Street", " St"), (" Avenue", " Ave"), (" Place", " Pl"), (" Drive", " Dr"), (" Terrace", " Ter"),
         (" Court", " Ct"), ("Southeast", "SE"), ("Southwest", "SW"), ("Northeast", "NE"), ("Northwest", "NW")]


def short_street(name: str) -> str:
    for a, b in SHORT:
        name = name.replace(a, b)
    return name


def to_grid(lat: float, lon: float) -> tuple[float, float]:
    s, w, n, e = BBOX
    return (lon - w) / (e - w) * 12, (lat - s) / (n - s) * 12


def to_latlon(x: float, y: float) -> tuple[float, float]:
    s, w, n, e = BBOX
    return s + y / 12 * (n - s), w + x / 12 * (e - w)


@lru_cache(maxsize=1)
def city_map() -> dict:
    return json.loads(MAP_PATH.read_text())


WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog", 51: "Light drizzle",
       53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow",
       73: "Snow", 75: "Heavy snow", 80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorm"}


def weather_at(hour: int) -> dict | None:
    """Weather at the Hub for one hour of the demo day, or None if it was never fetched."""
    if not WEATHER_PATH.exists():
        return None
    w = json.loads(WEATHER_PATH.read_text())
    h = next((x for x in w["hours"] if x["hour"] == hour), None)
    if not h:
        return None
    return {**h, "summary": WMO.get(h["code"], "Unsettled"), "kind": w["kind"], "fetched": w["fetched"],
            "source": w["source"]}


def _key(p) -> tuple[float, float]:
    return (round(p[0], 3), round(p[1], 3))


class Streets:
    """The walkable street graph, its largest connected piece only."""

    def __init__(self, roads: list[dict]):
        adj: dict[tuple, dict[tuple, float]] = {}
        self.names: dict[tuple, str] = {}
        for r in roads:
            if r["k"] not in ROUTABLE:
                continue
            pts = [_key(p) for p in r["p"]]
            for a, b in zip(pts, pts[1:]):
                if a == b:
                    continue
                d = math.dist(a, b)
                adj.setdefault(a, {})[b] = d
                adj.setdefault(b, {})[a] = d
                if r.get("n"):
                    self.names.setdefault(a, r["n"])
                    self.names.setdefault(b, r["n"])
        # Keep the biggest component so every pair of nodes has a route.
        seen, best = set(), set()
        for start in adj:
            if start in seen:
                continue
            comp, stack = {start}, [start]
            while stack:
                for nb in adj[stack.pop()]:
                    if nb not in comp:
                        comp.add(nb)
                        stack.append(nb)
            seen |= comp
            if len(comp) > len(best):
                best = comp
        self.adj = {k: {n: d for n, d in v.items() if n in best} for k, v in adj.items() if k in best}
        self.nodes = [k for k in self.adj if 0 <= k[0] <= 12 and 0 <= k[1] <= 12]

    def snap(self, x: float, y: float) -> tuple[float, float]:
        return min(self.nodes, key=lambda n: (n[0] - x) ** 2 + (n[1] - y) ** 2)

    def route(self, a: tuple[float, float], b: tuple[float, float]) -> list[tuple[float, float]]:
        """Shortest street path between two points (snapped to the graph)."""
        src, dst = self.snap(*a), self.snap(*b)
        if src == dst:
            return [src]
        dist, prev = {src: 0.0}, {}
        q = [(0.0, src)]
        while q:
            d, u = heapq.heappop(q)
            if u == dst:
                break
            if d > dist.get(u, math.inf):
                continue
            for v, w in self.adj[u].items():
                nd = d + w
                if nd < dist.get(v, math.inf):
                    dist[v], prev[v] = nd, u
                    heapq.heappush(q, (nd, v))
        path, cur = [dst], dst
        while cur != src:
            cur = prev[cur]
            path.append(cur)
        return list(reversed(path))

    def street_name(self, x: float, y: float) -> str:
        n = self.snap(x, y)
        if n in self.names:
            return self.names[n]
        near = min(self.names, key=lambda k: (k[0] - x) ** 2 + (k[1] - y) ** 2, default=None)
        return self.names[near] if near else ""

    def nodes_in(self, zone: str) -> list[tuple[float, float]]:
        x0, x1, y0, y1 = ZONE_BOUNDS[zone]
        # A margin keeps homes off the zone edge and out of the river along the south side.
        return [n for n in self.nodes if x0 + 0.25 <= n[0] <= x1 - 0.25 and max(y0, 0.9) <= n[1] <= y1 - 0.25
                and n in self.names and "Trail" not in self.names[n]]


@lru_cache(maxsize=1)
def streets() -> Streets:
    return Streets(city_map()["roads"])


def length(path: list[tuple[float, float]]) -> float:
    return sum(math.dist(a, b) for a, b in zip(path, path[1:]))


def point_along(path: list[tuple[float, float]], frac: float) -> tuple[float, float]:
    """The point `frac` (0..1) of the way along a polyline."""
    total = length(path)
    if total == 0 or len(path) == 1:
        return path[0]
    target = max(0.0, min(1.0, frac)) * total
    for a, b in zip(path, path[1:]):
        seg = math.dist(a, b)
        if target <= seg:
            t = target / seg if seg else 0
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        target -= seg
    return path[-1]


@lru_cache(maxsize=4096)
def _street_units(a: tuple[float, float], b: tuple[float, float]) -> float:
    return length(streets().route(a, b))


def street_km(a: tuple[float, float], b: tuple[float, float], km_per_unit: float = 0.2) -> float:
    """Walking distance over the real street graph."""
    st = streets()
    return _street_units(st.snap(*a), st.snap(*b)) * km_per_unit
