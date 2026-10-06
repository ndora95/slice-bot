"""Build the SliceBot company: a DuckDB file standing in for Snowflake, plus
generated transcripts and case notes for the document search.

The streets, homes, and routes are real (OpenStreetMap, Capitol Hill and Navy
Yard in Washington, DC; see geo.py). The company, customers, robots, and
orders are generated. Deterministic (fixed seed, one random stream per table),
so every run produces the same IDs and the same hero stories. Rebuild with:

    python -m slicebot.data.generate
"""
from __future__ import annotations

import csv
import json
import random
import shutil
from datetime import datetime, timedelta

import duckdb

from slicebot import geo
from slicebot.config import DATA_DIR, DB_PATH, GENERATED_CORPUS, SEED, SIM_NOW
from slicebot.geo import HUB_XY, NORTH_XY, SOUTH_XY, ZONES

TODAY = SIM_NOW.replace(hour=0, minute=0)

ZONE_DEMAND = {"Capitol Hill": 0.8, "Eastern Market": 0.9, "Southwest Waterfront": 1.0, "Navy Yard": 1.2}
DEPOTS = [
    ("HUB", "Kitchen Hub", "warehouse", *HUB_XY),
    ("NORTH", "Eastern Market Depot", "repair", *NORTH_XY),
    ("SOUTH", "Navy Yard Depot", "repair", *SOUTH_XY),
]
ZONE_DEPOT = {"Capitol Hill": "NORTH", "Eastern Market": "NORTH", "Southwest Waterfront": "SOUTH", "Navy Yard": "SOUTH"}
ROBOT_KPH = 7.0
KM_PER_UNIT = 0.2

MENU = [
    ("Margherita (L)", 16.00), ("Margherita (M)", 12.00), ("Pepperoni (L)", 17.50),
    ("Pepperoni (M)", 13.00), ("Veggie Supreme (L)", 18.50), ("BBQ Chicken (L)", 19.00),
    ("Garlic Knots", 6.50), ("Caesar Salad", 8.00), ("Lemonade", 3.00),
    ("Soda", 2.50), ("Cookie", 2.75),
]
HOT_ITEMS = {"Margherita (L)", "Margherita (M)", "Pepperoni (L)", "Pepperoni (M)",
             "Veggie Supreme (L)", "BBQ Chicken (L)", "Garlic Knots"}
# The full menu the Menu bot recommends from. MENU above stays as it is because order
# generation draws from it, and changing it would reshuffle every seeded order.
MENU_CATALOG = [
    # item_id, name, category, price, serves, description, tags, allergens
    ("P-MARG-L", "Margherita (L)", "pizza", 16.00, 3, "Classic cheese pizza with tomato, mozzarella, and basil.",
     "vegetarian,kid_friendly", "gluten,dairy"),
    ("P-MARG-M", "Margherita (M)", "pizza", 12.00, 2, "Classic cheese pizza with tomato, mozzarella, and basil.",
     "vegetarian,kid_friendly", "gluten,dairy"),
    ("P-PEPP-L", "Pepperoni (L)", "pizza", 17.50, 3, "Pepperoni and mozzarella, the crowd favorite.",
     "kid_friendly", "gluten,dairy"),
    ("P-PEPP-M", "Pepperoni (M)", "pizza", 13.00, 2, "Pepperoni and mozzarella, the crowd favorite.",
     "kid_friendly", "gluten,dairy"),
    ("P-VEG-L", "Veggie Supreme (L)", "pizza", 18.50, 3, "Peppers, mushrooms, onions, olives, and mozzarella.",
     "vegetarian", "gluten,dairy"),
    ("P-BBQ-L", "BBQ Chicken (L)", "pizza", 19.00, 3, "Smoky barbecue chicken, red onion, and cilantro.",
     "", "gluten,dairy"),
    ("P-VGN-L", "Vegan Garden (L)", "pizza", 18.00, 3, "Roasted vegetables and soy-based cheese, no dairy.",
     "vegetarian,vegan", "gluten,soy"),
    ("P-GF-M", "Gluten-Free Margherita (M)", "pizza", 14.50, 2, "Margherita on a certified gluten-free crust.",
     "vegetarian,gluten_free,kid_friendly", "dairy"),
    ("P-PEST-L", "Pesto Chicken (L)", "pizza", 19.50, 3, "Basil pine nut pesto, roast chicken, and mozzarella.",
     "", "gluten,dairy,tree_nuts"),
    ("P-HOT-L", "Hot Honey Soppressata (L)", "pizza", 19.00, 3, "Spicy soppressata, chili hot honey, and mozzarella.",
     "spicy", "gluten,dairy"),
    ("S-KNOT", "Garlic Knots", "side", 6.50, 2, "Six warm garlic knots with marinara for dipping.",
     "vegetarian,kid_friendly", "gluten,dairy"),
    ("S-CAES", "Caesar Salad", "side", 8.00, 2, "Romaine, parmesan, croutons, and anchovy Caesar dressing.",
     "", "gluten,dairy,egg,fish"),
    ("S-CAUL", "Buffalo Cauliflower Bites", "side", 7.50, 2, "Crispy cauliflower tossed in spicy buffalo sauce.",
     "vegetarian,vegan,gluten_free,spicy", "soy"),
    ("D-LEMN", "Lemonade", "drink", 3.00, 1, "Fresh lemonade.", "vegetarian,vegan,gluten_free,kid_friendly", ""),
    ("D-SODA", "Soda", "drink", 2.50, 1, "Cola, diet cola, or lemon-lime soda.", "vegetarian,vegan,gluten_free", ""),
    ("D-SPRK", "Sparkling Water", "drink", 2.00, 1, "Sparkling mineral water.", "vegetarian,vegan,gluten_free", ""),
    ("X-COOK", "Cookie", "dessert", 2.75, 1, "Chocolate chip cookie, baked fresh.", "vegetarian,kid_friendly",
     "gluten,dairy,egg"),
    ("X-BROW", "Walnut Brownie", "dessert", 3.50, 1, "Fudgy chocolate brownie with walnuts.", "vegetarian",
     "gluten,dairy,egg,tree_nuts"),
]

