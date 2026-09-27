-- AlterTable
ALTER TABLE "copies" ADD COLUMN     "disk_bytes" BIGINT,
ADD COLUMN     "disk_checked_at" TIMESTAMP(3),
ADD COLUMN     "over_disk_limit" BOOLEAN NOT NULL DEFAULT false;
