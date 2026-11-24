ALTER TABLE "posts" ADD COLUMN "repeat_every_days" INTEGER;
ALTER TABLE "posts" ADD COLUMN "repeat_source_id" UUID;
CREATE UNIQUE INDEX "posts_repeat_source_id_key" ON "posts"("repeat_source_id");

ALTER TABLE "post_revisions" ADD COLUMN "media_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "post_revisions" ADD COLUMN "overrides" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "post_revisions" ADD COLUMN "thread" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "destinations" ADD COLUMN "thread_index" INTEGER NOT NULL DEFAULT 0;
UPDATE "destinations" SET "thread_index" = 1 WHERE "parent_id" IS NOT NULL;

ALTER TABLE "assets" ADD COLUMN "alt" TEXT;
ALTER TABLE "assets" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE TABLE "tags" (
  "id" UUID NOT NULL, "workspace_id" UUID NOT NULL, "name" TEXT NOT NULL, "color" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tags_workspace_id_name_key" ON "tags"("workspace_id", "name");

CREATE TABLE "post_tags" (
  "post_id" UUID NOT NULL, "tag_id" UUID NOT NULL,
  CONSTRAINT "post_tags_pkey" PRIMARY KEY ("post_id", "tag_id"),
  CONSTRAINT "post_tags_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "post_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "post_tags_tag_id_idx" ON "post_tags"("tag_id");

CREATE TABLE "signatures" (
  "id" UUID NOT NULL, "workspace_id" UUID NOT NULL, "name" TEXT NOT NULL, "content" TEXT NOT NULL,
  "is_default" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signatures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signatures_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "signatures_workspace_id_idx" ON "signatures"("workspace_id");

CREATE TABLE "post_sets" (
  "id" UUID NOT NULL, "workspace_id" UUID NOT NULL, "name" TEXT NOT NULL, "data" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "post_sets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "post_sets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "post_sets_workspace_id_name_key" ON "post_sets"("workspace_id", "name");
