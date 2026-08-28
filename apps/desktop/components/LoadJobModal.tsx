import React, { useState, useEffect } from "react";
import { PrintJob } from "../types";
import { useLanguage } from "../lib/useLanguage";

interface LoadJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (job: PrintJob, file: File) => void;
  acceptType?: string;
  filterType?: "image" | "pdf" | "all";
}

const LoadJobModal: React.FC<LoadJobModalProps> = ({ isOpen, onClose, onSelect, acceptType, filterType = "all" }) => {
  const { t } = useLanguage();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const fetchJobs = async () => {
      setLoading(true);
      setError("");
      try {
        const token = localStorage.getItem("ps_admin_token");
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch("/api/jobs", { headers });
        const data = await res.json();
        let list = Array.isArray(data) ? data.filter((j: any) => j.serverFileName) : [];
        if (filterType === "image") {
          list = list.filter((j: any) => j.fileType?.startsWith("image/"));
        } else if (filterType === "pdf") {
          list = list.filter((j: any) => j.fileType === "application/pdf");
        }
        setJobs(list);
      } catch {
        setError("Failed to load jobs");
      } finally {
        setLoading(false);
      }
    };
    fetchJobs();
  }, [isOpen, filterType]);

  const handleSelect = async (job: any) => {
    if (!job.serverFileName) return;
    setDownloading(job.id);
    setError("");
    try {
      const res = await fetch(`/api/files/public/${job.id}`);
      if (!res.ok) throw new Error("File not found");
      const blob = await res.blob();
      const file = new File([blob], job.fileName, { type: job.fileType });
      onSelect(job as PrintJob, file);
      onClose();
    } catch {
      setError("Failed to download file");
    } finally {
      setDownloading(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-gray-200 dark:border-gray-700 w-full max-w-2xl max-h-[80vh] flex flex-col mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="font-semibold text-gray-800 dark:text-gray-100">{t("loadFromPrintJobs")}</h2>
          <button className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none" onClick={onClose}>&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">{t("loading")}</div>
          ) : error ? (
            <div className="text-center text-red-500 dark:text-red-400 py-8 text-sm">{error}</div>
          ) : jobs.length === 0 ? (
            <div className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">{t("noPrintJobsFound")}</div>
          ) : filterType === "image" ? (
            (() => {
              const groups: Record<string, PrintJob[]> = {};
              for (const job of jobs) {
                const key = job.customerName?.trim() || "Anonymous";
                if (!groups[key]) groups[key] = [];
                groups[key].push(job);
              }
              return Object.entries(groups).map(([customer, customerJobs]) => (
                <div key={customer}>
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1 py-2 sticky top-0 bg-white dark:bg-gray-800 z-10 border-b border-gray-100 dark:border-gray-700">
                    {customer} &middot; {customerJobs.length} {customerJobs.length === 1 ? t("file") : t("files")}
                  </div>
                  {customerJobs.map((job) => (
                    <button
                      key={job.id}
                      disabled={downloading === job.id}
                      className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition disabled:opacity-50 text-left"
                      onClick={() => handleSelect(job)}
                    >
                      <div className="w-9 h-9 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center shrink-0">
                        <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{job.fileName}</div>
                        <div className="text-xs text-gray-400 dark:text-gray-500">{new Date(job.uploadDate).toLocaleDateString()}</div>
                      </div>
                      <div className="text-xs text-gray-400 dark:text-gray-500">{job.pageCount ? `${job.pageCount} ${t("pages")}` : ""}</div>
                    </button>
                  ))}
                </div>
              ));
            })()
          ) : (
            jobs.map((job) => (
              <button
                key={job.id}
                disabled={downloading === job.id}
                className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition disabled:opacity-50 text-left"
                onClick={() => handleSelect(job)}
              >
                <div className="w-10 h-10 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{job.fileName}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {job.customerName || "Anonymous"} &middot; {new Date(job.uploadDate).toLocaleDateString()}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                    job.status === "PENDING" ? "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400" :
                    job.status === "READY" ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400" :
                    "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                  }`}>
                    {job.status}
                  </span>
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{job.pageCount ? `${job.pageCount} ${t("pages")}` : ""}</div>
                </div>
              </button>
            ))
          )}
        </div>
        {error && <div className="px-4 pb-4 text-sm text-red-500 dark:text-red-400">{error}</div>}
      </div>
    </div>
  );
};

export default LoadJobModal;
