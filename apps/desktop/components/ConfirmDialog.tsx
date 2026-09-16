import React from "react";
import { Icon } from "./ui/icon";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDanger?: boolean;
  isRtl?: boolean;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  isDanger = false,
  isRtl: _isRtl = false,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity cursor-default"
        aria-label={cancelText}
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 transform transition-all scale-100"
      >
        {/* Icon */}
        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${
            isDanger ? "bg-red-100 text-red-600" : "bg-indigo-100 text-indigo-600"
          }`}
        >
          {isDanger ? (
            <Icon name="alert" className="w-6 h-6" />
          ) : (
            <Icon name="help" className="w-6 h-6" />
          )}
        </div>

        {/* Title */}
        <h3 className="text-lg font-bold text-center text-gray-900 mb-2">{title}</h3>

        {/* Message */}
        <p className="text-sm text-gray-600 text-center mb-6">{message}</p>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 text-gray-700 font-medium bg-gray-100 hover:bg-gray-200 rounded-xl transition"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 px-4 py-2.5 text-white font-medium rounded-xl transition ${
              isDanger
                ? "bg-red-600 hover:bg-red-700"
                : "bg-indigo-600 hover:bg-indigo-700"
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
