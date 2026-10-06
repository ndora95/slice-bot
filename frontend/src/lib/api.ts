import type { CaseEvent, CopilotEvent, CrewEvent } from './types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch { /* keep status text */ }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => req<T>(path),
  post: <T,>(path: string, body?: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
};

/** Stream a case run. Returns a function that stops listening. */
export function streamCase(contactId: string, opts: { threshold: number; engine: string },
                           onEvent: (e: CaseEvent) => void, onDone: () => void): () => void {
  const qs = new URLSearchParams({ threshold: String(opts.threshold) });
  if (opts.engine) qs.set('engine', opts.engine);
  const es = new EventSource(`/api/cases/${contactId}/run?${qs}`);
  let finished = false;
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data) as CaseEvent;
    onEvent(ev);
    if (ev.type === 'final' || (ev.type === 'error' && !finished)) {
      if (ev.type === 'final') finished = true;
    }
    if (ev.type === 'final') { es.close(); onDone(); }
  };
  es.onerror = () => { es.close(); if (!finished) onDone(); };
  return () => es.close();
}

/** Stream the repair crew working a set of work orders. Returns a function that stops listening. */
export function streamCrew(woIds: string[], engine: string, onEvent: (e: CrewEvent) => void, onDone: () => void): () => void {
  const qs = new URLSearchParams({ wo_ids: woIds.join(','), engine });
  const es = new EventSource(`/api/repair/crew/run?${qs}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data) as CrewEvent;
    if (ev.type === 'final') { es.close(); onDone(); return; }
    onEvent(ev);
  };
  es.onerror = () => { es.close(); onDone(); };
  return () => es.close();
}

/** Ask the copilot one question. A POST, since it carries the chat so far, read as a server-sent event stream. */
export function streamCopilot(body: unknown, onEvent: (e: CopilotEvent) => void, onDone: () => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch('/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(res.statusText || 'The copilot is unavailable');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) onEvent(JSON.parse(chunk.slice(6)) as CopilotEvent);
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    if (!ctrl.signal.aborted) onDone();
  })();
  return () => ctrl.abort();
}
