"use client";

import { useEffect, useState } from "react";
import { getSupabase, isConfigured } from "./supabase";

interface UseQueryResult<T> {
  data: T[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Fetches all matching rows from a Supabase table, paginating past
 * the PostgREST 1 000-row default when necessary.
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
    if (!isConfigured()) {
      setLoading(false);
      setError("Supabase not configured");
      return;
    }

    let cancelled = false;

    async function fetchPage(from: number, to: number) {
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

      query = query.range(from, to);
      return query;
    }

    async function fetchAll() {
      setLoading(true);
      try {
        const PAGE = 1000;

        // If a small explicit limit is set, single fetch is fine
        if (options?.limit && options.limit <= PAGE) {
          const { data: rows, error: err } = await fetchPage(
            0,
            options.limit - 1,
          );
          if (cancelled) return;
          if (err) {
            setError(err.message);
          } else {
            setData((rows ?? []) as T[]);
            setError(null);
          }
          return;
        }

        // Paginate to get all rows
        const all: T[] = [];
        let offset = 0;
        while (true) {
          const { data: rows, error: err } = await fetchPage(
            offset,
            offset + PAGE - 1,
          );
          if (cancelled) return;
          if (err) {
            setError(err.message);
            return;
          }
          const page = (rows ?? []) as T[];
          all.push(...page);
          if (page.length < PAGE) break;
          offset += PAGE;
        }

        if (!cancelled) {
          setData(all);
          setError(null);
        }
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
