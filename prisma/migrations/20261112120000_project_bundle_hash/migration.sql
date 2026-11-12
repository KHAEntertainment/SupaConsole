-- T20: remember which bundle a preview environment was last provisioned
-- from, and which operation currently owns it, so re-ensure can tell
-- "already current" from "needs re-provision" and only the owning attempt
-- writes project status.
-- Additive upgrade: existing rows keep NULL bundleHash, which means the
-- next ensured bundle is treated as changed and re-provisions once (the
-- old bundle's content is unknown, so it is never silently adopted).
ALTER TABLE "projects" ADD COLUMN "bundleHash" TEXT;
ALTER TABLE "projects" ADD COLUMN "currentOperationId" TEXT;
