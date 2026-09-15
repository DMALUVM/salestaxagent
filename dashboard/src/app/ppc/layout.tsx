/**
 * Org-rank heatmap (and the rest of /ppc) needs the full content column.
 * Root layout stays max-w-6xl unless a descendant sets data-full-width.
 */
export default function PpcLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-full-width className="w-full">
      {children}
    </div>
  );
}
