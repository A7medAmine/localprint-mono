import React from "react";
import { PrintJob, PrintStatus, PaymentStatus } from "../../../types";
import { formatPrice } from "../../../utils/pricingUtils";
import { Icon } from "../../../components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useAdmin } from "../AdminContext";

/** Where a job came from. Renders nothing for the ordinary customer upload —
 *  that is the default and does not need a label. */
export const SourceBadge: React.FC<{ job: PrintJob }> = ({ job }) => {
  const { t } = useAdmin();
  const base =
    "text-xs font-semibold px-1.5 py-0.5 rounded inline-flex items-center gap-0.5 whitespace-nowrap shrink-0";
  if (job.source === "gmail") {
    return (
      <span className={`${base} text-green-700 dark:text-green-100 bg-green-100 dark:bg-green-900`}>
        Gmail
      </span>
    );
  }
  if (job.source === "admin") {
    return (
      <span className={`${base} text-purple-700 dark:text-purple-100 bg-purple-100 dark:bg-purple-900`}>
        {t("adminBadge")}
      </span>
    );
  }
  return null;
};

/** Print status. The icon carries the same meaning as the colour, so the state
 *  is still readable without colour vision. When `onStatusChange` is given the
 *  badge doubles as the status dropdown trigger, so status lives only in the
 *  STATUS column instead of also sitting in Actions. */
export const StatusBadge: React.FC<{
  job: PrintJob;
  onStatusChange?: (jobId: string, status: PrintStatus) => void;
}> = ({ job, onStatusChange }) => {
  const { t, isRtl } = useAdmin();
  const printed = job.status === PrintStatus.PRINTED;
  const ready = job.status === PrintStatus.READY;
  const canceled = job.status === PrintStatus.CANCELED;
  const badge = (
    <span
      className={`px-3 py-1 text-xs font-bold rounded-full uppercase tracking-wide inline-flex items-center gap-1 ${
        printed
          ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100 border border-green-200 dark:border-green-800"
          : ready
          ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-100 border border-blue-200 dark:border-blue-800"
          : canceled
          ? "bg-red-100 dark:bg-[#501313] text-red-700 dark:text-[#F7C1C1] border border-red-200 dark:border-red-800"
          : "bg-amber-100 dark:bg-[#412402] text-amber-700 dark:text-[#FAC775] border border-amber-200 dark:border-amber-800"
      }`}
    >
      <Icon name={printed ? "check-circle" : ready ? "check" : canceled ? "x" : "clock"} className="w-3 h-3" />
      {printed ? t("printed") : ready ? t("ready") : canceled ? (isRtl ? "ملغي" : "Canceled") : t("pending")}
    </span>
  );

  if (!onStatusChange) return badge;

  return (
    <Select value={job.status} onValueChange={(val) => onStatusChange(job.id, val as PrintStatus)}>
      <SelectTrigger
        className="w-max h-auto border-0 p-0 bg-transparent gap-1 justify-start hover:opacity-80 focus:ring-0 focus:ring-offset-0 [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-60"
        title={isRtl ? "تغيير الحالة" : "Change status"}
      >
        <SelectValue>{badge}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PrintStatus.PENDING}>
          <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-yellow-500 dark:bg-yellow-400 inline-block"></span>{isRtl ? "قيد الانتظار" : "Pending"}</span>
        </SelectItem>
        <SelectItem value={PrintStatus.READY}>
          <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block"></span>{isRtl ? "جاهز" : "Ready"}</span>
        </SelectItem>
        <SelectItem value={PrintStatus.PRINTED}>
          <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>{isRtl ? "تمت الطباعة" : "Printed"}</span>
        </SelectItem>
        <SelectItem value={PrintStatus.CANCELED}>
          <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500 inline-block"></span>{isRtl ? "ملغي" : "Canceled"}</span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
};

/** Payment state. This one opens the payment editor, so it is a real <button>:
 *  a clickable <span> is unreachable by keyboard and invisible to assistive
 *  tech. */
export const PaymentBadge: React.FC<{ job: PrintJob; onEdit: (job: PrintJob) => void }> = ({
  job,
  onEdit,
}) => {
  const { t, isRtl } = useAdmin();
  const paid = job.paymentStatus === PaymentStatus.PAID;
  const partial = job.paymentStatus === PaymentStatus.PARTIAL;
  const label = paid ? t("paid") : partial ? t("partial") : t("unpaid");
  return (
    <button
      type="button"
      className={`px-2 py-1 text-xs font-bold rounded-full inline-flex items-center gap-1 hover:opacity-80 ${
        paid
          ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-100 border border-green-200 dark:border-green-800"
          : partial
          ? "bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-100 border border-amber-200 dark:border-amber-800"
          : "bg-red-100 dark:bg-[#501313] text-red-700 dark:text-[#F7C1C1] border border-red-200 dark:border-red-800"
      }`}
      onClick={() => onEdit(job)}
      title={isRtl ? "انقر لتعديل الدفع" : "Click to edit payment"}
      aria-label={`${label} — ${isRtl ? "تعديل الدفع" : "Edit payment"}`}
    >
      <Icon name={paid ? "check" : partial ? "circle" : "x"} className="w-3 h-3" />
      <span>{label}</span>
      {job.paymentAmount ? (
        <span className="text-xs opacity-70 font-mono">{formatPrice(job.paymentAmount)}</span>
      ) : null}
    </button>
  );
};
