-- CreateEnum
CREATE TYPE "repo_status" AS ENUM ('none', 'importing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "repo_source" AS ENUM ('empty', 'import');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "import_url" TEXT,
ADD COLUMN     "repo_error" TEXT,
ADD COLUMN     "repo_source" "repo_source",
ADD COLUMN     "repo_status" "repo_status" NOT NULL DEFAULT 'none';
