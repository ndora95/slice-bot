"""Document search over policies, manuals, bulletins, transcripts, case notes.

Tiered like the original Atelier idea: a local embedding model when
`sentence-transformers` is installed, otherwise BM25 keyword ranking, which
needs nothing. Claude has no embeddings endpoint, so neither tier calls out.
Embedded vectors are cached on disk keyed by model and content (cached_encode),
as the Atelier recommender did, so a restart doesn't re-encode the corpus.
Every chunk has a stable `source_id` (doc:<file>#<section>) for citations.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

from slicebot.config import CORPUS_DIR, DATA_DIR

TOKEN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
STOP = set("a an and are as at be but by can do does for from has have how i if in is it its my of on or so that the "
           "their them there this to was we were what when which who why will with you your me our it's im".split())
# Small query expansion so plain customer words reach policy vocabulary.
SYNONYMS = {
    "cold": ["warming", "heat", "temperature", "57"], "lukewarm": ["cold", "warming"],
    "twice": ["duplicate", "hold", "authorization"], "double": ["duplicate", "hold"],
    "charged": ["charge", "authorization", "capture"], "late": ["promised", "credit", "delay"],
    "refund": ["refunded", "credit"], "open": ["unlock", "lid", "pin"], "lid": ["unlock", "pin"],
    "rain": ["weather"], "raining": ["weather", "rain"], "snow": ["weather"],
    "stairs": ["building", "lobby"], "apartment": ["building", "lobby"],
    "address": ["account", "changes", "verified"], "cancel": ["changing", "cancellation"],
    "membership": ["slicepass"], "subscription": ["slicepass"], "where": ["tracking", "position"],
    "tip": ["tips"], "promo": ["promo"], "zone": ["zones"], "deliver": ["zones", "delivery"],
    "floor": ["stairs", "building", "elevator"], "door": ["lobby", "entrance", "street-level"],
    "upstairs": ["stairs", "elevator"], "see": ["tracking", "position"], "track": ["tracking", "position"],
}


def stem(t: str) -> str:
    """Crude suffix stripping so 'snows', 'snowing', and 'snow' meet."""
    if len(t) > 5 and t.endswith("ing"):
        return t[:-3]
    if len(t) > 4 and t.endswith("es") and not t.endswith("ses"):
        return t[:-1]
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
        return t[:-1]
    return t


def tokenize(text: str) -> list[str]:
    return [stem(t) for t in TOKEN.findall(text.lower()) if t not in STOP]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# Official sources outrank anecdotes when scores are close.
KIND_WEIGHT = {"policy": 1.3, "manual": 1.3, "bulletin": 1.25, "case_note": 1.0, "transcript": 0.8}
KIND_BY_DIR = {"policies": "policy", "manuals": "manual", "bulletins": "bulletin",
               "transcripts": "transcript", "case-notes": "case_note"}


@dataclass
class Chunk:
    source_id: str
    doc_id: str
    title: str
    section: str
    kind: str
    text: str        # the section body, what quotes come from
    meta: str        # the doc preamble (dates, robot IDs), searchable but not quotable
    tokens: list[str]


def load_chunks() -> list[Chunk]:
    chunks = []
    for path in sorted(CORPUS_DIR.rglob("*.md")):
        kind = KIND_BY_DIR.get(path.parent.name, "doc")
        raw = path.read_text()
        title = raw.splitlines()[0].lstrip("# ").strip()
        parts = re.split(r"^## ", raw, flags=re.M)
        meta = "\n".join(l for l in parts[0].splitlines()[1:] if l.strip())
        for part in parts[1:]:
            head, _, body = part.partition("\n")
            body = body.strip()
            sid = f"doc:{path.stem}#{slug(head)}"
            toks = tokenize(f"{title} {head} {meta} {body}")
            chunks.append(Chunk(sid, path.stem, title, head.strip(), kind, body, meta, toks))
    return chunks


class BM25:
    def __init__(self, chunks: list[Chunk], k1=1.4, b=0.75):
        self.chunks, self.k1, self.b = chunks, k1, b
        self.tf = [Counter(c.tokens) for c in chunks]
        self.len = [len(c.tokens) for c in chunks]
        self.avg = sum(self.len) / max(1, len(self.len))
        df = Counter()
        for tf in self.tf:
            df.update(tf.keys())
        n = len(chunks)
        self.idf = {t: math.log(1 + (n - d + 0.5) / (d + 0.5)) for t, d in df.items()}

    def score(self, q: list[str], i: int) -> float:
        tf, ln, s = self.tf[i], self.len[i], 0.0
        for t in q:
            if t in tf:
                f = tf[t]
                s += self.idf[t] * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * ln / self.avg))
        return s


EMBED_MODEL = "all-MiniLM-L6-v2"


@lru_cache(maxsize=1)
def sentence_model():
    from sentence_transformers import SentenceTransformer  # noqa: optional dependency
    return SentenceTransformer(EMBED_MODEL)


def cached_encode(name: str, texts: list[str]):
    """Encode once, then reuse from disk. The cache path is keyed by model and by a hash of the
    texts, so switching models or editing the corpus can never mix vectors from two spaces."""
    import numpy as np  # installed with sentence-transformers
    key = hashlib.sha1("\n".join(texts).encode()).hexdigest()[:16]
    path = DATA_DIR / "index" / EMBED_MODEL / f"{name}-{key}.npy"
    if path.exists():
        return np.load(path)
    vecs = sentence_model().encode(texts, normalize_embeddings=True, show_progress_bar=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, vecs)
    return vecs


class Embeddings:
    """Optional semantic tier. Loads only if sentence-transformers is installed."""

    def __init__(self, chunks):
        self.model = sentence_model()
        self.vecs = cached_encode("corpus", [f"{c.title}. {c.section}. {c.text}" for c in chunks])

    def scores(self, query: str):
        v = self.model.encode([query], normalize_embeddings=True)[0]
        return self.vecs @ v


@dataclass
class Hit:
    chunk: Chunk
    score: float

    def to_dict(self):
        c = self.chunk
        return {"source_id": c.source_id, "title": c.title, "section": c.section, "kind": c.kind,
                "text": c.text, "meta": c.meta, "score": round(self.score, 3)}


class Index:
    def __init__(self):
        self.chunks = load_chunks()
        self.by_id = {c.source_id: c for c in self.chunks}
        self.bm25 = BM25(self.chunks)
        self.tier = "bm25"
        self.emb = None
        try:
            self.emb = Embeddings(self.chunks)
            self.tier = "embeddings+bm25"
        except Exception:
            pass

    def search(self, query: str, k: int = 6, kinds: set[str] | None = None) -> list[Hit]:
        raw = [t for t in TOKEN.findall(query.lower()) if t not in STOP]
        q = tokenize(query) + [stem(s) for t in raw for s in SYNONYMS.get(t, []) + SYNONYMS.get(stem(t), [])]
        scores = [self.bm25.score(q, i) for i in range(len(self.chunks))]
        if self.emb is not None:
            sem = self.emb.scores(query)
            top = max(scores) or 1.0
            scores = [0.5 * s / top * 8 + 0.5 * float(e) * 8 for s, e in zip(scores, sem)]
        hits = [Hit(c, s * KIND_WEIGHT.get(c.kind, 1.0)) for c, s in zip(self.chunks, scores)
                if s > 0 and (not kinds or c.kind in kinds)]
        hits.sort(key=lambda h: -h.score)
        out, seen = [], set()
        for h in hits:  # templated transcripts repeat; keep one of each
            key = h.chunk.text[:80]
            if key not in seen:
                seen.add(key)
                out.append(h)
        return out[:k]

    def best_quote(self, source_id: str, query: str) -> str:
        """The sentence in a chunk that overlaps the query most (offline Librarian)."""
        c = self.by_id[source_id]
        q = set(tokenize(query))
        q |= {stem(s) for t in list(q) for s in SYNONYMS.get(t, [])}
        sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", c.text) if len(s.strip()) > 20]
        if not sents:
            return c.text[:240]
        return max(sents, key=lambda s: (len(q & set(tokenize(s))), -abs(len(s) - 140)))


@lru_cache(maxsize=1)
def index() -> Index:
    return Index()


def reload_index() -> Index:
    index.cache_clear()
    return index()
