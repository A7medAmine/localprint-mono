import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PrintJob } from "../types";
import { storageService } from "../services/storageService";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export const NEW_TARGET = "__new__";

export interface JobCustomer {
  key: string;
  name: string;
  phone: string;
  jobs: PrintJob[];
}

export interface JobSavePreferences {
  colorMode: "color" | "blackWhite";
  copies: number;
  paperType?: string;
}

export interface JobSaveOptions {
  file: File;
  preferences: JobSavePreferences;
  pageCount?: number;
  /** Jobs whose files were used as input (e.g. the images a card PDF was built from). */
  sourceJobIds?: string[];
  source?: string;
}

export interface JobSaveResult {
  jobId: string | null;
  replaced: boolean;
  removedIds: string[];
}

function customerKeyOf(name?: string | null, phone?: string | null) {
  return `${(name || "").trim().toLowerCase()}::${(phone || "").trim().toLowerCase()}`;
}

/**
 * Shared "where does this go?" state for every Print Studio tool that can save
 * its output as a job: pick an existing customer, optionally target one of that
 * customer's existing jobs (replacing its attachment in place), and optionally
 * delete the source files the output was generated from.
 */
export function useJobTargets() {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [customerKey, setCustomerKey] = useState<string>(NEW_TARGET);
  const [targetJobId, setTargetJobId] = useState<string>(NEW_TARGET);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [replaceSources, setReplaceSources] = useState(false);
  const [removeJobIds, setRemoveJobIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async (): Promise<PrintJob[]> => {
    try {
      const list = await storageService.getMetadata();
      setJobs(list);
      return list;
    } catch {
      // Non-fatal — the picker just falls back to "new customer" only.
      return [];
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const customers = useMemo<JobCustomer[]>(() => {
    const groups = new Map<string, PrintJob[]>();
    for (const job of jobs) {
      const customerName = (job.customerName || "").trim();
      if (!customerName) continue;
      const key = customerKeyOf(customerName, job.phoneNumber);
      const list = groups.get(key);
      if (list) list.push(job);
      else groups.set(key, [job]);
    }
    return Array.from(groups.entries())
      .map(([key, group]) => {
        const sorted = [...group].sort((a, b) => (b.uploadDate || "").localeCompare(a.uploadDate || ""));
        const latest = sorted[0];
        return { key, name: latest.customerName, phone: latest.phoneNumber || "", jobs: sorted };
      })
      .sort((a, b) => (b.jobs[0]?.uploadDate || "").localeCompare(a.jobs[0]?.uploadDate || ""));
  }, [jobs]);

  const selectedCustomer = customerKey === NEW_TARGET ? null : customers.find((c) => c.key === customerKey) || null;
  const targetJob =
    targetJobId === NEW_TARGET ? null : selectedCustomer?.jobs.find((j) => j.id === targetJobId) || null;

  const selectCustomer = useCallback(
    (key: string) => {
      setCustomerKey(key);
      setTargetJobId(NEW_TARGET);
      setRemoveJobIds(new Set());
      if (key === NEW_TARGET) return;
      const customer = customers.find((c) => c.key === key);
      if (customer) {
        setName(customer.name);
        setPhone(customer.phone);
      }
    },
    [customers],
  );

  const toggleRemoveJob = useCallback((id: string) => {
    setRemoveJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleRemoveAll = useCallback(() => {
    setRemoveJobIds((prev) => {
      if (!selectedCustomer) return prev;
      return prev.size === selectedCustomer.jobs.length
        ? new Set<string>()
        : new Set(selectedCustomer.jobs.map((j) => j.id));
    });
  }, [selectedCustomer]);

  /**
   * Prefill the dialog. Passing a job pre-selects that job's customer (and the
   * job itself when `selectJob` is set) so "save it back where it came from"
   * is one click. Resolution is deferred to an effect so a reset() fired right
   * after refresh() still matches, even though `customers` is a render behind.
   */
  const [prefill, setPrefill] = useState<{
    name?: string;
    phone?: string;
    notes?: string;
    job?: PrintJob | null;
    selectJob?: boolean;
  } | null>(null);

  const reset = useCallback(
    (next?: { name?: string; phone?: string; notes?: string; job?: PrintJob | null; selectJob?: boolean }) => {
      setRemoveJobIds(new Set());
      setReplaceSources(false);
      setNotes(next?.notes || "");
      setCustomerKey(NEW_TARGET);
      setTargetJobId(NEW_TARGET);
      setName(next?.job?.customerName || next?.name || "");
      setPhone(next?.job?.phoneNumber || next?.phone || "");
      setPrefill(next && (next.job || next.name || next.phone) ? next : null);
    },
    [],
  );

  useEffect(() => {
    const job = prefill?.job;
    if (!job?.customerName?.trim()) return;
    const key = customerKeyOf(job.customerName, job.phoneNumber);
    const customer = customers.find((c) => c.key === key);
    if (!customer) return;
    setCustomerKey(key);
    setTargetJobId(prefill?.selectJob && customer.jobs.some((j) => j.id === job.id) ? job.id : NEW_TARGET);
    setPrefill(null);
  }, [customers, prefill]);

  /**
   * Attach the generated file to the chosen target. Either replaces the
   * selected job's attachment in place, or creates a new job. Source jobs (and
   * any explicitly checked previous files) are deleted afterwards when asked
   * — never the target job itself.
   */
  const save = useCallback(
    async (opts: JobSaveOptions): Promise<JobSaveResult> => {
      const { file, preferences, pageCount, sourceJobIds = [], source } = opts;
      let jobId: string | null = null;
      let replaced = false;

      if (targetJob) {
        await storageService.updateJobFile(targetJob.id, file, file.name);
        await storageService.updateJobPreferences(targetJob.id, preferences);
        jobId = targetJob.id;
        replaced = true;
      } else {
        jobId = crypto.randomUUID();
        const job: PrintJob = {
          id: jobId,
          customerName: name.trim(),
          phoneNumber: phone.trim(),
          notes: notes.trim(),
          fileName: file.name,
          fileType: file.type || "application/pdf",
          fileSize: file.size,
          uploadDate: new Date().toISOString(),
          status: "PENDING" as any,
          pageCount,
          printPreferences: preferences,
          ...(source ? { source } : {}),
        } as PrintJob;
        await storageService.saveJob(job, file);
      }

      const toRemove = new Set<string>(removeJobIds);
      if (replaceSources) sourceJobIds.forEach((id) => id && toRemove.add(id));
      if (jobId) toRemove.delete(jobId);

      const removedIds: string[] = [];
      for (const id of toRemove) {
        try {
          await storageService.deleteJob(id);
          removedIds.push(id);
        } catch {
          // Best-effort — a failed cleanup must not fail the save itself.
        }
      }

      await refresh();
      return { jobId, replaced, removedIds };
    },
    [targetJob, name, phone, notes, removeJobIds, replaceSources, refresh],
  );

  return {
    jobs,
    customers,
    refresh,
    customerKey,
    selectCustomer,
    targetJobId,
    setTargetJobId,
    selectedCustomer,
    targetJob,
    name,
    setName,
    phone,
    setPhone,
    notes,
    setNotes,
    replaceSources,
    setReplaceSources,
    removeJobIds,
    toggleRemoveJob,
    toggleRemoveAll,
    reset,
    save,
  };
}

export type JobTargets = ReturnType<typeof useJobTargets>;

interface JobTargetPickerProps {
  targets: JobTargets;
  isRtl: boolean;
  /** How many of the loaded inputs came from existing jobs. */
  sourceJobCount?: number;
  /** Label for the source files ("images", "PDF", ...). */
  sourceLabel?: string;
  /** Hide the previous-files checklist (tools that only replace one target). */
  showPreviousFiles?: boolean;
}

/** Customer + existing-job target selector shared by the Print Studio tools. */
export const JobTargetPicker: React.FC<JobTargetPickerProps> = ({
  targets,
  isRtl,
  sourceJobCount = 0,
  sourceLabel,
  showPreviousFiles = true,
}) => {
  const {
    customers,
    customerKey,
    selectCustomer,
    targetJobId,
    setTargetJobId,
    selectedCustomer,
    targetJob,
    name,
    setName,
    phone,
    setPhone,
    replaceSources,
    setReplaceSources,
    removeJobIds,
    toggleRemoveJob,
    toggleRemoveAll,
  } = targets;

  const otherJobs = selectedCustomer?.jobs.filter((j) => j.id !== targetJobId) || [];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>{isRtl ? "العميل" : "Customer"}</Label>
        <Select value={customerKey} onValueChange={selectCustomer}>
          <SelectTrigger>
            <SelectValue placeholder={isRtl ? "اختر عميلاً أو أنشئ جديداً…" : "Choose a customer or create new…"} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_TARGET}>{isRtl ? "عميل جديد…" : "New customer…"}</SelectItem>
            {customers.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.name}{c.phone ? ` · ${c.phone}` : ""} ({c.jobs.length})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedCustomer && (
        <div className="space-y-1.5">
          <Label>{isRtl ? "المهمة" : "Job"}</Label>
          <Select value={targetJobId} onValueChange={setTargetJobId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_TARGET}>{isRtl ? "مهمة جديدة…" : "New job…"}</SelectItem>
              {selectedCustomer.jobs.map((job) => (
                <SelectItem key={job.id} value={job.id}>
                  {job.fileName} · {new Date(job.uploadDate).toLocaleDateString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {targetJob
              ? isRtl
                ? "سيتم استبدال ملف هذه المهمة بالملف المعالج."
                : "This job's attached file will be replaced by the processed file."
              : isRtl
                ? "سيتم إنشاء مهمة جديدة لهذا العميل."
                : "A new job will be created for this customer."}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>{isRtl ? "اسم العميل" : "Customer name"}</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!!targetJob} />
      </div>
      <div className="space-y-1.5">
        <Label>{isRtl ? "الهاتف" : "Phone"}</Label>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!!targetJob} />
      </div>

      {sourceJobCount > 0 && (
        <label className="flex items-start gap-2 rounded-lg border p-3 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={replaceSources}
            onChange={(e) => setReplaceSources(e.target.checked)}
            className="accent-indigo-600 mt-0.5 shrink-0"
          />
          <span>
            <span className="font-medium">
              {isRtl ? "استبدال الملفات الأصلية بالملف المعالج" : "Replace the source files with the processed file"}
            </span>
            <span className="block text-[11px] text-muted-foreground mt-0.5">
              {isRtl
                ? `سيتم حذف ${sourceJobCount} ${sourceLabel || "ملف"} تم استخدامها لإنشاء هذا الملف.`
                : `Deletes the ${sourceJobCount} ${sourceLabel || "file(s)"} this output was generated from.`}
            </span>
          </span>
        </label>
      )}

      {showPreviousFiles && selectedCustomer && otherJobs.length > 0 && (
        <div className="space-y-1.5 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-medium text-muted-foreground">
              {isRtl ? "الملفات السابقة لهذا العميل" : "Customer's previous files"}
            </Label>
            <button type="button" onClick={toggleRemoveAll} className="text-xs font-medium text-primary hover:underline">
              {removeJobIds.size === selectedCustomer.jobs.length
                ? isRtl ? "إلغاء التحديد" : "Deselect all"
                : isRtl ? "تحديد الكل" : "Select all"}
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {otherJobs.map((job) => (
              <label key={job.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={removeJobIds.has(job.id)}
                  onChange={() => toggleRemoveJob(job.id)}
                  className="accent-indigo-600 shrink-0"
                />
                <span className="flex-1 min-w-0 truncate">{job.fileName}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {new Date(job.uploadDate).toLocaleDateString()}
                </span>
              </label>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {isRtl
              ? "الملفات المحددة سيتم حذفها عند الحفظ."
              : "Checked files will be deleted on save."}
          </p>
        </div>
      )}
    </div>
  );
};

export default JobTargetPicker;
