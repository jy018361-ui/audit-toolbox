import { z } from "zod";

export const OcrPromptStageSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
});
export type OcrPromptStage = z.infer<typeof OcrPromptStageSchema>;
export const OcrCustomScenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseScenarioId: z.string().min(1),
  version: z.string().min(1),
  fields: z.array(z.object({ key: z.string(), label: z.string() })),
  stages: z.array(OcrPromptStageSchema).min(1),
});
export type OcrCustomScenario = z.infer<typeof OcrCustomScenarioSchema>;
export const OcrTableSchema = z.object({
  id: z.string(),
  title: z.string(),
  rows: z.array(z.array(z.string())),
});
export type OcrTable = z.infer<typeof OcrTableSchema>;
export const OcrProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompts: z.record(z.string(), z.array(OcrPromptStageSchema)).default({}),
  customScenarios: z.array(OcrCustomScenarioSchema).optional(),
  outputDirectory: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OcrProject = z.infer<typeof OcrProjectSchema>;
export const OcrDocumentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  totalPages: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  status: z.string(),
  sha256: z.string(),
});
export type OcrDocument = z.infer<typeof OcrDocumentSchema>;
export const OcrPageDataSchema = z.object({
  page: z.number().int().positive(),
  text: z.string(),
  originalText: z.string(),
  tables: z.array(OcrTableSchema),
  originalTables: z.array(OcrTableSchema),
  revision: z.number().int().nonnegative(),
  status: z.enum(["completed", "needs_review"]),
  warnings: z.array(z.string()),
  metadata: z
    .object({
      autoRotation: z
        .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
        .optional(),
      autoOrientationStatus: z
        .enum(["detected", "uncertain", "unavailable", "unknown"])
        .optional(),
    })
    .passthrough()
    .optional(),
});
export type OcrPageData = z.infer<typeof OcrPageDataSchema>;
const durationMs = z.number().finite().nonnegative();
export const OcrHttpTimingSchema = z.object({
  prepareMs: durationMs, headersMs: durationMs, bodyMs: durationMs, parseMs: durationMs,
  requestBytes: z.number().int().nonnegative(), responseBytes: z.number().int().nonnegative(),
  httpStatus: z.number().int().min(100).max(599), requestId: z.string().max(128).nullable(),
  model: z.string(), host: z.string(),
});
export const OcrWorkerTimingSchema = z.object({
  setupMs: durationMs,
  imageMs: durationMs,
  recognitionMs: durationMs,
  structureMs: durationMs,
  saveMs: durationMs,
  workerMs: durationMs,
  queueMs: durationMs.optional(),
    httpRequests: z.array(OcrHttpTimingSchema).optional(),
});
export type OcrWorkerTiming = z.infer<typeof OcrWorkerTimingSchema>;
export const OcrRecognitionResultSchema = OcrPageDataSchema.extend({
  timings: OcrWorkerTimingSchema.optional(),
});
export type OcrRecognitionResult = z.infer<typeof OcrRecognitionResultSchema>;
export const OcrColumnSchema = z.object({ key: z.string(), label: z.string() });
export const OcrExtractionSchema = z.object({
  id: z.string(),
  scenarioId: z.string(),
  scenarioVersion: z.string().optional(),
  prompts: z.array(OcrPromptStageSchema),
  sourceRevision: z.number().int().nonnegative(),
  rows: z.array(z.record(z.string(), z.unknown())),
  columns: z.array(OcrColumnSchema),
  createdAt: z.string(),
  stale: z.boolean().optional(),
});
export type OcrExtraction = z.infer<typeof OcrExtractionSchema>;
export const OcrDocumentDetailSchema = z.object({
  document: OcrDocumentSchema,
  pages: z.array(OcrPageDataSchema),
  extractions: z.array(OcrExtractionSchema),
});
export type OcrDocumentDetail = z.infer<typeof OcrDocumentDetailSchema>;
export const OcrConfigStatusSchema = z.object({
  ocr: z.object({ ready: z.boolean(), engine: z.string() }),
  llm: z.object({ ready: z.boolean(), visionReady: z.boolean() }),
});
export type OcrConfigStatus = z.infer<typeof OcrConfigStatusSchema>;

/** Every OCR boundary is checked before the UI can treat a result as complete. */
export const ocrResponseSchemas: Record<string, z.ZodType> = {
  "ocr.projects": z.object({ projects: z.array(OcrProjectSchema) }),
  "ocr.project_save": OcrProjectSchema,
  "ocr.project_delete": z.unknown(),
  "ocr.output_directory": z.object({ outputDir: z.string().min(1) }),
  "ocr.documents": z.object({ documents: z.array(OcrDocumentSchema) }),
  "ocr.document_import": z.object({
    documents: z.array(OcrDocumentSchema),
    failed: z.array(z.object({ name: z.string(), message: z.string() })),
  }),
  "ocr.document": OcrDocumentDetailSchema,
  "ocr.document_delete": z.unknown(),
  "ocr.document_bytes": z.object({
    mimeType: z.string(),
    dataBase64: z.string(),
  }),
  "ocr.image_pages": z.object({
    pages: z.array(
      z.object({ page: z.number().int().positive(), imageBase64: z.string() }),
    ),
  }),
  "ocr.document_prepare": OcrDocumentSchema,
  "ocr.page_save": OcrPageDataSchema,
  "ocr.extraction_save": OcrExtractionSchema,
  "ocr.config_status": OcrConfigStatusSchema,
  "ocr.recognize_page": OcrRecognitionResultSchema,
  "ocr.extract": z.object({
    parsed: z.unknown().optional(),
    raw: z.string().optional(),
    content: z.string().optional(),
    finish_reason: z.string().optional(),
  }),
  "ocr.export": z.object({ outputPaths: z.array(z.string()) }).passthrough(),
};
