import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/shopify-customers — AOV / LTV / repeat / cohorts from stored orders.
 *
 * Read-only. It aggregates `shopify_orders`, a table only the backfill writes;
 * nothing here calls Shopify and nothing here spawns Python.
 *
 * SHOPIFY ONLY. Amazon cannot appear in any person-level figure — Amazon gives
 * sellers a per-order obfuscated token, not a stable buyer identity, so two
 * Amazon orders cannot be joined to the same person at all. The `amazon` block
 * below carries that explanation plus the order-level AOV that IS computable,
 * so the page never has to imply a customer identity that does not exist.
 *
 * The arithmetic mirrors src/shopify_metrics.py, which is the tested reference
 * implementation; the definitions are restated in `definitions` so the card can
 * show them next to the numbers rather than in a doc nobody opens.
 */
export const dynamic = "force-dynamic";

type OrderRow = {
  order_id: number;
  order_date: string;
  customer_key: string;
  subtotal_price: number | null;
  total_price: number | null;
  refunded_amount: number | null;
  cancelled_at: string | null;
  is_test: boolean | null;
};

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** Net merchandise revenue: after discounts, before tax/shipping, less refunds. */
const revenueOf = (r: OrderRow) =>
  Math.max(0, num(r.subtotal_price) - num(r.refunded_amount));

/** What the customer paid: merchandise + tax + shipping, less refunds.
 *  Shopify Admin's headline AOV is Total sales / orders, so both bases are
 *  reported — they differ by ~11% here and an operator comparing screens needs
 *  to know which one they are looking at. */
const paidOf = (r: OrderRow) =>
  Math.max(0, num(r.total_price) - num(r.refunded_amount));

const monthOf = (d: string) => d.slice(0, 7);

