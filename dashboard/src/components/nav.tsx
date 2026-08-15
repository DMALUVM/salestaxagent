"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  DollarSign,
  Calendar,
  ClipboardCheck,
  MapPin,
  BookOpen,
  Database,
  Shield,
  Menu,
  Moon,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useEffect, useState } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const primaryLinks: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/liability", label: "What Do I Owe?", icon: DollarSign },
  { href: "/calendar", label: "Filing Calendar", icon: Calendar },
  { href: "/registrations", label: "Registrations", icon: ClipboardCheck },
];

const monitorLinks: NavItem[] = [
  { href: "/nexus", label: "Nexus Monitor", icon: MapPin },
  { href: "/rules", label: "Rules & Rulings", icon: BookOpen },
  { href: "/data", label: "Data & Sync", icon: Database },
];

function NavLinks({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();

  function renderLink(item: NavItem) {
    const active =
      item.href === "/"
        ? pathname === "/"
        : pathname.startsWith(item.href);
    const Icon = item.icon;
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
