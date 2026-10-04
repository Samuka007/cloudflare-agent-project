//
// Ported verbatim from bb (Samuka007/bb fork of get-bb/bb) commit 8473d8c33.
// Cross-package imports rewritten to workspace-relative paths; no semantic edits.
//
import { z } from "zod";

export const PERSONAL_PROJECT_ID = "proj_personal";

export const projectKindValues = ["standard", "personal"] as const;
export const projectKindSchema = z.enum(projectKindValues);
export type ProjectKind = z.infer<typeof projectKindSchema>;

export const projectSchema = z.object({
  id: z.string(),
  kind: projectKindSchema,
  name: z.string(),
  gitRemoteUrl: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectSourceTypeValues = ["local_path"] as const;
export const projectSourceTypeSchema = z.enum(projectSourceTypeValues);
export type ProjectSourceType = z.infer<typeof projectSourceTypeSchema>;

const baseProjectSourceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  isDefault: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const localPathProjectSourceSchema = baseProjectSourceSchema.extend({
  type: z.literal("local_path"),
  hostId: z.string(),
  path: z.string(),
});
export type LocalPathProjectSource = z.infer<typeof localPathProjectSourceSchema>;

export const projectSourceSchema = localPathProjectSourceSchema;
export type ProjectSource = z.infer<typeof projectSourceSchema>;
