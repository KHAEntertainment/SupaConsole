-- Keep schema changes and legacy reservations atomic on upgrade.
BEGIN TRANSACTION;

-- CreateTable
CREATE TABLE "allocated_ports" (
    "port" INTEGER NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    CONSTRAINT "allocated_ports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "operations" (
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

-- Additive upgrade preserves existing projects and child records.
ALTER TABLE "projects" ADD COLUMN "environmentType" TEXT NOT NULL DEFAULT 'persistent';
ALTER TABLE "projects" ADD COLUMN "repository" TEXT;
ALTER TABLE "projects" ADD COLUMN "pullRequestNumber" INTEGER;
ALTER TABLE "projects" ADD COLUMN "branch" TEXT;
ALTER TABLE "projects" ADD COLUMN "headSha" TEXT;
ALTER TABLE "projects" ADD COLUMN "expiryAt" DATETIME;
CREATE UNIQUE INDEX "projects_repository_pullRequestNumber_key" ON "projects"("repository", "pullRequestNumber");

-- Gateway aliases within one project represent the same host port. Conflicts
-- Ignore retired configure defaults. For contested published ports, the oldest
-- project owns the reservation; the port remains unavailable to new projects.
WITH stored_ports AS (
  SELECT "projectId", trim(trim(trim(
    CASE WHEN instr("value", '#') > 0
      THEN substr("value", 1, instr("value", '#') - 1) ELSE "value" END,
    ' ' || char(9) || char(10) || char(13)), '"' || char(39)),
    ' ' || char(9) || char(10) || char(13)) AS value
  FROM "project_env_vars" AS env
  WHERE ("key" IN ('API_GW_HTTP_PORT', 'KONG_HTTP_PORT', 'POSTGRES_PORT', 'POOLER_PROXY_PORT_TRANSACTION')
    OR ("key" = 'KONG_HTTPS_PORT' AND NOT EXISTS (
      SELECT 1 FROM "project_env_vars" AS gateway
      WHERE gateway."projectId" = env."projectId" AND gateway."key" = 'API_GW_HTTP_PORT'
    )))
    AND "projectId" IN (SELECT "id" FROM "projects")
)
INSERT OR IGNORE INTO "allocated_ports" ("port", "projectId")
SELECT DISTINCT CAST(value AS INTEGER), "projectId" FROM stored_ports
WHERE value <> '' AND value NOT GLOB '*[^0-9]*'
  AND CAST(value AS INTEGER) BETWEEN 1 AND 65535
ORDER BY (SELECT "createdAt" FROM "projects" WHERE "id" = stored_ports."projectId"), "projectId";

-- CreateIndex
CREATE INDEX "allocated_ports_projectId_idx" ON "allocated_ports"("projectId");

-- CreateIndex
CREATE INDEX "operations_projectId_createdAt_idx" ON "operations"("projectId", "createdAt");


COMMIT;
