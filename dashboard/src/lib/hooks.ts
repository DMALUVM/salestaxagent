"use client";

import { useEffect, useState } from "react";
import { getSupabase, isConfigured } from "./supabase";

interface UseQueryResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

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
    if (!isConfigured()) {
      setLoading(false);
      setError("Supabase not configured");
      return;
    }

    let cancelled = false;
    async function fetch() {
      setLoading(true);
      try {
        let query = getSupabase().from(table).select("*");

        if (options?.filters) {
          for (const [key, value] of Object.entries(options.filters)) {
            query = query.eq(key, value);
          }
        }

        if (options?.orderBy) {
          query = query.order(options.orderBy, {
            ascending: options.ascending ?? false,
          });
        }

        if (options?.limit) {
          query = query.limit(options.limit);
        }

        const { data: rows, error: err } = await query;
        if (cancelled) return;
        if (err) {
          setError(err.message);
        } else {
          setData((rows ?? []) as T[]);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetch();
    return () => {
      cancelled = true;
    };
  }, [table, tick]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}
