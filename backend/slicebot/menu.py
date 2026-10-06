"""The Menu bot's engine: "what should we order?" turned into a basket.

Ported from the Atelier fashion recommender (openAi project/fashion-recsys),
which proved the pattern on product search:

    request -> parse (Claude or rules) -> one search per wanted item -> filter in code -> basket

- The model parses, it never picks. "Movie night for 6, two vegetarians, nut
  allergy, under $60" becomes item phrases ("classic pepperoni pizza",
  "garlic knots") plus constraints (party size, budget, diets, allergens).
- Search retrieves. Each phrase is matched against the menu by vector
  similarity, so "cheese pizza" finds the Margherita without sharing a word.
- Code decides. Allergens, diets, availability, servings, and the budget are
  applied deterministically after retrieval, so a wrong parse or a
  hallucinated item can never put walnuts in a nut-allergy basket. Every
  exclusion is kept with its reason, which is what the reply and the UI show.
- Every wanted item gets a line or an explicit reason it could not
  (coverage), so one popular category can't crowd out the rest.

Embeddings are tiered like the recommender: sentence-transformers when it is
installed (vectors cached on disk, keyed by model), else a hashed word and
character-trigram TF-IDF that needs nothing. Claude has no embeddings
endpoint, so neither tier calls out.
"""
from __future__ import annotations

import math
import re
import zlib
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

from slicebot import llm
from slicebot.db import store

CATEGORIES = ["pizza", "side", "drink", "dessert"]
DIETS = ["vegetarian", "vegan", "gluten_free"]
ALLERGENS = ["gluten", "dairy", "egg", "soy", "tree_nuts", "fish"]
# A diet implies allergens to exclude across the basket.
DIET_EXCLUDES = {"vegan": {"dairy", "egg", "fish"}, "gluten_free": {"gluten"}}

S = {"type": "string"}
PARSE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["say", "items", "party_size", "max_budget", "diet_all", "diet_some", "exclude_allergens",
                 "severe_allergy", "occasion"],
    "properties": {
        "say": S,
        "items": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["phrase", "category"],
            "properties": {"phrase": S, "category": {"type": "string", "enum": CATEGORIES}}}},
        "party_size": {"type": "integer"},
        "max_budget": {"type": ["number", "null"]},
        "diet_all": {"type": "array", "items": {"type": "string", "enum": DIETS}},
        "diet_some": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["diet", "people"],
            "properties": {"diet": {"type": "string", "enum": DIETS}, "people": {"type": "integer"}}}},
        "exclude_allergens": {"type": "array", "items": {"type": "string", "enum": ALLERGENS}},
        "severe_allergy": {"type": "boolean"},
        "occasion": {"type": ["string", "null"]},
    },
}

PARSE_SYS = """You are the Menu bot in SliceBot's customer crew. SliceBot is a pizza delivery company.
Turn the customer's request into what to search the menu for. You do not choose menu items; code does that.
- items: 2 to 6 concrete things to look for, each with its category (pizza, side, drink, dessert), in menu
  vocabulary ("classic pepperoni pizza", "garlic knots", "something sweet"). Include at least one pizza.
  Add a side, drink, or dessert only if the request or occasion suggests it.
- party_size: how many people will eat; 2 if not stated.
- max_budget: the most they want to spend in dollars, or null.
- diet_all: diets that apply to everyone (vegetarian, vegan, gluten_free).
  diet_some: diets that apply to only some people, with how many ("two of us are vegetarian").
- exclude_allergens: every allergen anyone mentions (a nut allergy is tree_nuts; celiac is gluten).
- severe_allergy: true for a severe, life-threatening, or anaphylactic allergy, or an EpiPen.
- say: one short first-person sentence (under 20 words) for the crew channel. No emoji."""


# ---------------------------------------------------------------- parse: rules brain

NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
       "eleven": 11, "twelve": 12, "a couple": 2, "both": 2}
N = r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"

