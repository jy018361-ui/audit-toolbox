import { z } from "zod";

export const ReleaseNotesSchema = z.object({
  currentVersion: z.string(),
  targetVersion: z.string(),
  releases: z.array(
    z.object({
      version: z.string(),
      title: z.string(),
      body: z.string(),
      publishedAt: z.string(),
    }),
  ),
  commits: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
