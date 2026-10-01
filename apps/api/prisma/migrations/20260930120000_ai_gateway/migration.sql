-- AlterTable
ALTER TABLE "copies" ADD COLUMN     "ai_gateway_token_hash" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ai_allow_paid" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_gateway_usage" (
    "user_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_gateway_usage_pkey" PRIMARY KEY ("user_id","day","model")
);

-- CreateIndex
CREATE UNIQUE INDEX "copies_ai_gateway_token_hash_key" ON "copies"("ai_gateway_token_hash");

-- AddForeignKey
ALTER TABLE "ai_gateway_usage" ADD CONSTRAINT "ai_gateway_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

