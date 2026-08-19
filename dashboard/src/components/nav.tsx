"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  DollarSign,
  Calendar,
  ClipboardCheck,
  MapPin,
  MapPinned,
  Package,
  BookOpen,
  Database,
  Shield,
  Menu,
  Moon,
  Sun,
  ListChecks,
  TrendingUp,
  Warehouse,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useEffect, useState } from "react";
import { getSupabase, isConfigured } from "@/lib/supabase";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const primaryLinks: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/liability", label: "What Do I Owe?", icon: DollarSign },
  { href: "/calendar", label: "Filing Calendar", icon: Calendar },
  { href: "/registrations", label: "Nexus & Registrations", icon: ClipboardCheck },
  { href: "/inventory", label: "Inventory", icon: Warehouse },
  { href: "/forecast", label: "Demand Forecast", icon: TrendingUp },
  { href: "/planner", label: "Inbound Planner", icon: Package },
];

const monitorLinks: NavItem[] = [
  { href: "/amazon", label: "Amazon Ops", icon: TrendingUp },
  { href: "/ppc", label: "Amazon PPC", icon: TrendingUp },
  { href: "/inventory/returns", label: "FBA Returns", icon: RotateCcw },
  { href: "/inventory/3pl", label: "3PL Costs", icon: Package },
  { href: "/sales-map", label: "Sales Map", icon: MapPinned },
  { href: "/skus", label: "SKU Performance", icon: Package },
  { href: "/compliance", label: "Compliance Guides", icon: BookOpen },
  { href: "/data", label: "Data & Export", icon: Database },
];

function useComplianceCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!isConfigured()) return;
    async function load() {
      try {
        const sb = getSupabase();
        // Try with compliance columns first
        const { count: c, error } = await sb
          .from("nexus_status")
          .select("state_code", { count: "exact", head: true })
          .or("has_physical_nexus.eq.true,has_economic_nexus.eq.true")
          .eq("is_registered", false)
          .or("compliance_resolved.is.null,compliance_resolved.eq.false");

        if (!error && typeof c === "number") {
          setCount(c);
          return;
        }
        // Fallback: columns may not exist yet
        const { count: c2 } = await sb
          .from("nexus_status")
          .select("state_code", { count: "exact", head: true })
          .or("has_physical_nexus.eq.true,has_economic_nexus.eq.true")
          .eq("is_registered", false);
        if (typeof c2 === "number") setCount(c2);
      } catch {
        // ignore
      }
    }
    load();
  }, []);
  return count;
}

function NavLinks({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();
  const complianceCount = useComplianceCount();

  function renderLink(item: NavItem) {
    const active =
      item.href === "/"
        ? pathname === "/"
        : pathname.startsWith(item.href);
    const Icon = item.icon;
    const showBadge = item.href === "/compliance" && complianceCount > 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onClick}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          active
            ? "bg-primary/5 text-primary dark:bg-primary/10"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        <Icon className="h-4 w-4" />
        {item.label}
        {showBadge && (
          <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">
            {complianceCount}
          </span>
        )}
      </Link>
    );
  }

  return (
    <nav className="flex flex-col gap-1">
      {primaryLinks.map(renderLink)}
      <div className="mt-4 mb-1 px-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Monitoring
        </span>
      </div>
      {monitorLinks.map(renderLink)}
    </nav>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8">
      {dark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 border-r bg-card lg:flex lg:flex-col">
      <div className="flex h-14 items-center gap-2 px-4">
        <Shield className="h-5 w-5 text-primary" />
        <span className="text-sm font-semibold tracking-tight">
          Sales Tax Agent
        </span>
      </div>
      <Separator />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <NavLinks />
      </div>
      <Separator />
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[11px] text-muted-foreground">
          Monitoring Aid &middot; Not Tax Advice
        </span>
        <ThemeToggle />
      </div>
    </aside>
  );
}

export function MobileHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="flex h-14 items-center gap-3 border-b bg-card px-4 lg:hidden">
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
      >
        <Menu className="h-5 w-5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-60 p-0">
          <div className="flex h-14 items-center gap-2 px-4">
            <Shield className="h-5 w-5 text-primary" />
            <span className="text-sm font-semibold tracking-tight">
              Sales Tax Agent
            </span>
          </div>
          <Separator />
          <div className="px-3 py-3">
            <NavLinks onClick={() => setOpen(false)} />
          </div>
          <Separator />
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[11px] text-muted-foreground">
              Not Tax Advice
            </span>
            <ThemeToggle />
          </div>
        </SheetContent>
      </Sheet>
      <Shield className="h-5 w-5 text-primary" />
      <span className="text-sm font-semibold tracking-tight">
        Sales Tax Agent
      </span>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
