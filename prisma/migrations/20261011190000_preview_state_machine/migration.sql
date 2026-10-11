-- Keep the preview schema change and the operation state rebuild atomic on upgrade.
-- Pre-upgrade, rows sharing a canonical (repository, branch) must be deduped
-- manually; the unique index below fails loudly rather than silently merging.
BEGIN TRANSACTION;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "prTitle" TEXT;
ALTER TABLE "projects" ADD COLUMN "prAuthor" TEXT;

-- PR numbers are metadata, not identity: (repository, branch) is the single
-- preview identity rule.
DROP INDEX "projects_repository_pullRequestNumber_key";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued' CHECK ("state" IN ('queued', 'provisioning', 'ready', 'failed')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "operations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Legacy 'pending' rows were never driven by a worker; queue them so the
-- machine sees only defined states.
INSERT INTO "new_operations" ("id", "projectId", "kind", "state", "createdAt", "updatedAt", "startedAt", "finishedAt", "error")
SELECT "id", "projectId", "kind", CASE WHEN "state" = 'pending' THEN 'queued' ELSE "state" END,
  "createdAt", "updatedAt", "startedAt", "finishedAt", "error" FROM "operations";
DROP TABLE "operations";
ALTER TABLE "new_operations" RENAME TO "operations";
CREATE INDEX "operations_projectId_createdAt_idx" ON "operations"("projectId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "projects_repository_branch_key" ON "projects"("repository", "branch");

COMMIT;
