import React, { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { PDFDocument } from "pdf-lib";
import { ALLOWED_TYPES } from "../constants";
import { useLanguage } from "../lib/useLanguage";
import { toast } from "../components/ui/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { decodeImageToBitmap } from "../lib/imageNormalize";
import { layoutBatch } from "../lib/photoLayout";
import { buildPhotoPdf } from "../lib/photoPdf";
import { setPhotoBatchHandoff } from "../lib/photoBatchHandoff";
import type { PaperType } from "../types";
import { Icon } from "./ui/icon";
import { readPref } from "@atba3li/shared/lib/prefs";
import { errorMessage } from "@atba3li/shared";

const ACCEPT = ALLOWED_TYPES.join(",");

const isImageFile = (f: File) => f.type.startsWith("image/");
const isPdfFile = (f: File) => f.type === "application/pdf";

interface NewJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paperTypes: PaperType[];
  onCreated?: () => void;
}

type Mode = "single" | "separate" | "combine" | null;

const NewJobDialog: React.FC<NewJobDialogProps> = ({ open, onOpenChange, paperTypes, onCreated }) => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";
  const navigate = useNavigate();

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [colorMode, setColorMode] = useState<"color" | "blackWhite">("color");
  const [copies, setCopies] = useState(1);
  const [paperType, setPaperType] = useState(paperTypes[0]?.id || "normal");

  const [mode, setMode] = useState<Mode>(null);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fileKey = (f: File) => f.name + f.size + f.lastModified;

  // Object URLs for image thumbnails in the file list — revoked whenever the
  // file set changes, so a removed/replaced file never leaks its blob URL.
  useEffect(() => {
    const urls: Record<string, string> = {};
    files.forEach((f) => {
      if (isImageFile(f)) urls[fileKey(f)] = URL.createObjectURL(f);
    });
    setPreviews(urls);
    return () => {
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  const reset = () => {
    setCustomerName("");
    setPhone("");
    setNotes("");
    setFiles([]);
    setMode(null);
    setWorking(false);
    setProgress("");
    setColorMode("color");
    setCopies(1);
    if (paperTypes[0]) setPaperType(paperTypes[0].id);
  };

  const onFilesChosen = useCallback((next: File[]) => {
    const allowed = ALLOWED_TYPES;
    const rejected = next.filter((f) => !allowed.includes(f.type));
    if (rejected.length) {
      toast({
        title: isRtl ? "نوع الملف غير مدعوم" : "Unsupported file type",
        description: rejected.map((f) => f.name).join(", "),
        variant: "destructive",
      });
    }
    const kept = next.filter((f) => allowed.includes(f.type));
    setFiles(kept);
    if (kept.length === 1) setMode("single");
    else if (kept.length > 1) setMode(null);
    else setMode(null);
  }, [isRtl]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files || []);
    if (dropped.length) onFilesChosen([...files, ...dropped]);
  };

  const meta = () => ({
    customerName: customerName.trim(),
    phoneNumber: phone.trim(),
    notes: notes.trim(),
    printPreferences: { colorMode, copies, paperType },
    source: "admin",
  });

  const postJob = async (file: File, fileName: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("metadata", JSON.stringify({ ...meta(), fileName }));
    const token = readPref("adminToken");
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) {
      let msg = `Create failed (${res.status})`;
      try {
        const body = await res.json();
        if (body.error) msg = body.error;
      } catch { /* ignored */ }
      throw new Error(msg);
    }
  };

  const createSeparate = async () => {
    if (!customerName.trim() || files.length === 0) return;
    setWorking(true);
    let created = 0;
    const failed: string[] = [];
    for (let i = 0; i < files.length; i++) {
      setProgress(isRtl ? `جارٍ الإنشاء ${i + 1} من ${files.length}` : `Creating ${i + 1} of ${files.length}`);
      try {
        await postJob(files[i], files[i].name);
        created++;
      } catch {
        failed.push(files[i].name);
      }
    }
    setWorking(false);
    if (failed.length === 0) {
      toast({ title: `${created} ${t("jobsCreated")}`, variant: "success" });
      reset();
      onOpenChange(false);
      onCreated?.();
    } else {
      toast({
        title: `${created} ${t("jobsCreated")}`,
        description: `${t("jobCreateFailed")}: ${failed.slice(0, 3).join(", ")}`,
        variant: "destructive",
      });
    }
  };

  /** Build one combined PDF: merged PDFs, then full-page photo pages appended. */
  const buildCombinedPdf = async (): Promise<Blob> => {
    const doc = await PDFDocument.create();
    const pdfs = files.filter(isPdfFile);
    for (const f of pdfs) {
      const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const copied = await doc.copyPages(src, src.getPageIndices());
      copied.forEach((p) => doc.addPage(p));
    }
    const images = files.filter(isImageFile);
    if (images.length) {
      const imageMap = new Map<string, ImageBitmap | HTMLImageElement>();
      const items: { id: string; naturalWidth: number; naturalHeight: number }[] = [];
      for (const f of images) {
        const { bitmap, width, height } = await decodeImageToBitmap(f);
        const id = crypto.randomUUID();
        imageMap.set(id, bitmap);
        items.push({ id, naturalWidth: width, naturalHeight: height });
      }
      const pages = layoutBatch(items, {
        page: { widthPt: (210 * 72) / 25.4, heightPt: (297 * 72) / 25.4 },
        margins: { topMm: 5, rightMm: 5, bottomMm: 5, leftMm: 5 },
        fit: "cover",
        autoRotate: true,
        background: "#ffffff",
        copies: 1,
      });
      const photoBlob = await buildPhotoPdf(pages, imageMap, 1);
      const photoDoc = await PDFDocument.load(await photoBlob.arrayBuffer());
      const copied = await doc.copyPages(photoDoc, photoDoc.getPageIndices());
      copied.forEach((p) => doc.addPage(p));
    }
    const bytes = await doc.save();
    return new Blob([bytes], { type: "application/pdf" });
  };

  const createCombined = async () => {
    if (!customerName.trim() || files.length === 0) return;
    setWorking(true);
    try {
      const blob = await buildCombinedPdf();
      const file = new File([blob], "combined-job.pdf", { type: "application/pdf" });
      await postJob(file, file.name);
      toast({ title: t("jobsCreated"), variant: "success" });
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (e) {
      toast({ title: t("jobCreateFailed"), description: errorMessage(e), variant: "destructive" });
    } finally {
      setWorking(false);
    }
  };

  const openPhotoTool = () => {
    const images = files.filter(isImageFile);
    setPhotoBatchHandoff(images);
    reset();
    onOpenChange(false);
    navigate("/admin/dashboard?tab=studio-photos");
  };

  const canCreate = !!customerName.trim() && files.length > 0 && !working;
  const allMergeable = files.length > 0 && files.every((f) => isPdfFile(f) || isImageFile(f));
  const hasImages = files.some(isImageFile);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("newJobTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("customerNameRequired")}</Label>
            <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("phone")}</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("copies")}</Label>
              <Input type="number" min={1} max={100} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("studioNotes")}</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("colorMode")}</Label>
              <Select value={colorMode} onValueChange={(v) => setColorMode(v as "color" | "blackWhite")}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="color">{t("color")}</SelectItem>
                  <SelectItem value="blackWhite">{t("bw")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("paperType")}</Label>
              <Select value={paperType} onValueChange={setPaperType}>
                <SelectTrigger className="h-8 text-xs w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {paperTypes.map((pt) => (
                    <SelectItem key={pt.id} value={pt.id}>
                      {isRtl ? pt.nameAr : pt.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div
            role="button"
            tabIndex={0}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className="border-2 border-dashed border-input rounded-xl p-4 text-center cursor-pointer hover:border-primary/50 transition"
          >
            <Icon name="cloud-upload" className="w-6 h-6 text-muted-foreground mx-auto mb-1" />
            <span className="text-xs text-muted-foreground">{t("selectFiles")}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                const next = Array.from(e.target.files || []);
                if (next.length) onFilesChosen([...files, ...next]);
                e.target.value = "";
              }}
            />
          </div>

          {files.length > 0 && (
            <div className="space-y-1.5">
              {files.map((f) => (
                <div key={fileKey(f)} className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-1.5 text-sm">
                  {previews[fileKey(f)] ? (
                    <img src={previews[fileKey(f)]} alt="" className="w-8 h-8 rounded-md object-cover shrink-0" />
                  ) : (
                    <Icon name="file-doc" className="w-8 h-8 p-1.5 rounded-md bg-muted text-muted-foreground shrink-0" />
                  )}
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-muted-foreground">{(f.size / 1024 / 1024).toFixed(2)} MB</span>
                  <button
                    className="text-red-500 hover:text-red-700 text-lg leading-none"
                    onClick={() => onFilesChosen(files.filter((x) => x !== f))}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {files.length >= 2 && mode === null && (
            <div className="space-y-2 rounded-xl border border-input p-3">
              <p className="text-xs font-medium text-muted-foreground">{isRtl ? "اختر طريقة الإنشاء" : "How to create the job?"}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setMode("separate")}>
                  {t("separateJobs")}
                </Button>
                {allMergeable && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setMode("combine")}>
                    {t("combineOneJob")}
                  </Button>
                )}
                {hasImages && (
                  <Button type="button" variant="outline" size="sm" onClick={openPhotoTool}>
                    {t("photoLayoutOption")} &middot; {t("openInPhotoTool")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {working && <div className="text-xs text-muted-foreground text-center">{progress || t("creatingJobs")}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working}>{t("studioCancel")}</Button>
          {mode === "single" && (
            <Button disabled={!canCreate} onClick={createSeparate}>
              {working ? t("uploading") : t("addJob")}
            </Button>
          )}
          {mode === "separate" && (
            <Button disabled={!canCreate} onClick={createSeparate}>
              {working ? t("uploading") : t("addJob")}
            </Button>
          )}
          {mode === "combine" && (
            <Button disabled={!canCreate} onClick={createCombined}>
              {working ? t("uploading") : t("addJob")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default NewJobDialog;