# Occasion -> what to look for. Same idea as the recommender's beach -> swim trunks table.
OCCASIONS = [
    ("movie", [("classic pepperoni pizza", "pizza"), ("cheese margherita pizza", "pizza"),
               ("garlic knots", "side"), ("chocolate chip cookie", "dessert")]),
    ("game", [("pepperoni pizza", "pizza"), ("bbq chicken pizza", "pizza"), ("spicy buffalo bites", "side"),
              ("soda", "drink")]),
    ("birthday|party", [("pepperoni pizza", "pizza"), ("cheese margherita pizza", "pizza"),
                        ("veggie pizza", "pizza"), ("garlic knots", "side"), ("soda", "drink"),
                        ("cookie", "dessert")]),
    ("kid", [("kid friendly cheese pizza", "pizza"), ("pepperoni pizza", "pizza"), ("lemonade", "drink"),
             ("cookie", "dessert")]),
    ("lunch", [("medium pizza", "pizza"), ("salad", "side"), ("drink", "drink")]),
    ("date", [("veggie pizza", "pizza"), ("salad", "side"), ("dessert", "dessert")]),
    ("light|healthy", [("veggie pizza", "pizza"), ("salad", "side"), ("sparkling water", "drink")]),
]
MENTIONS = [  # explicit asks add a line whatever the occasion
    (r"\bspicy|\bhot\b|kick", ("spicy pizza", "pizza")),
    (r"\bsalad", ("salad", "side")),
    (r"\b(dessert|sweet|cookie|brownie)", ("dessert", "dessert")),
    (r"\b(drinks?|soda|lemonade|beverages?)\b", ("drink", "drink")),
    (r"\b(sides?|knots|apps|appetizers?|snacks?)\b", ("garlic knots", "side")),
    (r"\bchicken\b", ("chicken pizza", "pizza")),
    (r"\bpepperoni\b", ("pepperoni pizza", "pizza")),
]
ALLERGEN_WORDS = [
    (r"\bnut|\bpeanut|walnut|pine nut|almond", "tree_nuts"), (r"\bdairy|lactose|milk\b", "dairy"),
    (r"\beggs?\b", "egg"), (r"\bsoy\b", "soy"), (r"\bfish\b|anchov|shellfish", "fish"),
    (r"\bgluten\b|celiac|coeliac|wheat", "gluten"),
]
SEVERE = re.compile(r"\b(severe|severely|anaphyla\w*|epi-?pen|deathly|life[- ]threatening)\b", re.I)


def _num(s: str) -> int:
    return int(s) if s.isdigit() else NUM.get(s.lower(), 2)


def parse_rules(message: str) -> dict:
    q = message.lower()
    party = None
    for pat in (rf"\b(?:for|feed(?:ing)?|party of|group of|serves?)\s+{N}\b",
                rf"\b{N}\s+(?:people|of us|adults|kids|guests|friends|hungry)"):
        m = re.search(pat, q)
        if m:
            party = _num(m.group(1))
            break
    budget = None
    m = re.search(r"(?:under|below|less than|max(?:imum)?|budget(?: of| is)?|no more than|up to|within)\s*\$?\s*(\d+(?:\.\d+)?)", q)
    if m:
        budget = float(m.group(1))

    diet_some, diet_all = [], []
    for diet, pat in (("vegetarian", r"vegetarians?"), ("vegan", r"vegans?"), ("gluten_free", r"gluten[- ]free")):
        some = re.search(rf"\b{N}\s+(?:of (?:us|them) (?:are|is) |are |)(?:{pat})", q)
        if some:
            diet_some.append({"diet": diet, "people": _num(some.group(1))})
        elif re.search(rf"\b(?:{pat})\b", q):
            diet_all.append(diet)

    excl = []
    if re.search(r"allerg|intoleran|celiac|coeliac|can'?t (?:have|eat)|no (?:nuts|dairy|eggs?|soy|fish|gluten)", q):
        excl = [a for pat, a in ALLERGEN_WORDS if re.search(pat, q)]

    items: list[tuple[str, str]] = []
    occasion = None
    for key, wanted in OCCASIONS:
        if re.search(key, q):
            occasion, items = key.split("|")[0], list(wanted)
            break
    for pat, it in MENTIONS:
        if re.search(pat, q) and it not in items:
            items.append(it)
    if "vegan" in diet_all:  # partial diets are covered by recommend(), not by an extra wanted pizza
        items.insert(0, ("vegan pizza", "pizza"))
    elif "gluten_free" in diet_all:
        items.insert(0, ("gluten free pizza", "pizza"))
    elif "vegetarian" in diet_all:
        items.insert(0, ("veggie pizza", "pizza"))
    if not any(c == "pizza" for _, c in items):
        items.insert(0, ("classic pepperoni pizza", "pizza"))
    seen, uniq = set(), []
    for p, c in items:
        if p not in seen:
            seen.add(p)
            uniq.append({"phrase": p, "category": c})
    party = party or 2
    bits = [f"for {party}"] + ([f"under ${budget:g}"] if budget else []) + \
           [f"no {a.replace('_', ' ')}" for a in excl] + [d.replace("_", " ") for d in diet_all] + \
           [f"{d['people']} {d['diet'].replace('_', ' ')}" for d in diet_some]
    return {"say": f"Order {', '.join(bits)}. Searching the menu for {len(uniq)} things.", "items": uniq[:6],
            "party_size": party, "max_budget": budget, "diet_all": diet_all, "diet_some": diet_some,
            "exclude_allergens": excl, "severe_allergy": bool(SEVERE.search(q)), "occasion": occasion}


