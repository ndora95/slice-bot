"""Thin wrapper around the Anthropic SDK for the bots.

One call shape for every bot: a cached system prompt, optional strict tools
run in a short loop, and a JSON-schema structured output so each bot returns
data the pipeline can check, never free text. Effort is set per bot.
Refusals fall back server-side (`fallbacks: "default"`).
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Callable

import anthropic

from slicebot.config import EFFORT, MODEL, PRICE_CACHE_READ, PRICE_IN, PRICE_OUT


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    calls: int = 0
    ms: int = 0

    def add(self, u, ms: int = 0):
        self.input_tokens += getattr(u, "input_tokens", 0) or 0
        self.output_tokens += getattr(u, "output_tokens", 0) or 0
        self.cache_read_tokens += getattr(u, "cache_read_input_tokens", 0) or 0
        self.cache_write_tokens += getattr(u, "cache_creation_input_tokens", 0) or 0
        self.calls += 1
        self.ms += ms

    def merge(self, o: "Usage"):
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "calls", "ms"):
            setattr(self, k, getattr(self, k) + getattr(o, k))

    @property
    def cost(self) -> float:
        return (self.input_tokens * PRICE_IN + self.cache_write_tokens * PRICE_IN * 1.25
                + self.cache_read_tokens * PRICE_CACHE_READ + self.output_tokens * PRICE_OUT) / 1e6

    def to_dict(self):
        return {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
                "cache_read_tokens": self.cache_read_tokens, "calls": self.calls, "ms": self.ms,
                "cost_usd": round(self.cost, 4)}


class LLMError(Exception):
    pass


@dataclass
class BotCall:
    """What one bot call produced: the parsed output plus the tool calls it made."""
    output: dict
    tool_calls: list = field(default_factory=list)  # (name, args, ToolResult)
    usage: Usage = field(default_factory=Usage)


_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        # A key that isn't scoped to a workspace has to name one on every request.
        workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")
        headers = {"anthropic-workspace-id": workspace} if workspace else None
        _client = anthropic.Anthropic(max_retries=2, timeout=90.0, default_headers=headers)
    return _client


def call_bot(bot: str, system: str, user: str, schema: dict, *, tools: list[dict] | None = None,
             run_tool: Callable[[str, dict], object] | None = None, max_turns: int = 5) -> BotCall:
    """Run one bot to a structured result, executing its tool calls in between."""
    messages: list[dict] = [{"role": "user", "content": user}]
    result = BotCall(output={})
    params = dict(
        model=MODEL,
        max_tokens=16000,
        system=[{"type": "text", "text": system}],
        output_config={"effort": EFFORT.get(bot, "medium"), "format": {"type": "json_schema", "schema": schema}},
        cache_control={"type": "ephemeral"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if tools:
        params["tools"] = tools
    for _ in range(max_turns):
        t0 = time.monotonic()
        try:
            resp = client().beta.messages.create(messages=messages, **params)
        except anthropic.AuthenticationError as e:
            raise LLMError("Claude API key was rejected") from e
        except anthropic.RateLimitError as e:
            raise LLMError("Claude API rate limit reached") from e
        except anthropic.BadRequestError as e:
            raise LLMError(f"Claude API rejected the request: {e.message}") from e
        except anthropic.APIStatusError as e:
            raise LLMError(f"Claude API error {e.status_code}") from e
        except anthropic.APIConnectionError as e:
            raise LLMError("Could not reach the Claude API") from e
        result.usage.add(resp.usage, int((time.monotonic() - t0) * 1000))

        if resp.stop_reason == "refusal":
            raise LLMError(f"{bot} request was declined")
        if resp.stop_reason == "tool_use" and run_tool:
            messages.append({"role": "assistant", "content": resp.content})
            results = []
            for block in resp.content:
                if block.type != "tool_use":
                    continue
                tr = run_tool(block.name, dict(block.input))
                result.tool_calls.append((block.name, dict(block.input), tr))
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": tr.for_model(), "is_error": not tr.ok})
            messages.append({"role": "user", "content": results})  # all results in one message
            continue
        if resp.stop_reason == "max_tokens":
            raise LLMError(f"{bot} ran out of output tokens")
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            result.output = json.loads(text)
        except json.JSONDecodeError as e:
            raise LLMError(f"{bot} returned invalid JSON") from e
        return result
    raise LLMError(f"{bot} did not finish within {max_turns} turns")
