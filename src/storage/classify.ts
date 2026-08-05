/**
 * Which top-level folder an upload is filed under.
 *
 * Keys are laid out `<bucket>/<category>/<userId>/<taskId>/<stepId>/<file>`, so
 * the category sits directly under the logical bucket and "every video" is a
 * single prefix scan in Garage rather than a walk across every user's folder.
 * That is what makes an audit of what is filling the store -- or a lifecycle
 * rule that expires video sooner than documents -- cheap to run.
 *
 * IMPORTANT: classify the extension the bytes are STORED under, not the one
 * they arrived with. compressUpload() re-encodes a phone HEIC to WebP, so
 * classifying the original would file an image under `other` AND disagree with
 * the extension the download route reads to choose a content type.
 */

export type StorageCategory =
  | 'images'
  | 'video'
  | 'audio'
  | 'documents'
  | 'archives'
  | 'other'

/**
 * Extension -> category. Anything unlisted falls to `other` rather than being
 * rejected: a file in a slightly odd folder is a filing problem, whereas
 * refusing the upload would cost somebody their submission.
 */
const CATEGORIES: Record<StorageCategory, readonly string[]> = {
  // webp leads because it is what compressUpload() produces for most images.
  images: ['webp', 'jpg', 'jpeg', 'png', 'gif', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'mpg', 'mpeg', 'wmv'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'aac', 'flac'],
  documents: [
    'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp',
    'txt', 'csv', 'md', 'rtf', 'json', 'xml',
  ],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  other: [],
}

/** Built once: a flat lookup beats scanning six arrays per upload. */
const BY_EXTENSION: ReadonlyMap<string, StorageCategory> = new Map(
  (Object.entries(CATEGORIES) as Array<[StorageCategory, readonly string[]]>).flatMap(
    ([category, extensions]) => extensions.map((e) => [e, category] as const)
  )
)

/**
 * `extension` may be given with or without a leading dot, in any case, and may
 * be empty -- a file uploaded with no extension at all is legal.
 */
export function classifyExtension(extension: string | undefined | null): StorageCategory {
  if (!extension) return 'other'
  // Trim FIRST: stripping the dot before trimming leaves " .mp4" with its dot
  // intact, which then matches nothing and files a video under `other`.
  const normalised = extension.trim().replace(/^\./, '').toLowerCase()
  if (!normalised) return 'other'
  return BY_EXTENSION.get(normalised) ?? 'other'
}

/** Every folder name that can appear, for the doctor and migration scripts. */
export const STORAGE_CATEGORIES = Object.keys(CATEGORIES) as readonly StorageCategory[]