def parse(message: str, engine: str) -> tuple[dict, llm.Usage]:
    if engine == "live":
        r = llm.call_bot("menu", PARSE_SYS, message, PARSE_SCHEMA)
        out = r.output
        # The severe-allergy rule is code too: the model can add it, never remove it.
        out["severe_allergy"] = bool(out.get("severe_allergy") or SEVERE.search(message))
        out["party_size"] = max(1, min(int(out.get("party_size") or 2), 40))
        return out, r.usage
    return parse_rules(message), llm.Usage()


# ---------------------------------------------------------------- embeddings

def _stable_hash(token: str) -> int:
    """Deterministic across processes. The recommender first used hash(), which is salted per
    process, so cached vectors silently stopped matching fresh queries."""
    return zlib.crc32(token.encode("utf-8"))


class HashedTfidf:
    """Word plus character-trigram TF-IDF in a hashed sparse space. Robust to word forms
    ("knot" and "knots", "veggie" and "vegetables") without a model download."""
    name = "tfidf"
    DIM = 4096

    def __init__(self, texts: list[str]):
        df = Counter()
        for t in texts:
            df.update({_stable_hash(g) % self.DIM for g in self._grams(t)})
        n = max(1, len(texts))
        self.idf = {k: math.log((1 + n) / (1 + v)) + 1 for k, v in df.items()}
        self.default_idf = math.log(1 + n) + 1

    @staticmethod
    def _grams(text: str) -> list[str]:
        out = []
        for w in re.findall(r"[a-z0-9]+", text.lower()):
            out.append(w)
            out.extend(w[i:i + 3] for i in range(len(w) - 2))
        return out

    def embed(self, text: str) -> dict[int, float]:
        counts = Counter(_stable_hash(g) % self.DIM for g in self._grams(text))
        vec = {k: (1 + math.log(c)) * self.idf.get(k, self.default_idf) for k, c in counts.items()}
        norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
        return {k: v / norm for k, v in vec.items()}

    @staticmethod
    def sim(a: dict[int, float], b: dict[int, float]) -> float:
        if len(a) > len(b):
            a, b = b, a
        return sum(v * b.get(k, 0.0) for k, v in a.items())


class Semantic:
    """sentence-transformers tier, vectors cached on disk by model and menu content."""
    name = "embeddings"

    def __init__(self, texts: list[str]):
        from slicebot.search import cached_encode, sentence_model  # noqa: optional dependency
        self.model = sentence_model()
        self.vecs = cached_encode("menu", texts)

    def embed(self, text: str):
        return self.model.encode([text], normalize_embeddings=True)[0]

    @staticmethod
    def sim(a, b) -> float:
        return float(a @ b)


# ---------------------------------------------------------------- the index

@dataclass
class Item:
    item_id: str
    name: str
    category: str
    price: float
    serves: int
    description: str
    tags: set[str]
    allergens: set[str]
    available: bool

    @property
    def source_id(self) -> str:
        return f"db:menu/{self.item_id}"

    def text(self) -> str:
        return (f"{self.name}. {self.category}. {self.description} "
                f"{' '.join(t.replace('_', ' ') for t in sorted(self.tags))}")

    def fact(self) -> str:
        tags = ", ".join(t.replace("_", " ") for t in sorted(self.tags)) or "no diet tags"
        alg = ", ".join(a.replace("_", " ") for a in sorted(self.allergens)) or "none listed"
        return (f"{self.name}: {self.category}, ${self.price:.2f}, serves {self.serves}. {self.description} "
                f"Tags: {tags}. Allergens: {alg}.{'' if self.available else ' Not available today.'}")


