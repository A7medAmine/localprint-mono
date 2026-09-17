import React from "react";
import { detectFileType, FileType } from "../../utils/filePreview";
import ImageRenderer from "./renderers/ImageRenderer";
import PdfRenderer from "./renderers/PdfRenderer";
import DocxRenderer from "./renderers/DocxRenderer";
import SpreadsheetRenderer from "./renderers/SpreadsheetRenderer";
import PreviewSkeleton from "./PreviewSkeleton";
import { Icon } from "../ui/icon";

interface FilePreviewProps {
  url: string | null;
  fileName: string;
  fileType?: string;
  loading?: boolean;
  /** Preview in black & white — mirrors the OS print dialog's colour toggle. */
  grayscale?: boolean;
  /** PDF only: restrict page navigation to what a "Page range" print option would actually print. */
  pageRanges?: { from: number; to: number }[];
  isRtl?: boolean;
}

const FilePreview: React.FC<FilePreviewProps> = ({ url, fileName, fileType, loading, grayscale, pageRanges, isRtl }) => {
  if (loading || !url) return <PreviewSkeleton />;

  const type: FileType = detectFileType(fileName, fileType);

  let content: React.ReactNode;
  switch (type) {
    case "image":
      content = <ImageRenderer src={url} fileName={fileName} isRtl={isRtl} />;
      break;
    case "pdf":
      content = <PdfRenderer src={url} pageRanges={pageRanges} isRtl={isRtl} />;
      break;
    case "docx":
      content = <DocxRenderer src={url} fileName={fileName} />;
      break;
    case "xlsx":
      content = <SpreadsheetRenderer src={url} fileName={fileName} />;
      break;
    default:
      content = (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-gray-400 gap-4">
          <Icon name="file-doc" className="w-16 h-16" />
          <div className="text-center">
            <p className="text-sm font-medium">{isRtl ? "لا معاينة متاحة" : "Preview not available"}</p>
            <p className="text-xs text-gray-400 mt-1">
              {isRtl
                ? `ملفات ${fileType || fileName.split(".").pop()?.toUpperCase() || "غير معروفة"} لا يمكن معاينتها`
                : `${fileType || fileName.split(".").pop()?.toUpperCase() || "Unknown"} files cannot be previewed`}
            </p>
          </div>
          <a
            href={url}
            download
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Icon name="download" className="w-4 h-4" />
            {isRtl ? "تحميل الملف" : "Download File"}
          </a>
        </div>
      );
  }

  if (!grayscale) return <>{content}</>;
  // CSS grayscale on the rendered output — the same trick Chrome's own print
  // preview uses for its "Black and white" toggle, so it stays instant and
  // doesn't need a second render pass through the canvas.
  return <div className="h-full" style={{ filter: "grayscale(1)" }}>{content}</div>;
};

export default FilePreview;
