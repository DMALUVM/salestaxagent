/**
 * Keep /ppc marked full-width so Org rank stays opted out if a site-wide
 * max-w-* is ever reintroduced on the root content column.
 */
export default function PpcLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-full-width className="w-full">
      {children}
    </div>
  );
}