# part_key matches the mesh names in the 3D robot on the front end.
PARTS = [
    # sku, name, part_key, skill, repair_min, unit_cost
    ("WM-110", "Drive wheel motor", "wheel_motor", "drive", 45, 84.00),
    ("TR-115", "Wheel tire", "tire", "drive", 15, 12.00),
    ("BP-400", "Battery pack", "battery_pack", "battery", 30, 210.00),
    ("HE-205", "Warming box heater", "heater", "heater", 35, 46.00),
    ("LS-220", "Lid seal gasket", "lid_seal", "seal", 20, 9.50),
    ("LL-150", "Lid lock actuator", "lid_lock", "body", 25, 38.00),
    ("CM-310", "Camera mast module", "camera_mast", "sensors", 40, 165.00),
    ("MB-500", "Mainboard", "mainboard", "compute", 50, 240.00),
    ("BM-120", "Front bumper", "bumper", "body", 15, 22.00),
    ("FL-010", "Safety flag", "flag", "body", 5, 4.00),
]
INVENTORY = [
    # sku, location, bin, on_hand, reorder_point
    ("WM-110", "HUB", "A-2", 6, 2), ("WM-110", "SOUTH", "S-1", 1, 0),
    ("TR-115", "HUB", "A-3", 18, 6), ("BP-400", "HUB", "B-1", 3, 2),
    ("HE-205", "HUB", "C-2", 4, 2), ("LS-220", "HUB", "C-4", 12, 4),
    ("LL-150", "HUB", "C-1", 2, 1), ("CM-310", "HUB", "D-1", 0, 1),
    ("CM-310", "NORTH", "N-2", 1, 0), ("MB-500", "HUB", "D-3", 2, 1),
    ("BM-120", "HUB", "A-4", 5, 2), ("FL-010", "HUB", "A-1", 20, 5),
]
MECHANICS = [
    # id, name, depot, skills, shift start, shift end (hours today)
    ("M-01", "Maria Okafor", "NORTH", "drive,seal,body", 8.0, 16.5),
    ("M-02", "Dev Patel", "NORTH", "battery,compute,heater", 10.0, 18.5),
    ("M-03", "Sam Rivera", "NORTH", "drive,sensors", 13.0, 21.5),
    ("M-04", "Lena Fischer", "SOUTH", "seal,heater,body", 9.0, 17.5),
    ("M-05", "Theo Brooks", "SOUTH", "sensors,battery,compute", 12.0, 20.5),
    ("M-06", "Ana Lima", "SOUTH", "drive,tire,battery,heater,seal,body,sensors,compute", 8.0, 16.5),
]

FIRST = ["Ava", "Liam", "Noah", "Emma", "Olivia", "Elijah", "Sofia", "Mateo", "Zoe", "Ethan",
         "Isla", "Leo", "Nora", "Ezra", "Ruby", "Kai", "Lucy", "Omar", "Hana", "Felix",
         "Aria", "Theo", "Mila", "Jonah", "Iris", "Caleb", "Nina", "Rafael", "June", "Owen"]
LAST = ["Nguyen", "Garcia", "Kowalski", "Okafor", "Silva", "Haddad", "Johansson", "Moreau",
        "Tanaka", "Reyes", "Novak", "Mensah", "Lindqvist", "Costa", "Barnes", "Ito",
        "Delgado", "Fischer", "Osei", "Romano", "Park", "Ahmed", "Larsen", "Vega"]
HEROES = {
    "maya": {"customer_id": "C-1042", "name": "Maya Chen", "zone": "Eastern Market", "order_id": "O-58213", "robot_id": "SB-003"},
    "jordan": {"customer_id": "C-2077", "name": "Jordan Ellis", "zone": "Southwest Waterfront", "order_id": "O-58240"},
    "priya": {"customer_id": "C-3310", "name": "Priya Raman", "zone": "Navy Yard", "order_id": "O-58198", "robot_id": "SB-011"},
    "marcus": {"customer_id": "C-4188", "name": "Marcus Webb", "zone": "Capitol Hill", "order_id": "O-58177", "robot_id": "SB-005"},
}
# Twelve robots. The four M2-B07 robots with worn lid seals are the fleet pattern the cold-pizza story finds.
FLEET = [
    # robot, model, batch, zone, status, activity
    ("SB-001", "M3", "M3-B01", "Capitol Hill", "active", "delivering"),
    ("SB-002", "M3", "M3-B01", "Navy Yard", "grounded", "in_depot"),        # LID_ACT, lid actuator waiting
    ("SB-003", "M3", "M3-B01", "Eastern Market", "fault", "stopped"),       # stalled on Maya's order
    ("SB-004", "M3", "M3-B01", "Eastern Market", "active", "idle"),         # the obvious backup
    ("SB-005", "M2", "M2-B05", "Capitol Hill", "active", "returning"),
    ("SB-006", "M2", "M2-B05", "Capitol Hill", "in_repair", "in_depot"),    # battery swap under way
    ("SB-007", "M2", "M2-B05", "Eastern Market", "grounded", "in_depot"),   # CAM_LOSS
    ("SB-008", "M2", "M2-B07", "Southwest Waterfront", "active", "idle"),   # seal already replaced
    ("SB-009", "M2", "M2-B07", "Navy Yard", "active", "delivering"),
    ("SB-010", "M2", "M2-B07", "Southwest Waterfront", "active", "delivering"),
    ("SB-011", "M2", "M2-B07", "Navy Yard", "active", "returning"),         # brought Priya's pizza cold
    ("SB-012", "M2", "M2-B07", "Capitol Hill", "active", "delivering"),
]
B07_AFFECTED = ["SB-009", "SB-010", "SB-011", "SB-012"]
B07_FIXED = ["SB-008"]


