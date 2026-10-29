import { createContext, useContext } from "react";

export type OcrScanPageState =
  | "preparing"
  | "running"
  | "ocr_request"
  | "ocr_save"
  | "queued"
  | "completed"
  | "failed"
  | "cancelled"
  | "memory_paused";
export type OcrScanPageProgress = {
  page: number;
  state: OcrScanPageState;
  startedAt?: number;
  message?: string;
  cancellable?: boolean;
  cancelling?: boolean;
};
export const isActiveOcrScanPage = (page: OcrScanPageProgress) =>
  !["completed", "failed", "cancelled"].includes(page.state);
export type OcrScanProgress = {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  phase: "preparing" | "scanning" | "saving";
  pages: OcrScanPageProgress[];
  completed: number;
  total: number;
  paused: boolean;
  stopping: boolean;
  controlling: boolean;
  error?: string;
  onPause: () => void;
  onCancel: () => void;
  onDeferPage?: (page: number) => void;
};
export type OcrTaskProgress = Omit<OcrScanProgress, "phase" | "pages" | "onDeferPage"> & {
  kind: "task";
  phase: "preparing" | "extracting" | "saving" | "exporting";
  message: string;
  activity?: { completed: number; total: number };
};
export type OcrProgress = OcrScanProgress | OcrTaskProgress;
export const OcrScanProgressContext = createContext({
  available: false,
  active: false,
  setProgress: (_value: OcrProgress | undefined) => {},
});
export const useOcrScanProgressDialog = () =>
  useContext(OcrScanProgressContext);

// Keep ownership across gaps and late events for the whole OCR operation.
const scanJobs = new Set<string>();
export const registerOcrOperationJob = (jobId: string) => {
  scanJobs.add(jobId);
};
export const registerOcrScanJob = registerOcrOperationJob;
export const isOcrScanJob = (jobId: string) => scanJobs.has(jobId);