class MenuIndex:
    def __init__(self):
        rows = store().query("SELECT * FROM menu ORDER BY item_id")
        self.items = [Item(r["item_id"], r["name"], r["category"], float(r["price"]), int(r["serves"]),
                           r["description"], {t for t in (r["tags"] or "").split(",") if t},
                           {a for a in (r["allergens"] or "").split(",") if a}, bool(r["available"]))
                      for r in rows]
        texts = [i.text() for i in self.items]
        try:
            self.emb = Semantic(texts)
            self.vecs = list(self.emb.vecs)
        except Exception:
            self.emb = HashedTfidf(texts)
            self.vecs = [self.emb.embed(t) for t in texts]
        self.tier = self.emb.name

    def search(self, phrase: str, category: str | None = None) -> list[tuple[Item, float]]:
        q = self.emb.embed(phrase)
        hits = [(it, round(self.emb.sim(q, v), 3)) for it, v in zip(self.items, self.vecs)
                if not category or it.category == category]
        return sorted(hits, key=lambda h: -h[1])


@lru_cache(maxsize=1)
def menu_index() -> MenuIndex:
    return MenuIndex()


def reload_menu() -> None:
    menu_index.cache_clear()


# ---------------------------------------------------------------- constraints, in code

def violations(item: Item, req: dict) -> list[str]:
    """Why an item can't go in this basket. Empty means it can."""
    why = []
    if not item.available:
        why.append("not available today")
    banned = set(req.get("exclude_allergens") or [])
    for d in req.get("diet_all") or []:
        banned |= DIET_EXCLUDES.get(d, set())
        if d not in item.tags:
            why.append(f"not {d.replace('_', ' ')}")
    hit = sorted(item.allergens & banned)
    if hit:
        why.append("contains " + ", ".join(a.replace("_", " ") for a in hit))
    return why


WEAK_MATCH = 0.2  # below this similarity, say the line is only the closest thing that fits


def _weak(score: float) -> str:
    return "closest match that fits" if score < WEAK_MATCH else ""


