-- Recreate SupportChatManualEmbedding (dropped accidentally by Prisma drift detection in 20260312041345)
-- This table uses pgvector and is intentionally managed outside schema.prisma

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "SupportChatManualEmbedding" (
  "chunkId" TEXT PRIMARY KEY,
  "entryId" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "module" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "errorCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "content" TEXT NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "SupportChatManualEmbedding_locale_idx"
  ON "SupportChatManualEmbedding" ("locale");

CREATE INDEX IF NOT EXISTS "SupportChatManualEmbedding_route_idx"
  ON "SupportChatManualEmbedding" ("route");

CREATE INDEX IF NOT EXISTS "SupportChatManualEmbedding_module_idx"
  ON "SupportChatManualEmbedding" ("module");

CREATE INDEX IF NOT EXISTS "SupportChatManualEmbedding_entryId_idx"
  ON "SupportChatManualEmbedding" ("entryId");

CREATE INDEX IF NOT EXISTS "SupportChatManualEmbedding_embedding_ivfflat_idx"
  ON "SupportChatManualEmbedding"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
