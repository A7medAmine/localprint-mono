import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Banknote,
  Building2,
  Camera,
  CheckCircle2,
  CloudUpload,
  EyeOff,
  Folder,
  Home,
  HelpCircle,
  Key,
  Link2,
  LogOut,
  MapPin,
  Menu,
  Monitor,
  Moon,
  Package,
  Redo2,
  SlidersHorizontal,
  Sun,
  Tag,
  Undo2,
  Users,
  Database,
  Frown,
  ChevronsLeft,
  ChevronsRight,
  FlipVertical,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleSlash,
  Clock,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Info,
  Loader2,
  Mail,
  Minus,
  Palette,
  Paperclip,
  Pencil,
  Plus,
  Presentation,
  Phone,
  Printer,
  RotateCcw,
  RotateCw,
  Save,
  FlipHorizontal,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  User,
  X,
  Zap,
} from "lucide-react";
import { cn } from "../../utils";

/** The app's whole icon vocabulary. Adding a glyph means adding it here, which
 *  keeps stroke weight, sizing and accessibility consistent — and keeps the
 *  bundle tree-shakeable (a `lucide-react` namespace import would pull in
 *  every icon it ships). */
export const ICONS = {
  alert: AlertTriangle,
  "alert-circle": AlertCircle,
  building: Building2,
  camera: Camera,
  "check-circle": CheckCircle2,
  "cloud-upload": CloudUpload,
  "eye-off": EyeOff,
  folder: Folder,
  home: Home,
  menu: Menu,
  money: Banknote,
  monitor: Monitor,
  moon: Moon,
  package: Package,
  sun: Sun,
  "arrow-end": ArrowRight,
  check: Check,
  "check-all": CheckCheck,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  circle: Circle,
  clock: Clock,
  cloud: Cloud,
  color: Palette,
  copy: Copy,
  download: Download,
  edit: Pencil,
  external: ExternalLink,
  eye: Eye,
  file: File,
  "file-doc": FileText,
  "file-image": ImageIcon,
  "file-pdf": FileText,
  "file-slides": Presentation,
  "file-sheet": FileSpreadsheet,
  grayscale: CircleSlash,
  info: Info,
  mail: Mail,
  minus: Minus,
  paperclip: Paperclip,
  plus: Plus,
  print: Printer,
  "rotate-cw": RotateCw,
  "rotate-ccw": RotateCcw,
  flip: FlipHorizontal,
  "flip-vertical": FlipVertical,
  help: HelpCircle,
  key: Key,
  link: Link2,
  "log-out": LogOut,
  "map-pin": MapPin,
  phone: Phone,
  redo: Redo2,
  sliders: SlidersHorizontal,
  tag: Tag,
  undo: Undo2,
  users: Users,
  database: Database,
  frown: Frown,
  "chevrons-left": ChevronsLeft,
  "chevrons-right": ChevronsRight,
  save: Save,
  qr: QrCode,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  spinner: Loader2,
  trash: Trash2,
  upload: Upload,
  user: User,
  x: X,
  zap: Zap,
} as const;

export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "ref"> {
  name: IconName;
  /** Accessible name. Required for an icon that carries meaning on its own
   *  (an icon-only button); omit it for decoration next to visible text, and
   *  the icon is hidden from assistive tech. */
  label?: string;
}

/** Single icon component. Never inline a raw <svg> in a view — it duplicates
 *  paths, drifts in stroke width, and is invisible to screen readers. */
export const Icon: React.FC<IconProps> = ({ name, label, className, ...props }) => {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className={cn("h-4 w-4 shrink-0", className)}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      {...props}
    />
  );
};

/** Spinner with the reduced-motion + a11y defaults already applied. */
export const Spinner: React.FC<{ className?: string; label?: string }> = ({ className, label }) => (
  <Icon name="spinner" className={cn("animate-spin", className)} label={label} />
);

/** Map a MIME type (or file name) to the icon that represents it. Shared so the
 *  Gmail intake list, the job list and the upload picker all agree. */
export function fileTypeIcon(mimeOrName: string | null | undefined): IconName {
  const v = (mimeOrName || "").toLowerCase();
  if (v.includes("pdf")) return "file-pdf";
  if (v.includes("image") || /\.(png|jpe?g|gif|webp|bmp|heic)$/.test(v)) return "file-image";
  if (v.includes("word") || v.includes("document") || /\.docx?$/.test(v)) return "file-doc";
  if (v.includes("excel") || v.includes("spreadsheet") || /\.(xlsx?|csv)$/.test(v)) return "file-sheet";
  if (v.includes("powerpoint") || v.includes("presentation") || /\.pptx?$/.test(v)) return "file-slides";
  return "paperclip";
}
