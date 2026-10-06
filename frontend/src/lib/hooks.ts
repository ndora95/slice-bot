import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** Fetch JSON, refetch when `key` changes. */
export function useApi<T>(path: string | null, key: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api.get<T>(path).then((d) => { setData(d); setError(null); }).catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
  }, [path]);
  useEffect(() => { load(); }, [load, key]);
  return { data, error, loading, reload: load, setData };
}
