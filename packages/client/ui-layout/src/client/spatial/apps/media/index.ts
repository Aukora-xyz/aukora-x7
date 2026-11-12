// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * Media and Documents for the centre Stage: her drive (read only: her screenshots, documents, images and videos), and
 * the predecessor's studio (working draft controls, no Higgsfield connector, nothing generated).
 */
export { MEDIA_SURFACE, MediaSurface } from './MediaSurface.tsx'
export { MEDIA_MISSING } from './locales.ts'
export { createDriveFilesDoor } from './drive-source.ts'
export type { DriveFiles, DriveFilesDoor, MediaSurfaceInjected } from './drive-source.ts'
export { driveTarget, parseDriveTarget } from './drive-rule.ts'