def hours(h: float) -> datetime:
    return TODAY + timedelta(hours=h)


def street_point(rng: random.Random, zone: str) -> tuple[float, float]:
    """A real street corner or curb point in the zone."""
    return rng.choice(geo.streets().nodes_in(zone))


def address_at(rng: random.Random, x: float, y: float) -> str:
    return f"{rng.randint(1, 12) * 100 + rng.randint(0, 48) * 2 + rng.randint(0, 1)} " \
           f"{geo.short_street(geo.streets().street_name(x, y))}"


def trip_minutes(path) -> float:
    return geo.length(path) * KM_PER_UNIT / ROBOT_KPH * 60


def demand(hour: float, zone: str) -> float:
    if 11 <= hour < 14:
        base = 12
    elif 17 <= hour < 21:
        base = 18
    elif 14 <= hour < 17:
        base = 4
    elif 21 <= hour < 23:
        base = 6
    elif 10 <= hour < 11:
        base = 4
    else:
        base = 1
    return round(base * ZONE_DEMAND[zone], 1)


# ---------------------------------------------------------------- builders

def build_robots(rng: random.Random) -> list[dict]:
    depot_xy = {"HUB": HUB_XY, "NORTH": NORTH_XY, "SOUTH": SOUTH_XY}
    robots = []
    for rid, model, batch, zone, status, activity in FLEET:
        x, y = street_point(rng, zone)  # moving robots are placed on their route in build_live
        robots.append({
            "robot_id": rid, "model": model, "batch": batch,
            "firmware": "4.2.1", "status": status, "activity": activity,
            "zone": zone, "x": x, "y": y, "home_depot": ZONE_DEPOT[zone],
            "battery_pct": rng.randint(52, 96), "battery_health": rng.randint(78, 99),
            "lid_cycles": rng.randint(400, 1300) if model == "M3" else rng.randint(1400, 2600),
            "commissioned": (TODAY - timedelta(days=rng.randint(120, 520))).date(),
            "last_service": (TODAY - timedelta(days=rng.randint(3, 60))).date(),
            "fault_code": None,
        })
    by_id = {r["robot_id"]: r for r in robots}
    by_id["SB-003"].update(fault_code="MTR_STALL_L2", battery_pct=71)
    by_id["SB-004"].update(battery_pct=88)
    by_id["SB-008"].update(x=HUB_XY[0], y=HUB_XY[1], battery_pct=93)  # parked at the Hub
    by_id["SB-006"].update(battery_health=64)
    by_id["SB-007"].update(fault_code="CAM_LOSS")
    by_id["SB-002"].update(fault_code="LID_ACT")
    for rid in ("SB-002", "SB-006", "SB-007"):
        by_id[rid]["x"], by_id[rid]["y"] = depot_xy[by_id[rid]["home_depot"]]
    for rid in B07_AFFECTED:
        by_id[rid]["lid_cycles"] = rng.randint(1520, 1980)
    return robots


def build_customers(rng: random.Random) -> list[dict]:
    ids = {h["customer_id"] for h in HEROES.values()}
    while len(ids) < 300:
        ids.add(f"C-{rng.randint(1000, 4999)}")
    heroes = {h["customer_id"]: h for h in HEROES.values()}
    customers = []
    for cid in sorted(ids):
        if cid in heroes:
            name, zone = heroes[cid]["name"], heroes[cid]["zone"]
        else:
            name, zone = f"{rng.choice(FIRST)} {rng.choice(LAST)}", rng.choice(ZONES)
        customers.append(_customer(rng, cid, name, zone))
    for c in customers:
        if c["customer_id"] in ("C-1042", "C-3310", "C-4188"):
            c["app_user"] = True
        if c["customer_id"] == "C-4188":
            c["plan"] = "SlicePass"  # free delivery, so the party order totals $84.60
    # Maya lives a little over a kilometre from the Hub, so her stalled robot is a few blocks short of her door.
    maya = next(c for c in customers if c["customer_id"] == "C-1042")
    far = [n for n in geo.streets().nodes_in("Eastern Market")
           if 6.0 <= geo.length(geo.streets().route(HUB_XY, n)) <= 6.6]
    maya["x"], maya["y"] = rng.choice(sorted(far))
    maya["address"] = address_at(rng, maya["x"], maya["y"])
    return customers


def _customer(rng: random.Random, cid: str, name: str, zone: str) -> dict:
    first, last = name.lower().split(" ", 1)
    x, y = street_point(rng, zone)
    return {
        "customer_id": cid, "name": name,
        "email": f"{first}.{last.replace(' ', '')}@example.com",
        "phone": f"(555) 01{rng.randint(0, 99):02d}-{rng.randint(1000, 9999)}",
        "address": address_at(rng, x, y),
        "zone": zone, "plan": "SlicePass" if rng.random() < 0.35 else "Standard",
        "member_since": (TODAY - timedelta(days=rng.randint(20, 900))).date(),
        "app_user": rng.random() < 0.8, "x": x, "y": y,
    }


def pick_items(rng: random.Random, n_pizzas: int = 1) -> list[dict]:
    pizzas = [m for m in MENU if "(" in m[0]]
    sides = [m for m in MENU if "(" not in m[0]]
    items = [rng.choice(pizzas) for _ in range(n_pizzas)]
    items += rng.sample(sides, rng.randint(0, 2))
    return [{"name": n, "price": p} for n, p in items]


def money(x: float) -> float:
    return round(x + 1e-9, 2)


