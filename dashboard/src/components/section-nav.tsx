/**
 * Sticky in-page jump links for long ops pages (P&L, PPC).
 * Anchors must exist on the page; this is navigation only.
 */
export function SectionNav({
  items,
}: {
  items: Array<{ id: string; label: string }>;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="On this page"
      className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <div className="flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="shrink-0 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
