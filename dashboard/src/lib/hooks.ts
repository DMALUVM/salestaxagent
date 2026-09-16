"use client";

import { useEffect, useState } from "react";

interface UseQueryResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetches all matching rows via GET /api/warehouse (service role).
 * Pagination past the PostgREST 1 000-row default happens on the server.
 */
export function useSupabaseQuery<T>(
  table: string,
  options?: {
    orderBy?: string;
    ascending?: boolean;
    filters?: Record<string, unknown>;
    limit?: number;
  }
): UseQueryResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchAll() {
      setLoading(true);
      try {
        const params = new URLSearchParams({ table });
        if (options?.orderBy) params.set("orderBy", options.orderBy);
        if (options?.ascending != null) params.set("ascending", String(options.ascending));
        if (options?.limit) params.set("limit", String(options.limit));
        if (options?.filters) {
          for (const [key, value] of Object.entries(options.filters)) {
            params.set(`eq.${key}`, String(value));
          }
        }
        const resp = await fetch(`/api/warehouse?${params}`, { cache: "no-store" });
        const body = await resp.json().catch(() => ({}));
        if (cancelled) return;
        if (!resp.ok) {
          setError(
            (body && typeof body === "object" && "error" in body && body.error
              ? String(body.error)
              : `HTTP ${resp.status}`),
          );
          return;
        }
        setData((Array.isArray(body) ? body : []) as T[]);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [table, tick]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}

/**
 * Fetches sales_daily via the server-side API route (bypasses RLS).
 */
export function useSalesDaily<T>(): UseQueryResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const resp = await fetch("/api/sales-daily");
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          if (!cancelled) setError(body.error ?? `HTTP ${resp.status}`);
          return;
        }
        const rows = await resp.json();
        if (!cancelled) { setData(rows as T[]); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [tick]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}

/**
 * Fetches combined inventory data via server-side API route.
 */
export function useInventory() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const resp = await fetch("/api/inventory", { cache: "no-store" });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          if (!cancelled) setError(body.error ?? `HTTP ${resp.status}`);
          return;
        }
        const payload = await resp.json();
        if (!cancelled) { setData(payload); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [tick]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}
