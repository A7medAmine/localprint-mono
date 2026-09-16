import React, { useState } from "react";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Icon } from "../../../components/ui/icon";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../../components/ui/dialog";
import { useAdmin } from "../AdminContext";

/** Download a database snapshot, or restore one. Restoring reloads the app,
 *  so nothing here needs to be lifted into the panel. */
export const BackupCard: React.FC = () => {
  const { t, isRtl } = useAdmin();
  const [backupRestoreOpen, setBackupRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  const handleBackupDownload = () => {
    storageService.downloadBackup();
  };

  const handleBackupRestore = async () => {
    if (!restoreFile) return;
    setRestoring(true);
    try {
      await storageService.restoreBackup(restoreFile);
      toast({ title: isRtl ? "تمت الاستعادة. إعادة تحميل..." : "Restored. Reloading...", variant: "success" });
      setBackupRestoreOpen(false);
      setRestoreFile(null);
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: isRtl ? "فشل الاستعادة" : "Restore failed", description: message, variant: "destructive" });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      {/* Backup & Restore Card */}
      <Card className="lg:col-span-2 border-0">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted text-muted-foreground dark:text-gray-500 flex items-center justify-center flex-shrink-0">
              <Icon name="database" className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base">{t("backup")}</CardTitle>
              <CardDescription>{isRtl ? "تنزيل أو استعادة نسخة احتياطية من قاعدة البيانات" : "Download or restore database backup"}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <Button variant="outline" onClick={handleBackupDownload} className="gap-2">
              <Icon name="download" className="w-4 h-4" />
              {t("downloadBackup")}
            </Button>
            <Button variant="outline" onClick={() => setBackupRestoreOpen(true)} className="gap-2">
              <Icon name="refresh" className="w-4 h-4" />
              {t("restoreBackup")}
            </Button>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-3 flex items-center gap-1">
            <Icon name="alert" className="w-3.5 h-3.5 flex-shrink-0" />
            {t("restoreWarning")}
          </p>
        </CardContent>
      </Card>

      {/* Backup Restore Dialog */}
      <Dialog open={backupRestoreOpen} onOpenChange={(open) => { if (!open) { setBackupRestoreOpen(false); setRestoreFile(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("restoreBackup")}</DialogTitle>
            <DialogDescription>{t("restoreWarning")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input type="file" accept=".sqlite,.db" onChange={(e) => setRestoreFile(e.target.files?.[0] || null)} />
            {restoreFile && (
              <p className="text-xs text-muted-foreground">{restoreFile.name}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setBackupRestoreOpen(false); setRestoreFile(null); }}>
              {t("cancel")}
            </Button>
            <Button disabled={!restoreFile || restoring} onClick={handleBackupRestore} variant="destructive">
              {restoring ? (isRtl ? "جارٍ الاستعادة..." : "Restoring...") : (isRtl ? "استعادة" : "Restore")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
