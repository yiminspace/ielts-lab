# IELTS data backup and recovery

Three independent things need recovery copies:

- **PostgreSQL `ielts_db`**: attempts, drafts, notes, bookmarks, settings, practice
  sessions, catalog metadata, recording metadata and migration history.
- **Private files**: read-only exported archive plus uploaded recordings. A
  database dump contains references, not the file bytes.
- **Configuration**: IELTS-specific SOPS ciphertext and an independently protected
  age identity. SOPS does not back up database rows or recordings.

Never put a backup in Git, a public Actions artifact, GHCR or an HTTP-served
folder. Keep an off-host encrypted copy. The shared platform's database snapshot
mechanism may discover the new database, but this must be verified; it does not
prove that the IELTS file directories are covered.

## Installed platform backup chain

Production uses the shared platform's version-3 daily snapshots and existing
server-to-Mac pull schedule. Each snapshot pairs the fresh `ielts_db` dump with
recording files, their database references, private runtime configuration and
the release manifest. Backup and release use the same maintenance lock. The
backup briefly stops `ielts-api` for a consistent file/database cut, with a
60-second watchdog; it then checks the API and Web versions agree.

The immutable archive is backed up separately once and referenced by checksum;
it is not recopied into every daily snapshot. Keep that separate archive and the
dedicated age recovery key available when rehearsing a complete recovery.

The Mac pull verifies the snapshot manifest and files before publishing the local
copy. Its isolated PostgreSQL restore drill also checks that saved recording
metadata points to restored files. The destination storage must be encrypted;
private file permissions alone do not provide encryption. The standalone tools
below remain available for an independent full archive snapshot or rehearsal.

## Consistent snapshot

Run `deploy/backup.py` from a trusted administration checkout on the server. It
requires a maintenance window and `--quiesce`: it stops only `ielts-api`, creates
a custom-format dump through the existing PostgreSQL container, archives the
private files, and restarts the API even if backup fails. Quiescing prevents a
recording upload/deletion from racing the database and filesystem snapshots.
The frontend remains available but API operations briefly fail and drafts stay
in the browser until synchronization resumes.

```sh
python3 deploy/backup.py --destination /private-backup-location/new-snapshot --quiesce
```

The destination must not already exist. It contains `ielts.dump`, `archive.tar`,
`recordings.tar`, the non-secret release manifest if present, and SHA-256
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
with no network or exposed port**, extracts both file archives into a temporary
directory and checks every saved recording metadata reference has a restored
file. It does not overwrite the production database or original materials.
The rehearsed database is removed after the command completes.

For real recovery, first prepare a separate target database and private file
directories, recreate restricted runtime/migration roles, restore the dump with
ownership/privileges reviewed, reinstall application grants/RLS, then verify
record counts, recording files, owner-only access and health version before
switching traffic. Restoring a dump as superuser is not permission acceptance;
the application must still start successfully using its restricted role.

The rehearsal is a structural/database/file check. A full disaster recovery
acceptance additionally requires starting the restored API and testing an owner
login, draft resume and media/recording playback in the browser. Report that
separately from checksum or dump validation.
