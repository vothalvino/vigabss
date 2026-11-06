# Rollbacks

`src/scripts/rollback.js` undoes applied migrations newest-first, running the
file here with the same numeric prefix (`database/rollbacks/002_x.sql` undoes
`database/migrations/002_x.sql`). Every migration after the baseline ships one.

`001_baseline.sql` has no rollback: it is the whole schema. To start over,
restore a backup or drop and recreate the database.
