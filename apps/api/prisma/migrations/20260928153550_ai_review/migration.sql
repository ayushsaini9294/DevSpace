-- CreateEnum
CREATE TYPE "ai_review_source" AS ENUM ('auto', 'ide');

-- CreateEnum
CREATE TYPE "ai_review_status" AS ENUM ('queued', 'running', 'done', 'failed');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ai_notice_accepted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ai_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openrouter',
    "encrypted_key" TEXT NOT NULL,
    "key_hint" TEXT NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_oauth_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "encrypted_verifier" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_reviews" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "batch_id" TEXT,
    "source" "ai_review_source" NOT NULL,
    "model" TEXT NOT NULL,
    "requested_model" TEXT NOT NULL,
    "is_free" BOOLEAN,
    "status" "ai_review_status" NOT NULL DEFAULT 'queued',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "parse_error" BOOLEAN NOT NULL DEFAULT false,
    "raw" TEXT,
    "error" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "ai_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_connections_user_id_key" ON "ai_connections"("user_id");

-- CreateIndex
CREATE INDEX "ai_oauth_states_user_id_idx" ON "ai_oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "ai_oauth_states_session_id_idx" ON "ai_oauth_states"("session_id");

-- CreateIndex
CREATE INDEX "ai_oauth_states_expires_at_idx" ON "ai_oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "ai_reviews_submission_id_created_at_idx" ON "ai_reviews"("submission_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_reviews_requested_by_id_status_idx" ON "ai_reviews"("requested_by_id", "status");

-- CreateIndex
CREATE INDEX "ai_reviews_batch_id_idx" ON "ai_reviews"("batch_id");

-- AddForeignKey
ALTER TABLE "ai_connections" ADD CONSTRAINT "ai_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_oauth_states" ADD CONSTRAINT "ai_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_oauth_states" ADD CONSTRAINT "ai_oauth_states_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
