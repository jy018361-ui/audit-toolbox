import { createContext, useContext } from "react";

export type OcrScanPageState =
  | "preparing"
  | "running"
  | "queued"
  | "completed"
  | "failed"
  | "cancelled"
  | "memory_paused";
export type OcrScanProgress = {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  phase: "preparing" | "scanning" | "saving";
  pages: { page: number; state: OcrScanPageState }[];
  completed: number;
  total: number;
  paused: boolean;
  stopping: boolean;
  controlling: boolean;
  error?: string;
  onPause: () => void;
  onCancel: () => void;
};
export const OcrScanProgressContext = createContext({
  available: false,
  setProgress: (_value: OcrScanProgress | undefined) => {},
});
export const useOcrScanProgressDialog = () =>
  useContext(OcrScanProgressContext);

// Page workers remain part of a scan even when their terminal events arrive late.
const scanJobs = new Set<string>();
export const registerOcrScanJob = (jobId: string) => {
  scanJobs.add(jobId);
};
export const isOcrScanJob = (jobId: string) => scanJobs.has(jobId);