def make_order(oid, cust, placed, rng, robots_in_zone, items=None, minutes=None, tip=None, robot_id=None,
               status="delivered"):
    items = items or pick_items(rng, rng.choice([1, 1, 1, 2]))
    subtotal = money(sum(i["price"] for i in items))
    fee = 0.0 if cust["plan"] == "SlicePass" and subtotal > 15 else 2.99
    tip = tip if tip is not None else rng.choice([0, 0, 1, 2, 2, 3, 4, 5])
    total = money(subtotal + fee + tip)
    promised = placed + timedelta(minutes=30)
    minutes = minutes if minutes is not None else max(14, int(rng.gauss(26, 6)))
    if minutes is not None and rng.random() < 0.06 and status == "delivered" and robot_id is None:
        minutes += rng.randint(16, 40)
    delivered = placed + timedelta(minutes=minutes) if status == "delivered" else None
    robot = robot_id or rng.choice(robots_in_zone)["robot_id"]
    return {
        "order_id": oid, "customer_id": cust["customer_id"], "zone": cust["zone"], "robot_id": robot,
        "placed_at": placed, "promised_at": promised, "delivered_at": delivered, "status": status,
        "items": json.dumps(items), "subtotal": subtotal, "delivery_fee": fee, "tip": tip, "total": total,
    }


