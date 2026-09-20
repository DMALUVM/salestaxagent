/**
 * Keep /shopper marked full-width so a site-wide max-w-* cannot pinch
 * the funnel + abandon table the way /ppc already opted out.
 */
export default function ShopperLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-full-width className="w-full">
      {children}
    </div>
  );
}
