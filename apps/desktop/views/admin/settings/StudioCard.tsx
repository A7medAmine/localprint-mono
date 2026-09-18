import React, { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Icon } from "../../../components/ui/icon";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { toast } from "../../../components/ui/use-toast";
import { useAdmin } from "../AdminContext";
import {
  isStudioPersistEnabled,
  setStudioPersistEnabled,
  clearAllStudioSnapshots,
} from "../../../lib/studioPersist";

/** Print Studio work-in-progress persistence (on by default). This is a per-machine
 *  preference (localStorage + IndexedDB on this device), not a shop setting,
 *  so it applies immediately and has no save bar. */
export const StudioCard: React.FC = () => {
  const { isRtl } = useAdmin();
  const [enabled, setEnabled] = useState(() => isStudioPersistEnabled());
  const [clearing, setClearing] = useState(false);

  const toggle = (next: boolean) => {
    setStudioPersistEnabled(next);
    setEnabled(next);
    toast({
      title: next
        ? isRtl ? "سيتم حفظ عمل الاستوديو" : "Studio work will be kept"
        : isRtl ? "لن يتم حفظ عمل الاستوديو" : "Studio work will not be kept",
      variant: "success",
    });
  };

  const clearNow = async () => {
    setClearing(true);
    try {
      await clearAllStudioSnapshots();
      toast({ title: isRtl ? "تم مسح العمل المحفوظ" : "Saved studio work cleared", variant: "success" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card className="border-0">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
            <Icon name="file-image" className="w-5 h-5" />
          </div>
          <div>
            <CardTitle className="text-base">{isRtl ? "استوديو الطباعة" : "Print Studio"}</CardTitle>
            <CardDescription>
              {isRtl
                ? "الصور والبطاقات وملفات PDF تبقى عند التنقل بين الأدوات"
                : "Images, cards and PDFs are kept when switching between tools"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">
              {isRtl ? "الاحتفاظ بالعمل بعد إعادة التشغيل" : "Keep work after a restart"}
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {isRtl
                ? "يحفظ الملفات المفتوحة وإعداداتها على هذا الجهاز، فتعود كما هي عند فتح التطبيق مجددًا. تُحذف تلقائيًا بعد 7 أيام."
                : "Saves the open files and their options on this device, so they come back when the app is reopened. Dropped automatically after 7 days."}
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={toggle} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            {isRtl ? "امسح ما هو محفوظ الآن على هذا الجهاز." : "Delete what is currently saved on this device."}
          </p>
          <Button variant="outline" size="sm" onClick={clearNow} disabled={clearing} className="gap-2 shrink-0">
            <Icon name="trash" className="w-4 h-4" />
            {isRtl ? "مسح العمل المحفوظ" : "Clear saved work"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
