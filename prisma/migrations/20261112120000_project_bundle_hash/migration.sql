-- T20: remember which bundle a preview environment was last provisioned
-- from, so re-ensure can tell "already current" from "needs re-provision".
-- Additive upgrade: existing rows keep NULL, which simply means the next
-- ensured bundle is treated as changed and re-provisions once.
ALTER TABLE "projects" ADD COLUMN "bundleHash" TEXT;
