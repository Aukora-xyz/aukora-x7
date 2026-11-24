// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The predecessor's Media copy (an earlier repository, the `media.*` keys of `en`), with a local translator in place
 * of a registered locale namespace, as the predecessor's x5 adapter did. Three lines are x6.1's own, because the predecessor's said
 * "will be available after …" and x6.1 names what is missing instead: `media.disconnected`, `media.credentialsUnavailable`
 * and `media.generationUnavailable`.
 *
 * @module apps/media/locales
 */

/** What this host is missing for Media to make anything. */
export const MEDIA_MISSING = 'no Higgsfield connector on this host'

export const en = {
  'media.name': 'Media and Documents',
  'media.eyebrow': 'Her drive, images and video',
  'media.settings': 'Settings',
  'media.closeSettings': 'Close Media settings',
  'media.close': 'Close Media',
  'media.connector': 'Higgsfield',
  'media.disconnected': 'NOT CONNECTED YET',
  'media.keyId': 'Higgsfield Key ID',
  'media.keySecret': 'Higgsfield Key Secret',
  'media.credentialsUnavailable': `NOT CONNECTED YET: ${MEDIA_MISSING}. There is nowhere safe to keep a key, so these fields stay closed.`,
  'media.saveConnect': 'Save & connect',
  'media.mode': 'Media type',
  'media.image': 'Image',
  'media.video': 'Video',
  'media.prompt': 'Prompt',
  'media.imagePlaceholder': 'Describe the subject, light, and composition…',
  'media.videoPlaceholder': 'Describe the scene, action, and camera movement…',
  'media.model': 'Model',
  'media.ratio': 'Aspect ratio',
  'media.resolution': 'Resolution',
  'media.duration': 'Duration',
  'media.audio': 'Generate audio',
  'media.generate': 'Generate',
  'media.generationUnavailable': `NOT CONNECTED YET: ${MEDIA_MISSING}`,
  'media.preview': 'Preview',
  'media.noPreview': 'No preview yet',
  'media.gallery': 'Gallery',
  'media.noGenerations': 'No generations yet',
  // Media and Documents, her drive: read only.
  'drive.views': 'Drive or studio',
  'drive.tab': 'Drive',
  'drive.studio': 'Studio',
  'drive.places': 'Places',
  'drive.captures': 'Captures',
  'drive.documents': 'Documents',
  'drive.images': 'Images',
  'drive.video': 'Video',
  'drive.private': 'Private',
  'drive.refresh': 'Refresh',
  'drive.open': 'Open',
  'drive.openFolder': 'Open folder',
  'drive.showPreview': 'Show preview',
  'drive.download': 'Download',
  'drive.downloading': 'Downloading…',
  'drive.copyPath': 'Copy path',
  'drive.copied': 'Copied',
  'drive.copyFailed': 'Could not copy. The path is shown above.',
  'drive.reading': 'Reading her files…',
  'drive.choose': 'Choose a file to see it here.',
  'drive.readOnly': 'Read only: the drive never changes her files.',
  'drive.ring': 'Her last 12 screenshots. Older ones are replaced.',
  'drive.emptyCaptures': 'No screenshots yet.',
  'drive.emptyDocuments': 'No documents yet. Files she writes in docs/ appear here.',
  'drive.emptyImages': 'No images yet.',
  'drive.emptyVideo': 'No videos yet.',
  'drive.emptyPrivate': 'Private is empty.',
  'drive.truncated': 'Not every file is listed here. The drive lists the first {n} files it finds, by folder and name.',
  'drive.imageFailed': 'This image could not be shown. Download it instead.',
  'drive.outside': 'This file is outside her home folder, so the drive does not open it.',
  'drive.notInDrive': 'This file is not in Captures, Documents or Private, so the drive does not open it.',
  'drive.notPlain': 'This path is not a plain file path, so the drive does not open it.',
  'drive.keptOut': 'This file is kept out of the drive.',
  'drive.inPrivate': 'This file is in Private.',
  'drive.privateSummary': 'Kept on this device. Opens when you tap it.',
  'drive.missing': 'There is no file at {path}.',
  'drive.noPreview': 'No preview: download it to open it.',
  'drive.notText': 'This file is not text. Download it to open it.',
  'drive.tooLargePreview': 'Too large to preview here ({size}). Download it instead.',
  'drive.tooLargeDownload': 'Too large to download here (over 64 MB).',
  'drive.changed': 'The file changed while it was being read. Try again.',
  'drive.busy': 'She did not answer in time; she may be busy. Press Refresh to try again.',
  'drive.unavailable': 'The drive cannot read her files in this build yet.',
  'drive.notRunning': 'Her worker is not running in this tab, so her files cannot be read right now.',
  'drive.noThread': 'The drive reads through a thread. Open any thread, then press Refresh.',
  'drive.noHomeThread': 'Private opens from a thread in her home folder. Open one, then try again.',
  'drive.missingTool': 'This build of her cannot list files yet.',
  'drive.refused': 'The drive could not read this. Press Refresh to try again.',
  'drive.preview': 'Preview',
  'drive.name': 'Name',
  'drive.kind': 'Kind',
  'drive.size': 'Size',
  'drive.changedAt': 'Changed',
  'drive.path': 'Path',
  'drive.folder': 'Folder',
  'drive.back': 'Back to the list',
  'drive.countUnknown': 'Not counted yet',
  'drive.opened': 'Showing {name} in the drive.',
} as const

/** One Media copy key. */
export type MediaKey = keyof typeof en

/**
 * The predecessor's `t()`, over the English table only.
 * @param key - a Media copy key.
 * @returns its English text.
 */
export const t = (key: MediaKey): string => en[key]

/**
 * A copy line with its `{name}` holes filled.
 * @param key - a Media copy key.
 * @param values - the words for its holes.
 * @returns the English text.
 */
export const fill = (key: MediaKey, values: Readonly<Record<string, string>>): string =>
  en[key].replace(/\{([a-z]+)\}/gu, (hole, name: string) => values[name] ?? hole)
