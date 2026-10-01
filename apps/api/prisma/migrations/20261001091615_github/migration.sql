-- CreateEnum
CREATE TYPE "github_mode" AS ENUM ('publish_once', 'keep_updated');

-- CreateEnum
CREATE TYPE "github_link_status" AS ENUM ('ok', 'pushing', 'paused', 'failed');

-- AlterEnum
ALTER TYPE "repo_source" ADD VALUE 'github';

-- CreateTable
CREATE TABLE "github_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_user_id" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "encrypted_access_token" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMP(3),
    "encrypted_refresh_token" TEXT,
    "refresh_token_expires_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_oauth_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "encrypted_verifier" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_links" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "installation_id" BIGINT NOT NULL,
    "repo_id" BIGINT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "html_url" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL,
    "mode" "github_mode" NOT NULL,
    "set_up_by_id" TEXT,
    "last_pushed_sha" TEXT,
    "last_pushed_at" TIMESTAMP(3),
    "status" "github_link_status" NOT NULL DEFAULT 'pushing',
    "status_reason" TEXT,
    "sync_requested_at" TIMESTAMP(3),
    "push_claim" TEXT,
    "push_started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_accounts_user_id_key" ON "github_accounts"("user_id");

-- CreateIndex
CREATE INDEX "github_accounts_github_user_id_idx" ON "github_accounts"("github_user_id");

-- CreateIndex
CREATE INDEX "github_oauth_states_user_id_idx" ON "github_oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "github_oauth_states_session_id_idx" ON "github_oauth_states"("session_id");

-- CreateIndex
CREATE INDEX "github_oauth_states_expires_at_idx" ON "github_oauth_states"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "github_links_project_id_key" ON "github_links"("project_id");

-- CreateIndex
CREATE INDEX "github_links_status_idx" ON "github_links"("status");

-- AddForeignKey
ALTER TABLE "github_accounts" ADD CONSTRAINT "github_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_links" ADD CONSTRAINT "github_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_links" ADD CONSTRAINT "github_links_set_up_by_id_fkey" FOREIGN KEY ("set_up_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
