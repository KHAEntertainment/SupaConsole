-- Reverses T20's additive column. Used by tests/preview-migration.test.ts to
-- restore the pre-T12 shape for its downgrade comparison; installs never run
-- it (T20 only ever adds the column).
ALTER TABLE "projects" DROP COLUMN "bundleHash";
