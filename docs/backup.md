# IELTS data backup and recovery

Three independent things need recovery copies:

- **PostgreSQL `ielts_db`**: attempts, drafts, notes, bookmarks, settings, practice
  sessions, catalog metadata, Daily lessons, recording metadata and migration history.
- **Private files**: read-only exported archive, uploaded recordings, Daily audio and
  the learning runtime SQLite database/WAL. A PostgreSQL dump contains file
  references, not audio bytes or runtime checkpoints.
- **Configuration**: IELTS-specific SOPS ciphertext and an independently protected
  age identity. SOPS does not back up database rows or recordings.

Never put a backup in Git, a public Actions artifact, GHCR or an HTTP-served
folder. Keep an off-host encrypted copy. The shared platform's database snapshot
mechanism may discover the new database, but this must be verified; it does not
prove that the IELTS file directories are covered.

## Installed platform backup chain

Production uses the shared platform's version-4 daily snapshots and existing
server-to-Mac pull schedule. Each snapshot pairs the fresh `ielts_db` dump with
recording files, Daily audio, database references, a standalone SQLite runtime
snapshot, private service configuration and the release manifest. Backup and
release use the same maintenance lock. The backup stops `ielts-api` and the
previously running `ielts-learning` for a consistent cut, with independent
120-second watchdogs; it then restores both services and checks versions. The
runtime main/WAL files are copied to private staging before SQLite backup merges
committed pages, so the producer does not open or alter the production SQLite file.

The immutable archive is backed up separately once and referenced by checksum;
it is not recopied into every daily snapshot. Keep that separate archive and the
dedicated age recovery key available when rehearsing a complete recovery.

The Mac pull verifies the snapshot manifest and files before publishing the local
copy. Its isolated PostgreSQL restore drill also checks that saved recording
and Daily metadata point to restored files, verifies audio sizes/checksums,
and checks SQLite integrity plus pending runtime owner references. Genuine v1–v3
copies remain readable, but a v3 release that declares learning is rejected as
incomplete. Install the shared helper and new Mac consumer/restore before the
server producer; the implementation and exact install order live in
[yiminlab backup tooling](https://github.com/yiminspace/yiminlab/tree/main/infrastructure/backup).
The destination storage must be encrypted;
private file permissions alone do not provide encryption. The standalone tools
below remain available for an independent full archive snapshot or rehearsal.

## Consistent snapshot

Run `deploy/backup.py` from a trusted administration checkout on the server. It
requires a maintenance window and `--quiesce`: it stops the running API and learning writers, creates
a custom-format dump through the existing PostgreSQL container, archives the
private files, and restarts those writers even if backup fails. Quiescing prevents a
recording upload/deletion from racing the database and filesystem snapshots.
The frontend remains available but API operations briefly fail and drafts stay
in the browser until synchronization resumes.

```sh
python3 deploy/backup.py --destination /private-backup-location/new-snapshot --quiesce
```

The destination must not already exist. It contains `ielts.dump`, `archive.tar`,
`recordings.tar`, `daily.tar`, `runtime.tar`, the non-secret release manifest if present, and SHA-256
checksums. Directories are mode 700 and files mode 600. Copy the completed
snapshot off-host through an encrypted channel and encrypt the destination
storage. Backups themselves contain personal data in usable form until encrypted
by the chosen backup-storage mechanism.

## Verify and rehearse recovery

```sh
python3 deploy/backup.py --verify /private-backup-location/snapshot
bash deploy/restore-check.sh /private-backup-location/snapshot
```

The first command verifies hashes, safe file entries and the PostgreSQL archive
structure. The second restores the dump into a **new disposable local container
with no network or exposed port**, extracts the file archives into a private temporary
directory and checks saved recording/Daily references, audio hashes and SQLite integrity.
Standalone format 2 contains the new files; legacy format 1 remains readable. It does not overwrite the production database or original materials.
The rehearsed database is removed after the command completes.

For real recovery, first prepare a separate target database and private file
directories, recreate restricted runtime/migration roles, restore the dump with
ownership/privileges reviewed, reinstall application grants/RLS, then verify
record counts, recording/Daily files, runtime checkpoints, owner-only access and health version before
switching traffic. Restoring a dump as superuser is not permission acceptance;
the application must still start successfully using its restricted role.

The rehearsal is a structural/database/file check. A full disaster recovery
acceptance additionally requires starting the restored API and testing an owner
login, draft resume and media/recording playback in the browser. Report that
separately from checksum or dump validation.

## Recorded activation verification

On 2026-10-28, snapshot `20261028_083246` was generated as v4, copied to the Mac
and fully verified (1,267 files, 684,966,702 bytes). An IELTS-only isolated restore
loaded its `ielts_db` dump, matched recording/Daily reference projections, and
passed runtime SQLite integrity. Ownership-checked cleanup removed all temporary
containers/volumes; production container IDs did not change. The snapshot had
zero recordings and Daily lessons/audio, so nonempty reference behavior was
checked separately with original fixtures and the actual pinned Runtime Store.
This was an IELTS recovery rehearsal, not a nine-database platform disaster
recovery or a browser write test against restored production records.
