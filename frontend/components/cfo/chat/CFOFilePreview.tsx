// File-attachment chip rendered inside the composer for files the
// user has selected to attach to the next turn.
//
// The actual file-analysis backend hook-up is out of scope for this
// task (per the fence on existing AI/upload behaviour). For now the
// chip is UI-only: shows filename, type, size, status, and a remove
// affordance. Wiring it to the real upload + extraction pipeline is
// a follow-up that lives behind the existing /api/cfo/* contract.

import { motion } from "framer-motion";
import { X, FileText, FileSpreadsheet, FileImage, File as FileIcon, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import type { ChatAttachment } from "./types";

export function CFOFilePreview({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  const Icon = pickIcon(attachment.name);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.16 }}
      className="inline-flex items-center gap-2 rounded-lg border border-rule bg-bg-2/40 pl-2 pr-1 py-1 max-w-[260px]"
      data-testid="chat-file-preview"
    >
      <span className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-bg-2 text-ink-soft shrink-0">
        <Icon size={13} strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] text-ink truncate">{attachment.name}</span>
        <span className="block text-[10.5px] text-ink-mute mt-px">
          {statusCaption(attachment)} · {formatBytes(attachment.size)}
        </span>
      </span>
      <StatusGlyph status={attachment.status} />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="inline-flex items-center justify-center h-6 w-6 rounded text-ink-mute hover:text-ink hover:bg-bg-2 transition-colors shrink-0"
      >
        <X size={12} strokeWidth={1.75} />
      </button>
    </motion.div>
  );
}

function StatusGlyph({ status }: { status: ChatAttachment["status"] }) {
  if (status === "ready") return <CheckCircle2 size={12} className="text-[#2AA89B] shrink-0" />;
  if (status === "error") return <AlertCircle size={12} className="text-red-600 shrink-0" />;
  if (status === "queued") return null;
  return <Loader2 size={12} className="animate-spin text-ink-mute shrink-0" />;
}

function statusCaption(a: ChatAttachment): string {
  switch (a.status) {
    case "queued":     return "ready to send";
    case "uploading":  return "uploading…";
    case "reading":    return "reading financial data…";
    case "extracting": return "extracting key numbers…";
    case "ready":      return "ready";
    case "error":      return a.error || "couldn't read";
  }
}

function pickIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["xlsx", "xls", "csv"].includes(ext)) return FileSpreadsheet;
  if (["pdf", "doc", "docx", "txt"].includes(ext)) return FileText;
  if (["png", "jpg", "jpeg", "webp", "heic"].includes(ext)) return FileImage;
  return FileIcon;
}

function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
