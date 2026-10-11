-- CreateTable
CREATE TABLE "preview_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenLookup" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "expiresAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "preview_tokens_tokenHash_key" ON "preview_tokens"("tokenHash");

-- CreateIndex
-- sha256(cleartext) of a 192-bit random token is not password-equivalent, so it
-- is safe to index for O(1) verification. The bcrypt hash is the security
-- boundary; the lookup column only directs us to the right row.
CREATE UNIQUE INDEX "preview_tokens_tokenLookup_key" ON "preview_tokens"("tokenLookup");

-- CreateIndex
CREATE INDEX "preview_tokens_repository_createdAt_idx" ON "preview_tokens"("repository", "createdAt");
