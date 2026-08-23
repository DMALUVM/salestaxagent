import { getServerSupabase } from "@/lib/supabase-server";
import {
  PAID_ADS_ATTRIBUTION,
  PAID_ADS_CHANNELS,
  PAID_ADS_WINDOWS,
  latestAsOf,
  normalizePaidAdsChannel,
  normalizePaidAdsWindow,
  rowToCampaignWindow,
  rowToSnapshot,
  selectChannelWindow,
  type PaidAdsCampaignWindowRow,
  type PaidAdsChannel,
  type PaidAdsSnapshotRow,
  type PaidAdsWindowDays,
} from "@/lib/paid-ads";

const PAGE = 1000;

const SNAPSHOT_COLS =
  "channel,as_of,window_days,window_start,window_end,account_label,spend,conv_value,roas,clicks,impressions,conversions,cpc,currency,source,notes,ingested_at";
const CAMPAIGN_COLS =
  "channel,as_of,window_days,campaign_id,campaign_name,spend,conv_value,roas,clicks,impressions,conversions,cpc,status,note,ingested_at";

function isMissingTable(message: string): boolean {
  return /does not exist|schema cache|PGRST205/i.test(message);
}

async function selectAll(
  table: string,
  columns: string,
  orderCol: string,
): Promise<{ rows: Record<string, unknown>[]; error: string | null; missing: boolean }> {
  try {
    const sb = getServerSupabase();
    const rows: Record<string, unknown>[] = [];
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
      const page = (data ?? []) as unknown as Record<string, unknown>[];
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
  snapshots: PaidAdsSnapshotRow[],
  campaignWindows: PaidAdsCampaignWindowRow[],
  windowDays?: PaidAdsWindowDays,
) {
  const as_of = latestAsOf({
    snapshots: snapshots.filter((r) => r.channel === channel),
    campaignWindows: campaignWindows.filter((r) => r.channel === channel),
  });
  const windows = (windowDays ? [windowDays] : PAID_ADS_WINDOWS).map((days) =>
    selectChannelWindow({ channel, windowDays: days, snapshots, campaignWindows, asOf: as_of }),
  );
  return { as_of, windows };
}

/**
 * GET /api/paid-ads?channel=google_ads&window=7
 *
 * Service-role read of paid_ads_snapshots + paid_ads_campaigns_window.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const channelFilter = normalizePaidAdsChannel(url.searchParams.get("channel"));
    const windowFilter = normalizePaidAdsWindow(url.searchParams.get("window"));
    const loadErrors: string[] = [];

    const [snapRes, campRes] = await Promise.all([
      selectAll("paid_ads_snapshots", SNAPSHOT_COLS, "as_of"),
      selectAll("paid_ads_campaigns_window", CAMPAIGN_COLS, "as_of"),
    ]);

    const missing = snapRes.missing && campRes.missing;
    for (const res of [snapRes, campRes]) {
      if (res.error) loadErrors.push(res.error);
    }

    const snapshots = snapRes.rows
      .map(rowToSnapshot)
      .filter((r): r is PaidAdsSnapshotRow => Boolean(r));
    const campaignWindows = campRes.rows
      .map(rowToCampaignWindow)
      .filter((r): r is PaidAdsCampaignWindowRow => Boolean(r));

    const channels = channelFilter ? [channelFilter] : [...PAID_ADS_CHANNELS];
    const byChannel = Object.fromEntries(
      channels.map((channel) => [
        channel,
        viewsForChannel(channel, snapshots, campaignWindows, windowFilter ?? undefined),
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
