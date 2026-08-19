import { NextRequest } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * GET /api/forecast-sku?sku=X&end=YYYY-MM-DD&start=YYYY-MM-DD&safety=0.15
 *
 * Runs the Python forecast engine and returns JSON.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const sku = url.searchParams.get("sku");
    const end = url.searchParams.get("end");
    const start = url.searchParams.get("start") || "";
    const safety = url.searchParams.get("safety") || "0.15";

    if (!sku || !end) {
      return Response.json({ error: "sku and end params required" }, { status: 400 });
    }

    // Run Python forecast engine as subprocess
    const startArg = start ? `start_date='${start}',` : "";
    const cmd = `cd ${process.cwd()} && python -c "
import json
from src.forecast.sku_demand import forecast_sku
result = forecast_sku('${sku.replace(/'/g, "")}', '${end.replace(/'/g, "")}', ${startArg} safety_pct=${parseFloat(safety)})
print(json.dumps(result, default=str))
"`;

    const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
    if (stderr && !stdout.trim()) {
      return Response.json({ error: stderr.slice(0, 500) }, { status: 500 });
    }

    const result = JSON.parse(stdout.trim());
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