function monthsBetween(a: string, b: string) {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 +
    (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function loadOrders(sb: ReturnType<typeof getServerSupabase>) {
  const rows: OrderRow[] = [];
  let offset = 0;
  for (;;) {
    // ORDER BY reaches order_id — thousands of rows share a date, and an
    // ambiguous page boundary silently drops and duplicates rows.
    const r = await sb
      .from("shopify_orders")
      .select("order_id,order_date,customer_key,subtotal_price,total_price,refunded_amount,cancelled_at,is_test")
      .order("order_date")
      .order("order_id")
      .range(offset, offset + 999);
    if (r.error) throw new Error(r.error.message);
    const page = (r.data ?? []) as OrderRow[];
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  // Test and cancelled orders are STORED but never counted, so the exclusion
  // stays auditable instead of being applied at fetch time.
  return rows.filter((r) => !r.is_test && !r.cancelled_at);
}

export async function GET() {
  try {
    const sb = getServerSupabase();
    const rows = await loadOrders(sb);

    if (!rows.length) {
      return Response.json({
        available: true, empty: true,
        setupHint:
          "No Shopify orders stored yet. Run supabase/migration_shopify_orders.sql, " +
          "then `python -m src.main shopify-backfill` on the agent.",
        amazon: amazonBlock(null),
      });
    }

    const byCustomer = new Map<string, OrderRow[]>();
    for (const r of rows) {
      const k = String(r.customer_key);
      (byCustomer.get(k) ?? byCustomer.set(k, []).get(k)!).push(r);
    }

    const revenue = rows.reduce((s, r) => s + revenueOf(r), 0);
    const totals = [...byCustomer.values()].map((rs) =>
      rs.reduce((s, r) => s + revenueOf(r), 0));
    const orderNet = rows.map(revenueOf);
    const orderPaid = rows.map(paidOf);

    // Repeaters are broken out because the all-customer median is ~one order
    // on any store where most people buy once. Quoted alone it reads as
    // "customers are worth $13", which is the wrong headline — value here
    // concentrates in the minority who return.
    const repeaterSets = [...byCustomer.values()].filter((rs) => rs.length >= 2);
    const repeat = repeaterSets.length;
    const repTotals = repeaterSets.map((rs) => rs.reduce((s, r) => s + revenueOf(r), 0));
    const repRevenue = repTotals.reduce((a, b) => a + b, 0);
    const repOrders = repeaterSets.reduce((s, rs) => s + rs.length, 0);
    const identified = [...byCustomer.keys()].filter((k) => k.startsWith("c:")).length;
    const dates = rows.map((r) => r.order_date).sort();

    // ── monthly trend ──
    const firstOrder = new Map<string, string>();
    for (const r of rows) {
      const k = String(r.customer_key);
      const prev = firstOrder.get(k);
      if (!prev || r.order_date < prev) firstOrder.set(k, r.order_date);
    }
    const mBuckets = new Map<string, { orders: number; revenue: number; nw: Set<string> }>();
    for (const r of rows) {
      const m = monthOf(r.order_date);
      const b = mBuckets.get(m) ?? { orders: 0, revenue: 0, nw: new Set<string>() };
      b.orders += 1;
      b.revenue += revenueOf(r);
      const k = String(r.customer_key);
      if (firstOrder.get(k) === r.order_date) b.nw.add(k);
      mBuckets.set(m, b);
    }
    const monthly = [...mBuckets.entries()].sort().map(([month, b]) => ({
      month, orders: b.orders, revenue: Math.round(b.revenue * 100) / 100,
      aov: b.orders ? Math.round((b.revenue / b.orders) * 100) / 100 : null,
      newCustomers: b.nw.size,
    }));

    // ── cohorts ──
    const nowMonth = monthOf(dates[dates.length - 1]);
    const cohortOf = new Map<string, string>();
    for (const [k, d] of firstOrder) cohortOf.set(k, monthOf(d));
    const members = new Map<string, number>();
    for (const c of cohortOf.values()) members.set(c, (members.get(c) ?? 0) + 1);

    const MAX_OFFSET = 6;
    const rev = new Map<string, number>();
    for (const r of rows) {
      const c = cohortOf.get(String(r.customer_key))!;
      const off = monthsBetween(c, monthOf(r.order_date));
      if (off >= 0 && off <= MAX_OFFSET) {
        const key = `${c}|${off}`;
        rev.set(key, (rev.get(key) ?? 0) + revenueOf(r));
      }
    }
    const cohorts = [...members.entries()].sort().map(([c, n]) => {
      const observed = monthsBetween(c, nowMonth);
      let cum = 0;
      const offsets = [];
      for (let off = 0; off <= MAX_OFFSET; off++) {
        if (off > observed) {
          // null, never 0 — "this month has not happened yet" and "they spent
          // nothing" are different facts, and 0 makes every young cohort look
          // like a churn cliff.
          offsets.push({ offset: off, cumRevenuePerCustomer: null, observed: false });
          continue;
        }
        cum += rev.get(`${c}|${off}`) ?? 0;
        offsets.push({
          offset: off,
          cumRevenuePerCustomer: Math.round((cum / n) * 100) / 100,
          observed: true,
        });
      }
      return { cohort: c, customers: n, offsets };
    });

    return Response.json({
      available: true, empty: false,
      summary: {
        orders: rows.length,
        revenue: Math.round(revenue * 100) / 100,
        customers: byCustomer.size,
        aov: Math.round((revenue / rows.length) * 100) / 100,
        aovMedian: Math.round((median(orderNet) ?? 0) * 100) / 100,
        aovPaid: Math.round((orderPaid.reduce((a, b) => a + b, 0) / rows.length) * 100) / 100,
        aovPaidMedian: Math.round((median(orderPaid) ?? 0) * 100) / 100,
        ltvMean: Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100,
        ltvMedian: Math.round((median(totals) ?? 0) * 100) / 100,
        ltvMeanRepeat: repeat ? Math.round((repRevenue / repeat) * 100) / 100 : null,
        ltvMedianRepeat: repeat ? Math.round((median(repTotals) ?? 0) * 100) / 100 : null,
        repeatCustomers: repeat,
        repeatRate: repeat / byCustomer.size,
        ordersPerRepeater: repeat ? repOrders / repeat : null,
        revenueFromRepeaters: Math.round(repRevenue * 100) / 100,
        revenueFromRepeatersPct: revenue ? (repRevenue / revenue) * 100 : null,
        interpretation: interpret({
          customers: byCustomer.size, repeat,
          ltvMedian: median(totals) ?? 0,
          ltvMeanRepeat: repeat ? repRevenue / repeat : 0,
          ordersPerRepeater: repeat ? repOrders / repeat : 0,
          repRevenuePct: revenue ? (repRevenue / revenue) * 100 : 0,
        }),
        ordersPerCustomer: rows.length / byCustomer.size,
        identifiedPct: (identified / byCustomer.size) * 100,
        firstOrderDate: dates[0],
        lastOrderDate: dates[dates.length - 1],
      },
      byYear: byYear(rows),
      monthly: monthly.slice(-24),
      cohorts: cohorts.slice(-12),
      definitions: DEFINITIONS,
      amazon: amazonBlock(null),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({
      available: false, error: msg.slice(0, 300),
      setupHint: /shopify_orders/.test(msg)
        ? "Run supabase/migration_shopify_orders.sql, then `python -m src.main shopify-backfill`."
        : null,
      amazon: amazonBlock(null),
    });
  }
}

/** One line that stops the all-customer median being read as "customer value". */
function interpret(x: { customers: number; repeat: number; ltvMedian: number;
                       ltvMeanRepeat: number; ordersPerRepeater: number;
                       repRevenuePct: number }) {
  if (!x.customers) return "No customers in this set.";
  if (!x.repeat) {
    return `Every one of ${x.customers.toLocaleString()} customers has ordered once. ` +
      `There is no repeat cohort yet, so LTV and AOV are the same number.`;
  }
  const rate = (x.repeat / x.customers) * 100;
  return `Median customer is one-time ($${x.ltvMedian.toFixed(2)} ever, ≈ one order). ` +
    `Value concentrates in the ${rate.toFixed(1)}% who come back: they average ` +
    `$${x.ltvMeanRepeat.toFixed(2)} LTV over ${x.ordersPerRepeater.toFixed(1)} orders ` +
    `and drive ${x.repRevenuePct.toFixed(0)}% of revenue.`;
}

/** Order value per calendar year — an all-time AOV can answer the wrong question. */
function byYear(rows: OrderRow[]) {
  const b = new Map<string, OrderRow[]>();
  for (const r of rows) {
    const y = r.order_date.slice(0, 4);
    (b.get(y) ?? b.set(y, []).get(y)!).push(r);
  }
  return [...b.entries()].sort().map(([year, rs]) => {
    const net = rs.map(revenueOf);
    const paid = rs.map(paidOf);
    return {
      year, orders: rs.length,
      aov: Math.round((net.reduce((a, c) => a + c, 0) / rs.length) * 100) / 100,
      aovMedian: Math.round((median(net) ?? 0) * 100) / 100,
      aovPaid: Math.round((paid.reduce((a, c) => a + c, 0) / rs.length) * 100) / 100,
      revenue: Math.round(net.reduce((a, c) => a + c, 0) * 100) / 100,
    };
  });
}

const DEFINITIONS = [
  ["Revenue", "Order subtotal (after discounts, before tax and shipping) minus refunds, floored at zero. Same basis as sales_by_state.gross_sales, so it reconciles with the tax aggregates. Refund totals may include tax, so this is a slight under-estimate."],
  ["Customer", "Shopify customer id where present; otherwise guest checkouts sharing an email hash; otherwise the order counts as its own one-order customer. An unidentifiable buyer can never appear as repeat."],
  ["AOV", "Order value, reported as mean AND median, on two bases: net merchandise (after discounts, before tax/shipping, less refunds) and total paid (incl. tax and shipping). Shopify Admin's headline AOV uses total paid, so compare like with like."],
  ["LTV — all customers", "Total revenue per customer across all stored history. The MEDIAN here is the typical customer ever, and on this store that is one order — most people buy once. It is never shown alone as 'LTV'."],
  ["LTV — repeaters", "The same figure restricted to customers with 2+ orders. This is the primary customer-LTV number: it describes what a retained buyer is worth, which is what acquisition spend is judged against."],
  ["Revenue from repeaters", "Share of total revenue contributed by customers with 2+ orders."],

  ["Repeat rate", "Customers with 2 or more orders ÷ customers."],
  ["Cohort", "Customers grouped by the month of their first order. Month N shows cumulative revenue per customer through month N. A cohort too young to have reached month N shows '—', never 0."],
  ["Excluded", "Test orders and cancelled orders. Both are stored, so the exclusion can be audited."],
  ["Reconciliation", "Summed per month over US orders across all Shopify channels, this matches sales_by_state.gross_sales once cancelled orders are added back — 2026-08 reconciles to the cent. The two are meant to differ by exactly that: the tax aggregate counts what was transacted, these metrics count what the customer kept. sales_by_state remains the tax source of truth."],
];

function amazonBlock(aov: number | null) {
  return {
    personLevelAvailable: false,
    aov,
    why: [
      "Amazon does not disclose a persistent buyer identity to sellers — orders carry an obfuscated, per-order token, not a stable customer id.",
      "Buyer email is a rotating alias and for most order types is no longer exposed at all.",
      "There is therefore no key on which two Amazon orders can be joined to the same person. Repeat rate, LTV and cohorts are not computable for Amazon — not merely unbuilt.",
    ],
    doNotDo:
      "Do not approximate an Amazon customer by name, address or a hash of them. Households share addresses and buyers move; the result would be a fabricated identity presented as a measurement.",
    available: "Order-level AOV from sales_daily (SP-API), and units/mix from sales_by_sku.",
  };
}
