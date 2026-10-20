import {
  Activity,
  ArrowRightLeft,
  BarChart3,
  BookUser,
  Briefcase,
  Building2,
  Calculator,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  FileSignature,
  FileText,
  Filter,
  Gauge,
  GitBranch,
  HardHat,
  Inbox,
  KeyRound,
  Landmark,
  LayoutDashboard,
  Map,
  MapPinned,
  Network,
  Percent,
  PieChart,
  Plug,
  Radar,
  Receipt,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldCheck,
  ShieldHalf,
  Sparkles,
  Store,
  Truck,
  Umbrella,
  Upload,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Permission module required to see this entry. */
  module?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard, module: "dashboard" },
      { label: "Daily queue", href: "/queue", icon: Inbox, module: "outreach" },
      { label: "Tasks & alerts", href: "/tasks", icon: CheckSquare, module: "tasks" },
      { label: "Reports", href: "/reports", icon: BarChart3, module: "reports" },
      { label: "Ask EquitiFy", href: "/ask", icon: Sparkles, module: "properties" },
    ],
  },
  {
    label: "Acquisitions",
    items: [
      { label: "Pipeline", href: "/pipeline", icon: GitBranch, module: "pipeline" },
      { label: "Properties", href: "/properties", icon: Building2, module: "properties" },
      { label: "Map", href: "/map", icon: Map, module: "map" },
      { label: "Signals", href: "/signals", icon: Radar, module: "signals" },
      { label: "Scoring", href: "/scoring", icon: Gauge, module: "scoring" },
      { label: "Reactivation", href: "/reactivation", icon: RotateCcw, module: "reactivation" },
      { label: "Buy boxes", href: "/buy-boxes", icon: Filter, module: "buybox" },
      { label: "Parcels & spaces", href: "/parcels", icon: MapPinned, module: "parcels" },
    ],
  },
  {
    label: "Deal execution",
    items: [
      { label: "Underwriting", href: "/underwriting", icon: Calculator, module: "underwriting" },
      { label: "Comparables", href: "/comps", icon: Scale, module: "comps" },
      { label: "Offers & LOIs", href: "/offers", icon: FileSignature, module: "offers" },
      { label: "Contracts & DD", href: "/contracts", icon: ClipboardCheck, module: "contracts" },
      { label: "Critical dates", href: "/critical-dates", icon: CalendarClock, module: "contracts" },
      { label: "Closings", href: "/closings", icon: KeyRound, module: "closing" },
    ],
  },
  {
    label: "Portfolio",
    items: [
      { label: "Assets", href: "/assets", icon: PieChart, module: "assets" },
      { label: "Leases & rent roll", href: "/leases", icon: ScrollText, module: "leases" },
      { label: "Receivables", href: "/receivables", icon: Receipt, module: "receivables" },
      { label: "Loans & debt", href: "/loans", icon: Landmark, module: "debt" },
      { label: "Dispositions", href: "/dispositions", icon: ArrowRightLeft, module: "dispositions" },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Work orders", href: "/work-orders", icon: Wrench, module: "maintenance" },
      { label: "Inspections", href: "/inspections", icon: ClipboardList, module: "maintenance" },
      { label: "Vendors", href: "/vendors", icon: Truck, module: "operations" },
      { label: "Capital projects", href: "/capital-projects", icon: HardHat, module: "operations" },
      { label: "Insurance & tax", href: "/insurance", icon: Umbrella, module: "operations" },
      { label: "Budgets", href: "/budgets", icon: Wallet, module: "operations" },
    ],
  },
  {
    label: "Brokerage & capital",
    items: [
      { label: "Listings", href: "/listings", icon: Store, module: "brokerage" },
      { label: "Brokerage CRM", href: "/brokerage", icon: Briefcase, module: "brokerage" },
      { label: "Tours & deal rooms", href: "/tours", icon: CalendarDays, module: "dealroom" },
      { label: "Commissions", href: "/commissions", icon: Percent, module: "commissions" },
      { label: "Capital partners", href: "/investors", icon: Users, module: "investors" },
    ],
  },
  {
    label: "Relationships",
    items: [
      { label: "People", href: "/people", icon: BookUser, module: "contacts" },
      { label: "Organizations", href: "/organizations", icon: Building2, module: "contacts" },
      { label: "Ownership", href: "/ownership", icon: Network, module: "ownership" },
      { label: "Interactions", href: "/interactions", icon: Activity, module: "outreach" },
    ],
  },
  {
    label: "Geography",
    items: [
      { label: "Territories", href: "/territories", icon: MapPinned, module: "territories" },
      { label: "Corridors & nodes", href: "/geography", icon: Map, module: "territories" },
    ],
  },
  {
    label: "Data & documents",
    items: [
      { label: "Documents", href: "/documents", icon: FileText, module: "documents" },
      { label: "Imports", href: "/imports", icon: Upload, module: "imports" },
      { label: "Data quality", href: "/data-quality", icon: ClipboardList, module: "properties" },
      { label: "Compliance", href: "/compliance", icon: ShieldCheck, module: "compliance" },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Users", href: "/admin/users", icon: Users, module: "users" },
      { label: "Roles & access", href: "/admin/roles", icon: ShieldHalf, module: "users" },
      { label: "Platform & integrations", href: "/admin/platform", icon: Plug, module: "platform" },
      { label: "Audit log", href: "/admin/audit", icon: ScrollText, module: "audit" },
    ],
  },
];
