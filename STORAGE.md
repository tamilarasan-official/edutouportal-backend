# File storage

Everything a student or mentor uploads — task submissions (images, screenshots,
PDFs) and shared resources — goes through this API. This document covers how it
works, how to put it on Garage in Dokploy, and how to repair the files that are
currently unviewable.

## How a file gets from a student to a mentor

```
student picks a file
  → POST /api/storage/task-submissions        (multipart, session cookie)
      server chooses the key:  <userId>/<taskId>/<stepId>/<millis>-<uuid>.<ext>
      server writes the bytes: disk volume or S3, per STORAGE_DRIVER
      server returns:          { path, publicUrl, signedUrl }
  → portal stores publicUrl on the row          ← MUST be the returned value
mentor opens the submission
  → GET /api/storage/sign?bucket=…&path=…     (session cookie, via the portal proxy)
      access checked, existence checked, HMAC-signed URL returned (15 min)
  → browser fetches that URL directly          ← no cookie, no auth header
      token verified, access re-checked, bytes streamed
```

Two properties are worth keeping in mind, because most of the failures in this
area come from ignoring one of them:

**The server chooses the key.** A client cannot decide where its file lands —
that is what stopped one user writing into another's folder. Callers must store
the `publicUrl` from the upload response. Building a URL from a client-side
filename produces a row pointing at a key that was never written; the portal
lists it happily and only the preview fails, with `File not found`.

**A browser cannot authenticate a direct fetch.** Sign-in is a Server Action, so
the session cookie belongs to the portal's hostname, not the API's. An
`<iframe src>`, `<img src>` or download anchor sends no cookie and cannot carry
an `Authorization` header. That is why the signed URL exists: minted over the
authenticated channel, then handed to the browser. Never point an element at a
raw storage URL.

## Choosing where bytes live

| | `STORAGE_DRIVER=disk` | `STORAGE_DRIVER=s3` |
|---|---|---|
| Where | `STORAGE_DIR` inside the container | Garage / MinIO / R2 / AWS |
| Survives a redeploy | only if the path is a **mounted volume** | always |
| Setup | a volume mount | endpoint, bucket, key pair |
| Use for | local development | **production** |

Leave `STORAGE_DRIVER` unset and it is inferred: `s3` when `S3_ENDPOINT` is
present, `disk` otherwise.

The disk driver on an *unmounted* directory is the trap: uploads work, previews
work, and then a deploy replaces the container and every file uploaded before it
is gone while the database still lists them. `npm run storage:doctor` reports
exactly this.

## Putting it on Garage (Dokploy)

Garage is already running in your Dokploy project. It needs a bucket and an
application key; the API needs four environment variables.

**1. Create the bucket and key.** In the Garage container's terminal:

```sh
garage bucket create edutou
garage key create edutou-api
# note the Key ID and Secret key it prints -- the secret is shown once
garage bucket allow --read --write edutou --key edutou-api
```

The key needs read and write on the bucket only. It does not need `--owner`,
and it must not be an admin key: this application never creates or deletes
buckets.

**2. Point the API at it.** In the backend application's Environment settings:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=http://garage:3900       # Garage's INTERNAL address in Dokploy
S3_BUCKET=edutou
S3_ACCESS_KEY_ID=GK...               # from `garage key create`
S3_SECRET_ACCESS_KEY=...
S3_REGION=garage                     # whatever garage.toml calls it
S3_FORCE_PATH_STYLE=true
```

Use the internal service address. Garage never needs to face the internet —
downloads are streamed through this API so the access checks and signed URLs
still apply, and the bucket stays private.

**3. Bring the existing files across** (skip if the volume is already empty).
Run this *before* detaching the old volume, from the backend container:

```sh
node dist/scripts/storage-migrate.js
```

It copies every object from `STORAGE_DIR` into the bucket under identical keys,
so existing rows keep working untouched. Nothing is deleted from the volume, and
re-running it skips what is already there.

**4. Verify.**

```sh
node dist/scripts/storage-doctor.js
```

It cross-checks every `file_url` in the database against storage and prints what
is missing. Expect `MISSING from storage: 0`.

Keep the old volume around for a while as a backup before removing it.

## Repairing rows that already point at the wrong key

If `storage-doctor` reports missing files, some may not be lost at all — the
resources uploader used to record a client-invented filename instead of the key
the API returned, so the bytes are in storage under a different name.

```sh
node dist/scripts/storage-repair.js            # report only
node dist/scripts/storage-repair.js --apply    # rewrite the rows
```

It pairs a broken row with an orphaned object by uploader, file extension and
upload timestamp (both keys carry the same millisecond clock, so matches are
typically a few milliseconds apart). Rows reported as `NO MATCH` have no such
object and are genuinely gone — those files must be uploaded again.

Run the dry run first and read the matches. It is safe to re-run; rows that
already resolve are left alone.

## What is allowed in

- **Refused at upload**: `.html`, `.svg`, `.js`, `.php`, `.exe`, and similar —
  anything that could execute script in this origin or on a machine.
- **Previewed inline**: PDF, PNG, JPEG, GIF, WebP, plain text, CSV, MP4, WebM,
  MP3. The type served is derived from the extension allowlist, never from what
  the uploader labelled the file.
- **Everything else** downloads as `application/octet-stream`.
- `?download=1&filename=…` forces a save-to-disk response under the original
  name, so one URL serves both the previewer and the download button.
- Range requests are honoured, so video seeking does not re-fetch the file.

Size ceiling is `MAX_UPLOAD_BYTES` (25 MiB by default). Raise it if students
submit video.

## Who can read what

| Bucket | Rule |
|---|---|
| `resources` | any signed-in user |
| `task-submissions` | the student who uploaded it, plus any mentor or admin |

The check runs on the sign request *and* again on the download, so a signed URL
can never grant more than a direct request would. Tokens are bound to one bucket
and key and expire in 15 minutes.
