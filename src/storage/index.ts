import { config } from '../config.js'
import { DiskDriver } from './disk.js'
import type { StorageDriver } from './driver.js'
import { S3Driver } from './s3.js'

/**
 * The one storage driver the process uses, chosen from the environment.
 *
 * Built lazily so importing this module -- which the scripts and tests do --
 * does not open an S3 connection before anyone has asked for one.
 */
let driver: StorageDriver | undefined

export function storage(): StorageDriver {
  if (!driver) driver = config.storageDriver === 's3' ? new S3Driver() : new DiskDriver()
  return driver
}

/** Test seam. Passing nothing restores selection from the environment. */
export function setStorageDriver(next?: StorageDriver): void {
  driver = next
}

export type { StorageDriver } from './driver.js'
