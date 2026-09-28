-- AlterTable
ALTER TABLE "copies" ADD COLUMN     "marker_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pending_conflict_paths" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "conflict_paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "merged_at" TIMESTAMP(3),
ADD COLUMN     "merged_by_id" TEXT,
ADD COLUMN     "reverted_at" TIMESTAMP(3),
ADD COLUMN     "reverted_by_id" TEXT,
ADD COLUMN     "reverted_sha" TEXT;

-- CreateIndex
CREATE INDEX "submissions_project_id_status_idx" ON "submissions"("project_id", "status");

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_merged_by_id_fkey" FOREIGN KEY ("merged_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_reverted_by_id_fkey" FOREIGN KEY ("reverted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
