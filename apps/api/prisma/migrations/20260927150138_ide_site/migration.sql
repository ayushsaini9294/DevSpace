-- CreateTable
CREATE TABLE "ide_tickets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "copy_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ide_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ide_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "copy_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ide_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ide_tickets_expires_at_idx" ON "ide_tickets"("expires_at");

-- CreateIndex
CREATE INDEX "ide_tickets_user_id_idx" ON "ide_tickets"("user_id");

-- CreateIndex
CREATE INDEX "ide_tickets_copy_id_idx" ON "ide_tickets"("copy_id");

-- CreateIndex
CREATE INDEX "ide_sessions_expires_at_idx" ON "ide_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "ide_sessions_user_id_idx" ON "ide_sessions"("user_id");

-- CreateIndex
CREATE INDEX "ide_sessions_copy_id_idx" ON "ide_sessions"("copy_id");

-- AddForeignKey
ALTER TABLE "ide_tickets" ADD CONSTRAINT "ide_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ide_tickets" ADD CONSTRAINT "ide_tickets_copy_id_fkey" FOREIGN KEY ("copy_id") REFERENCES "copies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ide_sessions" ADD CONSTRAINT "ide_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ide_sessions" ADD CONSTRAINT "ide_sessions_copy_id_fkey" FOREIGN KEY ("copy_id") REFERENCES "copies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
