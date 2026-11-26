-- Reminder channels: networks apps can't post to (Facebook profiles, Groups...). The post kit is emailed instead.
ALTER TABLE "channels" ADD COLUMN "reminder_email" TEXT;
ALTER TABLE "destinations" ADD COLUMN "confirmed_at" TIMESTAMP(3);
