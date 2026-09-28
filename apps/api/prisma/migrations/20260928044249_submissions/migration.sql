-- CreateEnum
CREATE TYPE "submission_status" AS ENUM ('open', 'changes_requested', 'approved', 'needs_update', 'merged', 'rejected', 'closed', 'reverted');

-- CreateEnum
CREATE TYPE "file_change" AS ENUM ('added', 'modified', 'deleted');

-- CreateEnum
CREATE TYPE "review_decision" AS ENUM ('approved', 'changes_requested');

-- CreateEnum
CREATE TYPE "diff_side" AS ENUM ('base', 'head');

-- CreateEnum
CREATE TYPE "suggestion_status" AS ENUM ('pending', 'accepted', 'rejected');

-- AlterTable
ALTER TABLE "copies" ADD COLUMN     "base_sha" TEXT;

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "copy_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "task_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "base_sha" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "submission_status" NOT NULL DEFAULT 'open',
    "reject_reason" TEXT,
    "merged_sha" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_files" (
    "submission_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "change" "file_change" NOT NULL,

    CONSTRAINT "submission_files_pkey" PRIMARY KEY ("submission_id","path")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "decision" "review_decision" NOT NULL,
    "body" TEXT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "path" TEXT,
    "side" "diff_side",
    "line" INTEGER,
    "start_line" INTEGER,
    "line_text" TEXT,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "suggestion" TEXT,
    "suggestion_status" "suggestion_status",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "submissions_project_id_created_at_idx" ON "submissions"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "submissions_copy_id_status_idx" ON "submissions"("copy_id", "status");

-- CreateIndex
CREATE INDEX "submissions_author_id_idx" ON "submissions"("author_id");

-- CreateIndex
CREATE INDEX "reviews_submission_id_created_at_idx" ON "reviews"("submission_id", "created_at");

-- CreateIndex
CREATE INDEX "reviews_reviewer_id_idx" ON "reviews"("reviewer_id");

-- CreateIndex
CREATE INDEX "comments_submission_id_created_at_idx" ON "comments"("submission_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_parent_id_idx" ON "comments"("parent_id");

-- CreateIndex
CREATE INDEX "comments_author_id_idx" ON "comments"("author_id");

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_copy_id_fkey" FOREIGN KEY ("copy_id") REFERENCES "copies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
