"""Download the real streets, buildings, parks, and water of Capitol Hill and
Navy Yard (Washington, DC) from OpenStreetMap, plus the Open-Meteo weather for
the demo day, and save them as compact JSON. Run once; the results are
committed, so the demo never needs a network:

    python -m slicebot.data.fetch_map [--cache DIR] [--weather-only]

Map data (c) OpenStreetMap contributors, ODbL. Weather: Open-Meteo, CC BY 4.0.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

from datetime import date

from slicebot.config import SIM_NOW
from slicebot.geo import BBOX, MAP_PATH, WEATHER_PATH, to_grid, to_latlon

API = "https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}"
TILE_LON, TILE_LAT = 0.0050, 0.0045
PAD = 0.6  # grid units kept beyond the edge so streets run off the map instead of stopping at it

ROAD_KIND = {
    "motorway": "freeway", "motorway_link": "freeway", "trunk": "major", "trunk_link": "major",
    "primary": "major", "primary_link": "major", "secondary": "major", "secondary_link": "major",
    "tertiary": "minor", "tertiary_link": "minor", "residential": "minor", "unclassified": "minor",
    "living_street": "minor", "pedestrian": "path", "service": "service",
}
LANDMARKS = {  # OSM name -> label on the map
    "United States Capitol": "US Capitol",
    "Nationals Park": "Nationals Park",
    "Eastern Market": "Eastern Market",
    "Library of Congress, Thomas Jefferson Building": "Library of Congress",
    "Supreme Court of the United States": "Supreme Court",
    "The Yards Park": "Yards Park",
    "Canal Park": "Canal Park",
    "Garfield Park": "Garfield Park",
    "Marine Barracks Washington": "Marine Barracks",
    "Folger Park": "Folger Park",
}


def fetch_tiles(cache: Path) -> list[Path]:
    s, w, n, e = BBOX
    out = []
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            f = cache / f"tile_{lat:.4f}_{lon:.4f}.osm"
            if not f.exists() or f.stat().st_size < 1000:
                url = API.format(w=f"{lon:.5f}", s=f"{lat:.5f}", e=f"{min(lon + TILE_LON, e):.5f}",
                                 n=f"{min(lat + TILE_LAT, n):.5f}")
                # curl, not urllib: it uses the system trust store, which python.org builds on macOS lack.
                subprocess.run(["curl", "-sSf", "-m", "120", "-A", "slicebot-demo/1.0 (one-off map export)",
                                "-o", str(f), url], check=True)
                print(f"  fetched {f.name} ({f.stat().st_size // 1024} KB)")
                time.sleep(1.0)  # be polite to the public API
            out.append(f)
            lon += TILE_LON
        lat += TILE_LAT
    return out


def parse(tiles: list[Path]):
    nodes, ways, rels = {}, {}, {}
    for f in tiles:
        root = ET.parse(f).getroot()
        for el in root:
            if el.tag == "node":
                nodes[el.get("id")] = (float(el.get("lat")), float(el.get("lon")))
            elif el.tag == "way":
                ways[el.get("id")] = ([nd.get("ref") for nd in el.findall("nd")],
                                      {t.get("k"): t.get("v") for t in el.findall("tag")})
            elif el.tag == "relation":
                rels[el.get("id")] = ([(m.get("type"), m.get("ref"), m.get("role")) for m in el.findall("member")],
                                      {t.get("k"): t.get("v") for t in el.findall("tag")})
    return nodes, ways, rels


def _pt(nodes, ref):
    ll = nodes.get(ref)
    if not ll:
        return None
    x, y = to_grid(*ll)
    return [round(x, 3), round(y, 3)]


def _inside(p, pad=PAD):
    return -pad <= p[0] <= 12 + pad and -pad <= p[1] <= 12 + pad


def _line(nodes, refs) -> list[list[list[float]]]:
    """Polyline in grid units, split where it leaves the padded map."""
    parts, cur = [], []
    for ref in refs:
        p = _pt(nodes, ref)
        if p and _inside(p):
            cur.append(p)
        elif cur:
            parts.append(cur)
            cur = []
    if cur:
        parts.append(cur)
    return [c for c in parts if len(c) >= 2]


def _ring(nodes, refs):
    pts = [p for p in (_pt(nodes, r) for r in refs) if p]
    if len(pts) >= 2 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts if len(pts) >= 3 else None


def _centroid(pts):
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def _height_m(tags) -> float:
    for k in ("height", "building:height"):
        try:
            return float(tags[k].replace("m", "").strip())
        except (KeyError, ValueError):
            pass
    try:
        return float(tags["building:levels"]) * 3.4 + 1.5
    except (KeyError, ValueError):
        return 0.0  # unknown: the renderer picks a rowhouse height


def _join_rings(nodes, ways, refs: list[str]) -> list[list[list[float]]]:
    """Join the outer ways of a multipolygon into closed rings."""
    segs = [list(ways[r][0]) for r in refs if r in ways]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += list(reversed(s))[1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = list(reversed(s))[:-1] + ring
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        r = _ring(nodes, ring)
        if r:
            rings.append(r)
    return rings


def build(nodes, ways, rels) -> dict:
    roads, buildings, parks, water, stadiums, landmarks = [], [], [], [], [], []
    seen = set()

    def landmark(tags, ring):
        label = LANDMARKS.get(tags.get("name", ""))
        if not label or label in seen:
            return None
        seen.add(label)
        c = _centroid(ring)
        landmarks.append({"name": label, "x": round(c[0], 3), "y": round(c[1], 3)})
        return label

    def area(tags, ring):
        c = _centroid(ring)
        if "building" in tags:
            if not _inside(c, 0.1):
                return
            b = {"h": round(_height_m(tags), 1), "p": ring}
            if label := landmark(tags, ring):
                b["landmark"] = label
            buildings.append(b)
        elif tags.get("leisure") == "stadium":
            if _inside(c, 0.1):
                stadiums.append(ring)
                landmark(tags, ring)
        elif tags.get("leisure") in ("park", "garden", "pitch") or tags.get("landuse") in ("grass", "recreation_ground"):
            if _inside(c, 1.0):
                parks.append(ring)
                landmark(tags, ring)
        elif tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
            water.append(ring)

    for refs, tags in ways.values():
        hw = tags.get("highway")
        if hw in ROAD_KIND:
            if hw == "service" and tags.get("service") not in (None, "alley"):
                continue
            if tags.get("area") == "yes":
                continue
            for part in _line(nodes, refs):
                roads.append({"k": ROAD_KIND[hw], "n": tags.get("name", ""), "p": part})
            continue
        if refs and refs[0] == refs[-1] and (ring := _ring(nodes, refs)):
            area(tags, ring)
    for members, tags in rels.values():
        if tags.get("type") != "multipolygon":
            continue
        outer = [ref for typ, ref, role in members if typ == "way" and role in ("outer", "")]
        for ring in _join_rings(nodes, ways, outer):
            area(tags, ring)
    return {"source": "OpenStreetMap contributors (ODbL)", "bbox": BBOX, "roads": roads, "buildings": buildings,
            "parks": parks, "water": water, "stadiums": stadiums, "landmarks": landmarks}


WEATHER = ("https://api.open-meteo.com/v1/forecast?latitude={lat:.4f}&longitude={lon:.4f}&hourly=temperature_2m,"
           "precipitation_probability,precipitation,weather_code,wind_speed_10m&temperature_unit=fahrenheit"
           "&wind_speed_unit=mph&timezone=America%2FNew_York&start_date={day}&end_date={day}")


def fetch_weather() -> None:
    """Hourly weather at the Hub on the simulated day: a forecast until that day, observed after."""
    lat, lon = to_latlon(6, 6)
    day = SIM_NOW.date().isoformat()
    raw = subprocess.run(["curl", "-sSf", "-m", "60", WEATHER.format(lat=lat, lon=lon, day=day)],
                         check=True, capture_output=True).stdout
    h = json.loads(raw)["hourly"]
    hours = [{"hour": int(t[11:13]), "temp_f": h["temperature_2m"][i], "precip_prob": h["precipitation_probability"][i],
              "precip_in": h["precipitation"][i], "code": h["weather_code"][i], "wind_mph": h["wind_speed_10m"][i]}
             for i, t in enumerate(h["time"])]
    fetched = date.today().isoformat()
    WEATHER_PATH.write_text(json.dumps({"source": "Open-Meteo (CC BY 4.0)", "day": day, "fetched": fetched,
                                        "kind": "forecast" if fetched < day else "observed", "hours": hours}))
    print(f"wrote {WEATHER_PATH} ({day}, fetched {fetched})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "slicebot-osm"))
    ap.add_argument("--weather-only", action="store_true")
    args = ap.parse_args()
    fetch_weather()
    if args.weather_only:
        return
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    tiles = fetch_tiles(cache)
    data = build(*parse(tiles))
    MAP_PATH.write_text(json.dumps(data, separators=(",", ":")))
    print(f"{len(data['roads'])} road segments, {len(data['buildings'])} buildings, {len(data['parks'])} parks, "
          f"{len(data['water'])} water areas, {len(data['stadiums'])} stadiums, landmarks: {[l['name'] for l in data['landmarks']]}")
    print(f"wrote {MAP_PATH} ({MAP_PATH.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
