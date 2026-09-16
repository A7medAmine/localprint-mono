import React from "react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import FilePreview from "./FilePreview";
import { formatFileSize } from "../../utils/filePreview";
import { Icon } from "../ui/icon";

interface PreviewModalProps {
  open: boolean;
  onClose: () => void;
  url: string | null;
  fileName: string;
  fileType?: string;
  fileSize?: number;
  loading?: boolean;
}

const PreviewModal: React.FC<PreviewModalProps> = ({
  open,
  onClose,
  url,
  fileName,
  fileType,
  fileSize,
  loading,
}) => {
  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-5xl w-[95vw] h-[85vh] flex flex-col p-0 gap-0 rounded-2xl">
        <div className="flex items-center justify-between px-5 pe-14 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 shrink-0">
              <Icon name="file-doc" className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-bold truncate">{fileName}</DialogTitle>
              {(fileType || fileSize) && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {fileType && <span>{fileType}</span>}
                  {fileType && fileSize && <span> &middot; </span>}
                  {fileSize && <span>{formatFileSize(fileSize)}</span>}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {url && (
              <a
                href={url}
                download
                className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-muted-foreground transition-colors"
                title="Download file"
              >
                <Icon name="download" className="w-5 h-5" />
              </a>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <FilePreview url={url} fileName={fileName} fileType={fileType} loading={loading} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PreviewModal;
