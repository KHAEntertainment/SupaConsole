-- Undo the preview state-machine migration: restore the pre-T12 shape in place.
BEGIN TRANSACTION;

DROP INDEX "projects_repository_branch_key";
CREATE UNIQUE INDEX "projects_repository_pullRequestNumber_key" ON "projects"("repository", "pullRequestNumber");
ALTER TABLE "projects" DROP COLUMN "prTitle";
ALTER TABLE "projects" DROP COLUMN "prAuthor";

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "operations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_operations" ("id", "projectId", "kind", "state", "createdAt", "updatedAt", "startedAt", "finishedAt", "error")
SELECT "id", "projectId", "kind", CASE WHEN "state" = 'queued' THEN 'pending' ELSE "state" END,
  "createdAt", "updatedAt", "startedAt", "finishedAt", "error" FROM "operations";
DROP TABLE "operations";
ALTER TABLE "new_operations" RENAME TO "operations";
CREATE INDEX "operations_projectId_createdAt_idx" ON "operations"("projectId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

COMMIT;
