import { getServerSupabase } from "@/lib/supabase-server";
import {
  PAID_ADS_ATTRIBUTION,
  PAID_ADS_CHANNELS,
  PAID_ADS_WINDOWS,
  latestAsOf,
  normalizePaidAdsChannel,
  normalizePaidAdsWindow,
  selectChannelWindow,
  type PaidAdsCampaignDailyRow,
  type PaidAdsChannel,
  type PaidAdsDailyRow,
  type PaidAdsSnapshotRow,
  type PaidAdsWindowDays,
} from "@/lib/paid-ads";

const PAGE = 1000;

function isMissingTable(message: string): boolean {
  return /does not exist|schema cache|PGRST205/i.test(message);
}

async function selectAll<T>(
  table: string,
  columns: string,
  orderCol: string,
): Promise<{ rows: T[]; error: string | null; missing: boolean }> {
  try {
    const sb = getServerSupabase();
    const rows: T[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select(columns)
        .order(orderCol, { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        const msg = error.message;
        if (isMissingTable(msg)) return { rows: [], error: null, missing: true };
        return { rows: [], error: `${table}: ${msg}`, missing: false };
      }
      const page = (data ?? []) as T[];
      rows.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return { rows, error: null, missing: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissingTable(msg) || /Supabase not configured/.test(msg)) {
      return { rows: [], error: msg.includes("configured") ? msg : null, missing: !msg.includes("configured") };
    }
    return { rows: [], error: `${table}: ${msg}`, missing: false };
  }
}

function viewsForChannel(
  channel: PaidAdsChannel,
  daily: PaidAdsDailyRow[],
  campaigns: PaidAdsCampaignDailyRow[],
  snapshots: PaidAdsSnapshotRow[],
  windowDays?: PaidAdsWindowDays,
) {
  const as_of = latestAsOf({
    daily: daily.filter((r) => r.channel === channel),
    snapshots: snapshots.filter((r) => r.channel === channel),
  });
  const windows = (windowDays ? [windowDays] : PAID_ADS_WINDOWS).map((days) =>
    selectChannelWindow({ channel, windowDays: days, daily, campaigns, snapshots, asOf: as_of }),
  );
  return { as_of, windows };
}

/**
 * GET /api/paid-ads?channel=google_ads&window=7
 *
 * Service-role read of paid_ads_*. Default: both channels, all windows.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const channelFilter = normalizePaidAdsChannel(url.searchParams.get("channel"));
    const windowFilter = normalizePaidAdsWindow(url.searchParams.get("window"));
    const loadErrors: string[] = [];

    const [dailyRes, campRes, snapRes] = await Promise.all([
      selectAll<PaidAdsDailyRow>(
        "paid_ads_daily",
        "channel,date,spend,sales_or_conv_value,clicks,impressions,cpc,conversions,roas,currency,source,ingested_at",
        "date",
      ),
      selectAll<PaidAdsCampaignDailyRow>(
        "paid_ads_campaigns_daily",
        "channel,date,campaign_id,campaign_name,spend,sales_or_conv_value,clicks,impressions,cpc,conversions,roas,ingested_at",
        "date",
      ),
      selectAll<PaidAdsSnapshotRow>(
        "paid_ads_snapshots",
        "channel,as_of,window_days,spend,sales_or_conv_value,clicks,impressions,cpc,conversions,roas,currency,metrics,source,ingested_at",
        "as_of",
      ),
    ]);

    const missing = dailyRes.missing && campRes.missing && snapRes.missing;
    for (const res of [dailyRes, campRes, snapRes]) {
      if (res.error) loadErrors.push(res.error);
    }

    const channels = channelFilter ? [channelFilter] : [...PAID_ADS_CHANNELS];
    const byChannel = Object.fromEntries(
      channels.map((channel) => [
        channel,
        viewsForChannel(channel, dailyRes.rows, campRes.rows, snapRes.rows, windowFilter ?? undefined),
      ]),
    );

    return Response.json({
      attribution: PAID_ADS_ATTRIBUTION,
      channels: byChannel,
      windows: PAID_ADS_WINDOWS,
      migration_needed: missing,
      loadErrors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({
      attribution: PAID_ADS_ATTRIBUTION,
      channels: {},
      windows: PAID_ADS_WINDOWS,
      fatalError: msg,
      loadErrors: [msg],
    }, { status: 500 });
  }
}
