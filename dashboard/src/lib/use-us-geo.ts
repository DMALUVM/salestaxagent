"use client";

import { useEffect, useState } from "react";

/** A projected US state SVG path. */
export interface GeoFeature {
  stateCode: string;
  name: string;
  path: string;
}

const FIPS_TO_STATE: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
  "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
  "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
  "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
  "56": "WY",
};

/** Lazily loads US Census TIGER boundaries and projects to Albers USA SVG. */
export function useUSGeo(): GeoFeature[] {
  const [features, setFeatures] = useState<GeoFeature[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [topoMod, geoMod, atlas] = await Promise.all([
        import("topojson-client"),
        import("d3-geo"),
        import("us-atlas/states-10m.json"),
      ]);
      if (cancelled) return;

      const topo = atlas.default as any;
      const geo = topoMod.feature(topo, topo.objects.states) as any;
      const projection = geoMod.geoAlbersUsa().fitSize([975, 610], geo);
      const pathGen = geoMod.geoPath(projection);

      const feats: GeoFeature[] = [];
      for (const f of geo.features) {
        const fips = String(f.id).padStart(2, "0");
        const sc = FIPS_TO_STATE[fips];
        if (!sc) continue;
        const d = pathGen(f);
        if (!d) continue;
        feats.push({ stateCode: sc, name: f.properties?.name ?? sc, path: d });
      }
      setFeatures(feats);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return features;
}

/** Reactively tracks the dark class on <html>. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const check = () => document.documentElement.classList.contains("dark");
    setDark(check());
    const obs = new MutationObserver(() => setDark(check()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);
  return dark;
}
