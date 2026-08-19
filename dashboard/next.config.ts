import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The Demand and Inbound planners merged into the /planning hub. Kept
      // permanent so existing bookmarks and links keep working; the tab param
      // lands the reader on the view they asked for.
      { source: "/forecast", destination: "/planning?tab=demand", permanent: true },
      { source: "/planner", destination: "/planning?tab=inbound", permanent: true },
    ];
  },
};

export default nextConfig;