def recommend(req: dict) -> dict:
    """Build the basket. Deterministic: the same parsed request always gives the same basket."""
    idx = menu_index()
    party = max(1, int(req.get("party_size") or 2))
    budget = req.get("max_budget")
    lines: dict[str, dict] = {}
    excluded: dict[str, dict] = {}
    coverage = []

    def add(item: Item, qty: int, why: str, score: float | None):
        if item.item_id in lines:
            lines[item.item_id]["qty"] += qty
            return
        lines[item.item_id] = {"item_id": item.item_id, "source_id": item.source_id, "name": item.name,
                               "category": item.category, "price": item.price, "serves": item.serves, "qty": qty,
                               "tags": sorted(item.tags), "allergens": sorted(item.allergens),
                               "matched_for": why, "score": score}

    def best(phrase: str, category: str, extra=lambda it: True):
        """Top eligible match for a phrase; strong matches that break a rule are kept as exclusions."""
        for it, score in idx.search(phrase, category):
            bad = violations(it, req)
            if bad:
                if score >= 0.25 and it.item_id not in excluded:
                    excluded[it.item_id] = {"source_id": it.source_id, "name": it.name, "reason": "; ".join(bad),
                                            "wanted_for": phrase}
                continue
            if extra(it):
                return it, score
        return None, 0.0

    pizzas = [w for w in req.get("items") or [] if w["category"] == "pizza"] or \
             [{"phrase": "classic pepperoni pizza", "category": "pizza"}]
    others = [w for w in req.get("items") or [] if w["category"] != "pizza"]

    # Pizzas: first enough for each partial diet, then variety across the wanted pizzas until everyone is fed.
    fed = 0
    for need in req.get("diet_some") or []:
        diet, people = need["diet"], max(1, int(need["people"]))
        covered = 0
        while covered < people:
            it, score = best(f"{diet.replace('_', ' ')} pizza", "pizza", lambda i, d=diet: d in i.tags)
            if not it:
                coverage.append({"want": f"{people} {diet.replace('_', ' ')}", "item_id": None,
                                 "note": f"no available {diet.replace('_', ' ')} pizza fits the other needs"})
                break
            add(it, 1, f"{people} {diet.replace('_', ' ')}", score)
            covered += it.serves
            fed += it.serves
        else:
            coverage.append({"want": f"{people} {diet.replace('_', ' ')}", "item_id": it.item_id, "note": ""})
    tried: set[str] = set()
    for i in range(12):
        if fed >= party:
            break
        w = pizzas[i % len(pizzas)]
        first = w["phrase"] not in tried
        tried.add(w["phrase"])
        it, score = best(w["phrase"], "pizza")
        if not it:
            if first:
                coverage.append({"want": w["phrase"], "item_id": None, "note": "every match breaks a dietary need"})
            continue
        add(it, 1, w["phrase"], score)
        if first:
            coverage.append({"want": w["phrase"], "item_id": it.item_id, "note": _weak(score)})
        fed += it.serves
    for w in pizzas:  # wanted pizzas the party was already fed without
        if w["phrase"] not in tried:
            coverage.append({"want": w["phrase"], "item_id": None, "note": f"all {party} already fed"})

    # Sides scale with the group; drinks and desserts are one per person.
    for w in others:
        it, score = best(w["phrase"], w["category"])
        if not it:
            coverage.append({"want": w["phrase"], "item_id": None, "note": "every match breaks a dietary need"})
            continue
        qty = party if w["category"] in ("drink", "dessert") else max(1, math.ceil(party / max(1, it.serves * 2)))
        add(it, qty, w["phrase"], score)
        coverage.append({"want": w["phrase"], "item_id": it.item_id, "note": _weak(score)})

    # Budget, in code: extras go first (dessert, then drinks, then sides), whole lines at a time; pizzas stay.
    dropped = []
    total = round(sum(l["price"] * l["qty"] for l in lines.values()), 2)
    if budget:
        for cat in ("dessert", "drink", "side"):
            for l in sorted([l for l in lines.values() if l["category"] == cat], key=lambda l: -l["price"] * l["qty"]):
                if total <= budget + 0.005:
                    break
                del lines[l["item_id"]]
                total = round(total - l["price"] * l["qty"], 2)
                dropped.append({"source_id": l["source_id"], "name": l["name"], "qty": l["qty"],
                                "amount": round(l["price"] * l["qty"], 2), "reason": f"to stay under ${budget:g}"})
                for c in coverage:
                    if c["item_id"] == l["item_id"]:
                        c.update(item_id=None, note=f"dropped to stay under ${budget:g}")
    basket = sorted(lines.values(), key=lambda l: (CATEGORIES.index(l["category"]), l["name"]))
    for l in basket:
        l["line_total"] = round(l["price"] * l["qty"], 2)
    serves = sum(l["serves"] * l["qty"] for l in basket if l["category"] == "pizza")
    return {"lines": basket, "total": total, "party_size": party, "pizza_serves": serves,
            "fed": serves >= party, "max_budget": budget,
            "over_budget": bool(budget) and total > budget + 0.005, "excluded": list(excluded.values()),
            "dropped": dropped, "coverage": coverage, "tier": idx.tier}


def basket_summary(b: dict) -> str:
    """The text the basket evidence carries, so the Checker can find every amount the reply quotes."""
    lines = "; ".join(f"{l['qty']} x {l['name']} at ${l['price']:.2f} = ${l['line_total']:.2f}" for l in b["lines"])
    s = (f"Suggested order for {b['party_size']}: {lines}. Total ${b['total']:.2f}. "
         f"Pizzas serve about {b['pizza_serves']}.")
    if b["max_budget"]:
        s += f" Budget ${b['max_budget']:.2f}: {'over' if b['over_budget'] else 'within'} budget."
    for x in b["excluded"]:
        s += f" Left out {x['name']}: {x['reason']}."
    for d in b["dropped"]:
        s += f" Dropped {d['qty']} x {d['name']} (${d['amount']:.2f}) {d['reason']}."
    for c in b["coverage"]:
        if c["note"] and c["item_id"]:
            s += f" Asked for {c['want']}: {c['note']}."
        elif c["note"].startswith("every match"):
            s += f" Asked for {c['want']}: nothing fits every need."
    return s
