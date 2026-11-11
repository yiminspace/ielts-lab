# Back up IELTS Lab

Back up the PostgreSQL database, private files, and deployment configuration
together. Private files include imported materials, recordings, generated audio,
and the optional learning service's SQLite state. Database backups may include
references to files, so a database dump alone cannot restore media.

Pause writers or use a coordinated snapshot so database records and file
references describe the same point in time. Keep encrypted backups outside the
application host and retain configuration recovery keys separately.

Rehearse restores against an isolated database and storage directory. Verify
database integrity and sample course and media references before using a backup
for recovery.
