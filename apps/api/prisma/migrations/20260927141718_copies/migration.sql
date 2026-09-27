-- CreateEnum
CREATE TYPE "copy_container_status" AS ENUM ('none', 'starting', 'running', 'stopped', 'failed');

-- CreateTable
CREATE TABLE "copies" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "branch_name" TEXT NOT NULL,
    "container_id" TEXT,
    "container_status" "copy_container_status" NOT NULL DEFAULT 'none',
    "last_active_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copies_user_id_idx" ON "copies"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "copies_project_id_user_id_key" ON "copies"("project_id", "user_id");

-- AddForeignKey
ALTER TABLE "copies" ADD CONSTRAINT "copies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "copies" ADD CONSTRAINT "copies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
