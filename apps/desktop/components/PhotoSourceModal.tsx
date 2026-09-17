import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { PrintJob } from "../types";
import { useLanguage } from "../lib/useLanguage";
import { readPref } from "@atba3li/shared/lib/prefs";

interface PhotoSourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (files: { job: PrintJob; file: File }[]) => void;
}

export interface PickedPhoto {
  job: PrintJob;
  file: File;
}

const PhotoSourceModal: React.FC<PhotoSourceModalProps> = ({ isOpen, onClose, onAdd }) => {
  const { t } = useLanguage();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    const fetchJobs = async () => {
      setLoading(true);
      setError("");
      try {
        const token = readPref("adminToken");
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/jobs", { headers });
        const data = await res.json();
        const list = Array.isArray(data)
          ? data.filter((j: PrintJob) => j.serverFileName && j.fileType?.startsWith("image/"))
          : [];
        setJobs(list);
        setSelected(new Set());
      } catch {
        setError("Failed to load jobs");
      } finally {
        setLoading(false);
      }
    };
    fetchJobs();
  }, [isOpen]);

  const groups: { customer: string; jobs: PrintJob[] }[] = (() => {
    const map: Record<string, PrintJob[]> = {};
    for (const job of jobs) {
      const key = job.customerName?.trim() || "Anonymous";
      if (!map[key]) map[key] = [];
      map[key].push(job);
    }
    return Object.entries(map).map(([customer, customerJobs]) => ({ customer, jobs: customerJobs }));
  })();

  const toggleJob = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (customerJobs: PrintJob[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = customerJobs.every((j) => next.has(j.id));
      if (allSelected) customerJobs.forEach((j) => next.delete(j.id));
      else customerJobs.forEach((j) => next.add(j.id));
      return next;
    });
  };

  const handleAdd = useCallback(async () => {
    const chosen = jobs.filter((j) => selected.has(j.id));
    if (chosen.length === 0) return;
    setDownloading(true);
    setError("");
    const picked: PickedPhoto[] = [];
    try {
      for (const job of chosen) {
        const res = await fetch(`/api/files/public/${job.id}`);
        if (!res.ok) throw new Error("File not found");
        const blob = await res.blob();
        picked.push({ job, file: new File([blob], job.fileName, { type: job.fileType }) });
      }
      onAdd(picked);
      onClose();
    } catch {
      setError("Failed to download file");
    } finally {
      setDownloading(false);
    }
  }, [jobs, selected, onAdd, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={t("close")}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative bg-card rounded-xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-border w-full max-w-2xl max-h-[80vh] flex flex-col mx-4"
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-semibold text-foreground">{t("loadFromPrintJobs")}</h2>
          <button className="text-muted-foreground hover:text-muted-foreground text-xl leading-none" onClick={onClose}>&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-center text-muted-foreground py-8 text-sm">{t("loading")}</div>
          ) : error && jobs.length === 0 ? (
            <div className="text-center text-red-500 dark:text-red-400 py-8 text-sm">{error}</div>
          ) : jobs.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm">{t("noPrintJobsFound")}</div>
          ) : (
            groups.map((group) => {
              const allSelected = group.jobs.every((j) => selected.has(j.id));
              return (
                <div key={group.customer}>
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 py-2 sticky top-0 bg-card z-10 border-b border-border flex items-center justify-between">
                    <span>
                      {group.customer} &middot; {group.jobs.length} {group.jobs.length === 1 ? t("file") : t("files")}
                    </span>
                    <label className="flex items-center gap-1.5 text-xs font-medium normal-case tracking-normal cursor-pointer select-none">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-indigo-600 dark:text-indigo-400 cursor-pointer"
                        checked={allSelected}
                        onChange={() => toggleGroup(group.jobs)}
                      />
                      {t("selectAll")}
                    </label>
                  </div>
                  {group.jobs.map((job) => {
                    const isSelected = selected.has(job.id);
                    return (
                      <label
                        key={job.id}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-lg transition cursor-pointer text-start ${
                          isSelected ? "bg-indigo-50 dark:bg-indigo-900/30" : "hover:bg-gray-50 dark:hover:bg-gray-700/40"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 dark:text-indigo-400 cursor-pointer shrink-0"
                          checked={isSelected}
                          onChange={() => toggleJob(job.id)}
                        />
                        <div className="w-9 h-9 bg-muted rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
                          <img
                            src={`/api/files/public/${job.id}`}
                            alt=""
                            loading="lazy"
                            className="w-full h-full object-cover"
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{job.fileName}</div>
                          <div className="text-xs text-muted-foreground">{new Date(job.uploadDate).toLocaleDateString()}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div className="p-4 border-t border-border flex items-center justify-between gap-3">
          {error && jobs.length > 0 && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted rounded-lg transition"
          >
            {t("cancel")}
          </button>
          <button
            onClick={handleAdd}
            disabled={selected.size === 0 || downloading}
            className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
          >
            {downloading ? t("loading") : `${t("addPhotos")} (${selected.size})`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default PhotoSourceModal;
