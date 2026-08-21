import {
  Boxes,
  Briefcase,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  ClipboardList,
  Contact,
  FileText,
  Gauge,
  LayoutGrid,
  Package,
  Receipt,
  Settings,
  ShoppingCart,
  TrendingUp,
  User,
  Users,
  Wallet,
} from "lucide-react";

/**
 * The icons the sidebar can draw, by name.
 *
 * A module names an icon in a string rather than importing one, because a
 * module is built separately and shipped as a bundle — it cannot share this
 * application's React tree, and two copies of an icon library in one page is
 * a hundred kilobytes nobody sees.
 *
 * An unknown name falls back rather than throwing. A module built against a
 * later host will ask for icons this one has never heard of, and a missing
 * picture must never be the reason a sidebar fails to render.
 */
const ICONS = {
  boxes: Boxes,
  briefcase: Briefcase,
  building: Building2,
  calendar: CalendarDays,
  chart: ChartNoAxesColumn,
  clipboard: ClipboardList,
  contact: Contact,
  "file-text": FileText,
  gauge: Gauge,
  layout: LayoutGrid,
  package: Package,
  receipt: Receipt,
  settings: Settings,
  shop: ShoppingCart,
  "trending-up": TrendingUp,
  user: User,
  users: Users,
  wallet: Wallet,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
}: {
  name: IconName | (string & {});
  size?: number;
}) {
  const Glyph = ICONS[name as IconName] ?? LayoutGrid;
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      className="shrink-0"
    />
  );
}
