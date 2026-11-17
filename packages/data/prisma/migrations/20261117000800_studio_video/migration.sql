-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiKind" ADD VALUE 'CLIP';
ALTER TYPE "AiKind" ADD VALUE 'TRANSCRIBE';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "ai_jobs" ADD COLUMN     "duration_seconds" INTEGER,
ADD COLUMN     "source_asset_id" UUID,
ADD COLUMN     "start_second" INTEGER;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
