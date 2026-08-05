import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExtension, STORAGE_CATEGORIES } from '../src/storage/classify.js'

/**
 * Pure unit tests -- no database, no server. Run on their own with:
 *   npx tsx --test tests/classify.test.ts
 */

describe('storage: extension classification', () => {
  it('files each media kind under its own folder', () => {
    const cases: Array<[string, string]> = [
      ['.png', 'images'],
      ['.webp', 'images'],
      ['.heic', 'images'],
      ['.mp4', 'video'],
      ['.mov', 'video'],
      ['.mp3', 'audio'],
      ['.pdf', 'documents'],
      ['.docx', 'documents'],
      ['.pptx', 'documents'],
      ['.csv', 'documents'],
      ['.zip', 'archives'],
    ]
    for (const [extension, expected] of cases) {
      assert.equal(classifyExtension(extension), expected, `${extension} -> ${expected}`)
    }
  })

  it('accepts an extension with or without the dot, in any case', () => {
    assert.equal(classifyExtension('.PDF'), 'documents')
    assert.equal(classifyExtension('pdf'), 'documents')
    assert.equal(classifyExtension('JPEG'), 'images')
    assert.equal(classifyExtension(' .Mp4 '), 'video')
  })

  it('falls back to `other` rather than throwing', () => {
    // A file with no extension is legal, and an unknown one must not cost
    // somebody their upload.
    assert.equal(classifyExtension(''), 'other')
    assert.equal(classifyExtension(undefined), 'other')
    assert.equal(classifyExtension(null), 'other')
    assert.equal(classifyExtension('.'), 'other')
    assert.equal(classifyExtension('.wat'), 'other')
  })

  it('classifies what was STORED, not what was uploaded', () => {
    // compressUpload() rewrites a phone HEIC to WebP. Both must land in
    // `images`, or the folder would disagree with the content type the
    // download route derives from the same extension.
    assert.equal(classifyExtension('.heic'), classifyExtension('.webp'))
    assert.equal(classifyExtension('.webp'), 'images')
  })

  it('never returns a category outside the declared set', () => {
    const samples = ['.png', '.mp4', '.pdf', '.zip', '.wat', '', '.mp3']
    for (const s of samples) {
      assert.ok(
        STORAGE_CATEGORIES.includes(classifyExtension(s)),
        `${s} produced an undeclared category`
      )
    }
  })

  it('produces folder names that are safe as key segments', () => {
    // assertSafeKey rejects empty segments, "." and ".." -- a category is a key
    // segment, so it has to satisfy the same rule.
    for (const category of STORAGE_CATEGORIES) {
      assert.match(category, /^[a-z]+$/, `${category} is not a plain lowercase segment`)
    }
  })
})