def build_orders(rng, customers, robots):
    by_zone = {z: [r for r in robots if r["zone"] == z and r["status"] == "active"] for z in ZONES}
    cust_by_id = {c["customer_id"]: c for c in customers}
    hero_oids = {h["order_id"] for h in HEROES.values()}
    orders = []
    # Background: 30 days of history plus this morning.
    start = TODAY - timedelta(days=30)
    times = []
    while len(times) < 1196:
        t = start + timedelta(minutes=rng.randint(0, int((SIM_NOW - start).total_seconds() // 60) - 45))
        h = t.hour + t.minute / 60
        if rng.random() < demand(h, "Navy Yard") / 21.6:
            times.append(t)
    times.sort()
    oid_n = 57001
    for t in times:
        while f"O-{oid_n}" in hero_oids:
            oid_n += 1
        cust = rng.choice(customers)
        orders.append(make_order(f"O-{oid_n}", cust, t, rng, by_zone[cust["zone"]]))
        oid_n += 1

    # Hero 2 (Jordan): delivered two days ago. Looks double charged; it is a hold.
    jordan = cust_by_id["C-2077"]
    orders.append(make_order("O-58240", jordan, datetime(2026, 10, 4, 18, 31), rng, by_zone["Southwest Waterfront"],
                             items=[{"name": "BBQ Chicken (L)", "price": 19.00}, {"name": "Caesar Salad", "price": 8.00},
                                    {"name": "Garlic Knots", "price": 6.50}],
                             minutes=24, tip=2.01))
    # Hero 4 (Marcus): $84.60 party order, 50 minutes late at lunch.
    marcus = cust_by_id["C-4188"]
    orders.append(make_order("O-58177", marcus, hours(11 + 42 / 60), rng, by_zone["Capitol Hill"],
                             items=[{"name": "Pepperoni (L)", "price": 17.50}, {"name": "Pepperoni (L)", "price": 17.50},
                                    {"name": "Margherita (L)", "price": 16.00}, {"name": "Veggie Supreme (L)", "price": 18.50},
                                    {"name": "Garlic Knots", "price": 6.50}, {"name": "Soda", "price": 2.50}],
                             minutes=80, tip=6.10, robot_id="SB-005"))
    # Hero 3 (Priya): delivered by SB-011 (batch M2-B07), arrived cold.
    priya = cust_by_id["C-3310"]
    orders.append(make_order("O-58198", priya, hours(12 + 48 / 60), rng, by_zone["Navy Yard"],
                             items=[{"name": "Pepperoni (L)", "price": 17.50}, {"name": "Lemonade", "price": 3.00}],
                             minutes=36, tip=2.00, robot_id="SB-011"))
    # Hero 1 (Maya): on SB-003, which stalled en route.
    maya = cust_by_id["C-1042"]
    orders.append(make_order("O-58213", maya, hours(13 + 8 / 60), rng, by_zone["Eastern Market"],
                             items=[{"name": "Margherita (L)", "price": 16.00}, {"name": "Garlic Knots", "price": 6.50}],
                             tip=0.0, robot_id="SB-003", status="delayed"))
    orders.sort(key=lambda o: o["placed_at"])
    return orders


def build_live(rng: random.Random, robots: list[dict], customers: list[dict]):
    """What the map shows at SIM_NOW: pizzas in the oven, orders waiting for a robot, and the real
    street route each moving robot is on. Live orders go to their own customers (C-6xxx), so the
    eval set's customers keep the order history it was written against."""
    st = geo.streets()
    by_id = {r["robot_id"]: r for r in robots}
    by_cust = {c["customer_id"]: c for c in customers}
    new_customers, orders, routes = [], [], []
    seq = {"cust": 6001, "order": 58401}

    def customer(zone: str) -> dict:
        name = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
        for _ in range(40):  # far enough from the Hub that the trip reads on the map
            c = _customer(rng, f"C-{seq['cust']}", name, zone)
            if geo.length(st.route(HUB_XY, (c["x"], c["y"]))) >= 4.0:
                break
        seq["cust"] += 1
        new_customers.append(c)
        return c

    def order(c: dict, placed: datetime, status: str, robot_id: str | None, minutes: int | None = None) -> dict:
        o = make_order(f"O-{seq['order']}", c, placed, rng, [{"robot_id": robot_id}], robot_id=robot_id,
                       status=status, minutes=minutes)
        seq["order"] += 1
        orders.append(o)
        return o

    def trip(rid, o, kind, path, depart, progress):
        minutes = trip_minutes(path)
        x, y = geo.point_along(path, progress)
        by_id[rid].update(x=round(x, 3), y=round(y, 3))
        routes.append({"robot_id": rid, "order_id": o["order_id"], "kind": kind,
                       "path": json.dumps([[round(px, 3), round(py, 3)] for px, py in path]),
                       "depart_at": depart, "arrive_at": depart + timedelta(minutes=minutes),
                       "progress": round(progress, 3), "km": round(geo.length(path) * KM_PER_UNIT, 2)})

    # Out for delivery: Hub to the customer's door, part of the way there.
    for rid in ("SB-001", "SB-009", "SB-010", "SB-012"):
        c = customer(by_id[rid]["zone"])
        path = st.route(HUB_XY, (c["x"], c["y"]))
        p = rng.uniform(0.3, 0.7)
        depart = SIM_NOW - timedelta(minutes=p * trip_minutes(path))
        trip(rid, order(c, depart - timedelta(minutes=9), "in_transit", rid), "deliver", path, depart, p)

    # Heading home to the Hub after a drop-off.
    c = customer("Capitol Hill")
    o = order(c, hours(13 + 5 / 60), "delivered", "SB-005", minutes=26)
    path = st.route((c["x"], c["y"]), HUB_XY)
    trip("SB-005", o, "return", path, o["delivered_at"], min(0.85, 9 / trip_minutes(path)))
    priya = by_cust["C-3310"]
    path = st.route((priya["x"], priya["y"]), HUB_XY)
    trip("SB-011", {"order_id": "O-58198"}, "return", path, hours(13 + 24 / 60), min(0.85, 16 / trip_minutes(path)))

    # Maya's robot left at 13:12 and stalled at 13:20, a few blocks short of her door.
    maya = by_cust["C-1042"]
    path = st.route(HUB_XY, (maya["x"], maya["y"]))
    trip("SB-003", {"order_id": "O-58213"}, "stalled", path, hours(13 + 12 / 60), min(0.85, 8 / trip_minutes(path)))

    # The kitchen queue: in the oven, then boxed and waiting for a robot.
    for ago, status in ((2, "preparing"), (4, "preparing"), (7, "preparing"), (10, "ready"), (13, "ready")):
        order(customer(rng.choice(ZONES)), SIM_NOW - timedelta(minutes=ago), status, None)
    return new_customers, orders, routes


def build_deliveries(rng, orders, robots):
    rows = []
    affected = set(B07_AFFECTED)
    for o in orders:
        if o["status"] != "delivered":
            continue
        dep = o["placed_at"] + timedelta(minutes=8)
        arr = o["delivered_at"]
        trip = max(6, (arr - dep).total_seconds() / 60)
        start_temp = round(rng.uniform(66.5, 70.0), 1)
        drop = rng.uniform(2.0, 5.0)
        days_ago = (SIM_NOW - arr).days
        scale = min(1.0, trip / 22)
        if o["robot_id"] in affected and days_ago <= 9:
            drop, scale = rng.uniform(9.5, 13.5), 1.0  # worn seal: heat escapes on every trip
        elif o["robot_id"] in affected and days_ago <= 20:
            drop = rng.uniform(5.0, 7.5)
        rows.append({
            "order_id": o["order_id"], "robot_id": o["robot_id"], "departed_at": dep, "arrived_at": arr,
            "trip_minutes": round(trip, 1), "box_temp_departure": start_temp,
            "box_temp_arrival": round(start_temp - drop * scale, 1),
            "distance_km": round(rng.uniform(0.6, 2.8), 2),
        })
    for r in rows:
        if r["order_id"] == "O-58198":
            r.update(box_temp_departure=68.0, box_temp_arrival=49.5, trip_minutes=28.0)
        if r["order_id"] == "O-58177":
            r.update(box_temp_departure=67.2, box_temp_arrival=61.0)
    return rows


def build_payments(rng, orders):
    rows, n = [], 1
    for o in orders:
        if o["status"] == "cancelled":
            continue
        auth_status = "released" if o["status"] == "delivered" else "pending"
        rows.append({"payment_id": f"P-{n:06d}", "order_id": o["order_id"], "customer_id": o["customer_id"],
                     "kind": "authorization", "amount": o["total"], "status": auth_status,
                     "created_at": o["placed_at"], "settled_at": o["delivered_at"]})
        n += 1
        if o["status"] == "delivered":
            rows.append({"payment_id": f"P-{n:06d}", "order_id": o["order_id"], "customer_id": o["customer_id"],
                         "kind": "capture", "amount": o["total"], "status": "settled",
                         "created_at": o["delivered_at"], "settled_at": o["delivered_at"] + timedelta(hours=1)})
            n += 1
    # One genuine duplicate capture, for the "real double charge" test case.
    dup = next(o for o in orders if o["status"] == "delivered" and 12 < o["total"] < 20
               and (SIM_NOW - o["placed_at"]).days == 3)
    rows.append({"payment_id": f"P-{n:06d}", "order_id": dup["order_id"], "customer_id": dup["customer_id"],
                 "kind": "capture", "amount": dup["total"], "status": "settled",
                 "created_at": dup["delivered_at"] + timedelta(minutes=2),
                 "settled_at": dup["delivered_at"] + timedelta(hours=1)})
    return rows, dup["order_id"]


def build_telemetry(rng, robots):
    rows = []
    t0 = SIM_NOW - timedelta(hours=6)
    for r in robots:
        # Active robots drain about 25 points over the six hours; idle and faulted ones hold their level.
        batt = min(100, r["battery_pct"] + 30) if r["status"] == "active" else r["battery_pct"]
        for k in range(37):
            ts = t0 + timedelta(minutes=10 * k)
            moving = r["status"] == "active" and rng.random() < 0.7
            # Driving drains the battery; only a robot on a charger gains, and never past 100%.
            batt = min(100, max(20, batt - 1.0 if moving else batt + 0.4 if r["status"] == "charging" else batt))
            row = {"robot_id": r["robot_id"], "ts": ts, "battery_pct": round(batt, 1),
                   "motor_l_amps": round(rng.uniform(3.0, 6.5) if moving else 0.2, 2),
                   "motor_r_amps": round(rng.uniform(3.0, 6.5) if moving else 0.2, 2),
                   "speed_kph": round(rng.uniform(4.0, 6.0) if moving else 0.0, 1),
                   "box_temp_c": round(rng.uniform(64, 70) if moving else rng.uniform(40, 60), 1),
                   "fault_code": None}
            rid = r["robot_id"]
            if rid == "SB-003" and ts >= hours(13 + 10 / 60):
                stall = ts >= hours(13 + 20 / 60)
                # The box holds Maya's order and cools steadily once the robot stops.
                cooled = (ts - hours(13 + 10 / 60)).total_seconds() / 60 * 0.3
                row.update(motor_l_amps=14.2 if stall else 9.1, motor_r_amps=4.1 if not stall else 0.3,
                           speed_kph=0.0 if stall else 2.1, fault_code="MTR_STALL_L2" if stall else None,
                           box_temp_c=round(66.0 - cooled, 1))
            if rid == "SB-007" and ts >= hours(9 + 50 / 60):
                row.update(speed_kph=0.0, motor_l_amps=0.2, motor_r_amps=0.2, fault_code="CAM_LOSS")
            if rid == "SB-002" and ts >= hours(11 + 10 / 60):
                row.update(speed_kph=0.0, motor_l_amps=0.2, motor_r_amps=0.2, fault_code="LID_ACT")
            if rid == "SB-011" and hours(13) <= ts <= hours(13 + 30 / 60):
                frac = (ts - hours(13)).total_seconds() / 1800
                row.update(box_temp_c=round(68 - 18.5 * frac, 1), speed_kph=5.1)
            if r["status"] in ("in_repair", "charging", "grounded") and rid not in ("SB-007", "SB-002"):
                row.update(speed_kph=0.0, motor_l_amps=0.2, motor_r_amps=0.2)
            rows.append(row)
    return rows


def build_tickets(rng, orders, customers):
    cats = [("late", "Order arrived late"), ("cold", "Food arrived cold"), ("billing", "Question about a charge"),
            ("lid", "Could not open the lid"), ("damage", "Food damaged in transit"), ("other", "General question")]
    delivered = [o for o in orders if o["status"] == "delivered" and o["placed_at"] < SIM_NOW - timedelta(days=1)]
    rows = []
    for i in range(60):
        o = rng.choice(delivered)
        cat, subj = rng.choice(cats)
        created = o["delivered_at"] + timedelta(minutes=rng.randint(5, 90))
        rows.append({"ticket_id": f"T-{3301 + i}", "customer_id": o["customer_id"], "order_id": o["order_id"],
                     "robot_id": o["robot_id"], "category": cat, "status": "resolved", "priority": "normal",
                     "subject": subj, "created_at": created, "updated_at": created + timedelta(hours=rng.randint(1, 30)),
                     "last_note": "Resolved by Customer Care.", "assigned_team": "Customer Care", "handled_by": "human",
                     "handle_minutes": round(max(3.0, rng.gauss(9.4, 3.0)), 1), "first_contact_resolved": rng.random() < 0.62})
    # A few that are still open, for ticket-status questions.
    specials = {
        "T-3342": dict(customer_id="C-4188", order_id=None, category="lid", status="pending_parts", robot_id="SB-002", subject="Could not open the lid",
                       last_note="Robot SB-002 grounded with a lid actuator fault. Replacement actuator LL-150 is in stock at the Hub; repair not yet scheduled.",
                       assigned_team="Fleet Repair", handle_minutes=None, first_contact_resolved=False),
        "T-3355": dict(category="damage", status="awaiting_specialist", subject="Food damaged in transit",
                       last_note="Customer sent a photo of a crushed box. Refund of $31.40 requested; above the auto limit, waiting for a specialist.",
                       assigned_team="Customer Care", handle_minutes=None, first_contact_resolved=False),
        "T-3349": dict(category="billing", status="resolved", subject="Question about a charge",
                       last_note="Explained the authorization hold. No refund needed.", first_contact_resolved=True),
    }
    for row in rows:
        if row["ticket_id"] in specials:
            row.update(specials[row["ticket_id"]])
            if row["status"] != "resolved":
                row["updated_at"] = SIM_NOW - timedelta(hours=3)
                row["created_at"] = SIM_NOW - timedelta(days=1, hours=2)
    return rows


def build_work_orders(rng, robots):
    by_part = {p[2]: p for p in PARTS}
    rows, n = [], 1001
    common = ["wheel_motor", "tire", "battery_pack", "lid_seal", "lid_lock", "bumper", "heater", "camera_mast"]
    for _ in range(80):
        r = rng.choice(robots)
        pk = rng.choice(common)
        created = SIM_NOW - timedelta(days=rng.randint(2, 60), hours=rng.randint(0, 12))
        ttr = max(1.5, rng.gauss(7.5, 3.0))
        rows.append({"wo_id": f"WO-{n}", "robot_id": r["robot_id"], "part_key": pk, "sku": by_part[pk][0],
                     "status": "completed", "priority": "normal", "reason": f"{by_part[pk][1]} replacement",
                     "source": rng.choice(["technician", "technician", "customer_ticket"]), "created_at": created,
                     "scheduled_start": created + timedelta(hours=ttr - 1), "scheduled_end": created + timedelta(hours=ttr),
                     "completed_at": created + timedelta(hours=ttr), "mechanic_id": rng.choice(MECHANICS)[0],
                     "depot_id": r["home_depot"], "first_time_fix": rng.random() < 0.78, "runner_robot_id": None,
                     "plan_json": None})
        n += 1
    rows += [
        {"wo_id": f"WO-{n}", "robot_id": "SB-006", "part_key": "battery_pack", "sku": "BP-400", "status": "in_progress",
         "priority": "normal", "reason": "Battery health 64%", "source": "technician", "created_at": hours(9),
         "scheduled_start": hours(13.25), "scheduled_end": hours(13.75), "completed_at": None, "mechanic_id": "M-02",
         "depot_id": "NORTH", "first_time_fix": None, "runner_robot_id": None, "plan_json": None},
        {"wo_id": f"WO-{n + 1}", "robot_id": "SB-007", "part_key": "camera_mast", "sku": "CM-310", "status": "open",
         "priority": "high", "reason": "Camera offline (CAM_LOSS)", "source": "technician", "created_at": hours(10),
         "scheduled_start": None, "scheduled_end": None, "completed_at": None, "mechanic_id": None, "depot_id": "NORTH",
         "first_time_fix": None, "runner_robot_id": None, "plan_json": None},
        {"wo_id": f"WO-{n + 2}", "robot_id": "SB-002", "part_key": "lid_lock", "sku": "LL-150", "status": "open",
         "priority": "high", "reason": "Lid will not release (LID_ACT)", "source": "customer_ticket",
         "created_at": hours(11.3), "scheduled_start": None, "scheduled_end": None, "completed_at": None,
         "mechanic_id": None, "depot_id": "SOUTH", "first_time_fix": None, "runner_robot_id": None, "plan_json": None},
    ]
    return rows


def build_contacts():
    """The live support queue at SIM_NOW: four hero stories plus a few others, and one order to help choose."""
    return [
        ("K-9001", "C-1042", "app", True, "Where's my pizza? The app says it's late and the robot hasn't moved in 15 minutes.", hours(13 + 37 / 60)),
        ("K-9002", "C-2077", "app", True, "Why was I charged twice for my order on Sunday? I see two charges of $38.50.", hours(13 + 31 / 60)),
        ("K-9003", "C-3310", "app", True, "My pizza arrived cold. It was barely warm when I opened the box.", hours(13 + 33 / 60)),
        ("K-9004", "C-4188", "app", True, "My party order was almost an hour late. I want my $84.60 back.", hours(13 + 29 / 60)),
        ("K-9005", None, "web_chat", False, "Do your robots deliver when it's raining?", hours(13 + 35 / 60)),
        ("K-9006", None, "web_chat", False, "Please change the delivery address on my account to 418 G St SE.", hours(13 + 36 / 60)),
        ("K-9007", "C-4188", "app", True, "What's the status of ticket T-3342?", hours(13 + 38 / 60)),
        # The refund is two order lines summed, so the Checker sends draft 1 back (the revision loop).
        ("K-9008", "C-4797", "app", True, "The pizza from order O-58165 was lukewarm at best.", hours(13 + 34 / 60)),
        # The Menu bot: the model parses, code filters out the nut items and keeps the basket under budget.
        ("K-9009", None, "web_chat", False, "Movie night for 6, two of us are vegetarian and my son has a nut allergy. "
         "Keep it under $60.", hours(13 + 39 / 60)),
    ]


def write_generated_docs(rng, robots, orders):
    """Past chat transcripts and technician case notes (unstructured data)."""
    if GENERATED_CORPUS.exists():
        shutil.rmtree(GENERATED_CORPUS)
    (GENERATED_CORPUS / "transcripts").mkdir(parents=True)
    (GENERATED_CORPUS / "case-notes").mkdir(parents=True)
    delivered = [o for o in orders if o["status"] == "delivered" and o["placed_at"] < SIM_NOW - timedelta(days=1)]
    by_robot = {}
    for o in delivered:
        by_robot.setdefault(o["robot_id"], []).append(o)

    def recent(rid):
        options = [o for o in by_robot.get(rid, []) if (SIM_NOW - o["placed_at"]).days <= 8]
        return rng.choice(options or by_robot.get(rid) or delivered)

    templates = [
        ("cold", "My pizza was cold when it got here.",
         "I'm sorry about that. The robot's warming box record shows it lost {drop}°C on the way, so I've refunded the pizza to your card.",
         "Refunded hot items under the cold food policy."),
        ("hold", "I think I was charged twice.",
         "I checked your payments. One is a temporary authorization hold and one is the final charge. The hold was released at delivery and should disappear from your bank in 3 to 5 business days.",
         "Explained authorization hold. No refund."),
        ("lid", "The lid won't open.",
         "Please tap Unlock again after 10 seconds. If it still stays shut, the app will show a 4-digit PIN you can type on the robot's keypad.",
         "Lid opened with the PIN."),
        ("late", "My order is really late.",
         "I'm sorry for the wait. Your order arrived {late} minutes after the promised time, so a ${credit} credit has been added to your account.",
         "Late delivery credit applied."),
        ("zone", "Do you deliver to the airport?",
         "We deliver in four DC neighborhoods: Capitol Hill, Eastern Market, Navy Yard, and the Southwest Waterfront. The airport is outside our service area.",
         "Out of zone. No action."),
    ]
    tr_n = 1
    cold_robots = ["SB-009", "SB-010", "SB-012", "SB-011", "SB-009"]
    plan = [("cold", rid) for rid in cold_robots] + [("hold", None)] * 6 + [("lid", None)] * 6 + [("late", None)] * 8 + [("zone", None)] * 5
    for kind, rid in plan:
        tpl = next(t for t in templates if t[0] == kind)
        o = recent(rid) if rid else rng.choice(delivered)
        late = max(16, int(((o["delivered_at"] or o["promised_at"]) - o["promised_at"]).total_seconds() // 60))
        body = tpl[2].format(drop=rng.randint(10, 14), late=late, credit=5 if late <= 45 else 10)
        date = (o["delivered_at"] or o["placed_at"]).strftime("%Y-%m-%d")
        text = (f"# Chat transcript TR-{tr_n:04d}\n\nDate: {date}. Customer: {o['customer_id']}. Order: {o['order_id']}. "
                f"Robot: {o['robot_id']}. Channel: app chat. Handled by: Customer Care specialist.\n\n"
                f"## Conversation\nCustomer: {tpl[1]}\nSpecialist: {body}\nCustomer: Thanks.\n\nOutcome: {tpl[3]}\n")
        (GENERATED_CORPUS / "transcripts" / f"TR-{tr_n:04d}.md").write_text(text)
        tr_n += 1

    notes = []
    for rid, cn in (("SB-008", "CN-0412"),):
        notes.append((cn, rid, "2026-09-22",
                      f"Robot {rid} (batch M2-B07) flagged after cold-food complaints. Warming box lost 11°C on a 20 minute trip. "
                      "Heater element tested normal. Lid seal gasket compressed and cracked at the hinge corner. "
                      "Replaced lid seal gasket LS-220. Test trip afterwards lost 3°C. Fixed on first visit, 20 minutes."))
    notes.append(("CN-0431", "SB-010", "2026-09-30",
                  "Robot SB-010 (batch M2-B07) reported for cold deliveries. Seal looks worn at the hinge corner, same as SB-008. "
                  "No replacement gasket on the van, so the robot went back into service. Needs LS-220 replacement off-peak."))
    notes.append(("CN-0398", "SB-001", "2026-09-17",
                  "Robot SB-001 stalled with MTR_STALL on the left motor. Wheel well had packed leaves; cleared it and the stall repeated "
                  "the next day. Replaced drive wheel motor WM-110. Took 45 minutes."))
    notes.append(("CN-0405", "SB-005", "2026-09-19",
                  "SB-005 motor current spikes on firmware 4.2.0 were a reporting bug (see OB-2026-011). Updated to 4.2.1, no part replaced."))
    filler = [
        ("wheel_motor", "Left drive motor stall after curb strike. Replaced WM-110, test drive normal."),
        ("tire", "Front tire puncture from glass. Replaced TR-115."),
        ("battery_pack", "Battery health at 66%, full charge lasting 3.5 hours. Replaced BP-400."),
        ("lid_lock", "Lid would not release (LID_ACT). Replaced actuator LL-150. Customer had used the PIN to open it."),
        ("bumper", "Front bumper cracked after contact with a bollard. No injuries. Replaced BM-120."),
        ("heater", "Warming box could not reach 60°C before departure. Heater element HE-205 replaced."),
        ("camera_mast", "Camera offline after a branch strike (CAM_LOSS). Replaced camera mast CM-310."),
    ]
    for i in range(45):
        rid = rng.choice([r["robot_id"] for r in robots if r["batch"] != "M2-B07"])
        pk, txt = rng.choice(filler)
        notes.append((f"CN-{300 + i:04d}", rid, (SIM_NOW - timedelta(days=rng.randint(10, 60))).strftime("%Y-%m-%d"), txt))
    for cn, rid, date, txt in notes:
        (GENERATED_CORPUS / "case-notes" / f"{cn}.md").write_text(
            f"# Case note {cn}\n\nDate: {date}. Robot: {rid}. Author: Fleet Repair.\n\n## Note\n{txt}\n")


# ---------------------------------------------------------------- main

def build(db_path=DB_PATH) -> dict:
    def rng(table: str) -> random.Random:
        # One stream per table, so changing one table never reshuffles the others.
        return random.Random(f"{SEED}:{table}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    robots = build_robots(rng("robots"))
    customers = build_customers(rng("customers"))
    orders = build_orders(rng("orders"), customers, robots)
    live_customers, live_orders, routes = build_live(rng("live"), robots, customers)
    customers += live_customers
    orders = sorted(orders + live_orders, key=lambda o: o["placed_at"])
    deliveries = build_deliveries(rng("deliveries"), orders, robots)
    payments, dup_order = build_payments(rng("payments"), orders)
    telemetry = build_telemetry(rng("telemetry"), robots)
    tickets = build_tickets(rng("tickets"), orders, customers)
    work_orders = build_work_orders(rng("work_orders"), robots)
    write_generated_docs(rng("docs"), robots, orders)

    con = duckdb.connect(str(db_path))
    con.execute(open(__file__.replace("generate.py", "schema.sql")).read())

    def load(table, rows):
        """Bulk load through a temp CSV; row-by-row inserts take ~15s, this takes well under one."""
        if not rows:
            return
        cols = list(rows[0].keys())
        tmp = db_path.parent / f".load-{table}.csv"
        with open(tmp, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for r in rows:
                w.writerow(["" if r[c] is None else r[c] for c in cols])
        con.execute(f"INSERT INTO {table} ({', '.join(cols)}) SELECT * FROM read_csv(?, header = true, "
                    f"all_varchar = true, nullstr = '')", [str(tmp)])
        tmp.unlink()

    load("depots", [dict(depot_id=d[0], name=d[1], kind=d[2], x=d[3], y=d[4],
                         address=geo.short_street(geo.streets().street_name(d[3], d[4]))) for d in DEPOTS])
    load("routes", routes)
    load("robots", robots)
    load("customers", customers)
    load("orders", orders)
    load("deliveries", deliveries)
    load("payments", payments)
    load("telemetry", telemetry)
    load("tickets", tickets)
    load("work_orders", work_orders)
    load("menu", [dict(item_id=m[0], name=m[1], category=m[2], price=m[3], serves=m[4], description=m[5], tags=m[6],
                       allergens=m[7], available=True) for m in MENU_CATALOG])
    load("parts", [dict(sku=p[0], name=p[1], part_key=p[2], skill=p[3], repair_minutes=p[4], unit_cost=p[5]) for p in PARTS])
    load("inventory", [dict(sku=i[0], location_id=i[1], bin=i[2], qty_on_hand=i[3], qty_reserved=0, reorder_point=i[4])
                       for i in INVENTORY])
    load("mechanics", [dict(mechanic_id=m[0], name=m[1], depot_id=m[2], skills=m[3],
                            shift_start=hours(m[4]), shift_end=hours(m[5])) for m in MECHANICS])
    load("demand_forecast", [dict(zone=z, hour=h, orders_per_hour=demand(h + 0.5, z)) for z in ZONES for h in range(8, 24)])
    load("contacts", [dict(contact_id=c[0], customer_id=c[1], channel=c[2], verified=c[3], message=c[4], received_at=c[5])
                      for c in build_contacts()])
    load("adjustments", [])
    con.close()
    return {"robots": len(robots), "customers": len(customers), "orders": len(orders), "routes": len(routes),
            "payments": len(payments),
            "telemetry": len(telemetry), "tickets": len(tickets), "work_orders": len(work_orders),
            "duplicate_capture_order": dup_order}


if __name__ == "__main__":
    print(json.dumps(build(), indent=2, default=str))
