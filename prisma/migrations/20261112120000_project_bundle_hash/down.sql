-- Reverses T20's additive columns. Used by tests/preview-migration.test.ts to
-- restore the pre-T12 shape for its downgrade comparison; installs never run
-- it (T20 only ever adds the columns).
ALTER TABLE "operations" DROP COLUMN "bundleHash";
ALTER TABLE "projects" DROP COLUMN "currentOperationId";
ALTER TABLE "projects" DROP COLUMN "bundleHash";
