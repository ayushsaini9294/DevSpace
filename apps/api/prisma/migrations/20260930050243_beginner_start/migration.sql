-- AlterEnum
ALTER TYPE "repo_source" ADD VALUE 'template';

-- AlterTable
ALTER TABLE "project_members" ADD COLUMN     "getting_started_hidden_at" TIMESTAMP(3),
ADD COLUMN     "previewed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "template" TEXT;
