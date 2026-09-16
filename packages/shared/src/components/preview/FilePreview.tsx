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
}

const FilePreview: React.FC<FilePreviewProps> = ({ url, fileName, fileType, loading }) => {
  if (loading || !url) return <PreviewSkeleton />;

  const type: FileType = detectFileType(fileName, fileType);

  switch (type) {
    case "image":
      return <ImageRenderer src={url} fileName={fileName} />;
    case "pdf":
      return <PdfRenderer src={url} />;
    case "docx":
      return <DocxRenderer src={url} fileName={fileName} />;
    case "xlsx":
      return <SpreadsheetRenderer src={url} fileName={fileName} />;
    default:
      return (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-gray-400 gap-4">
          <Icon name="file-doc" className="w-16 h-16" />
          <div className="text-center">
            <p className="text-sm font-medium">Preview not available</p>
            <p className="text-xs text-gray-400 mt-1">
              {fileType || fileName.split(".").pop()?.toUpperCase() || "Unknown"} files cannot be
              previewed
            </p>
          </div>
          <a
            href={url}
            download
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Icon name="download" className="w-4 h-4" />
            Download File
          </a>
        </div>
      );
  }
};

export default FilePreview;
