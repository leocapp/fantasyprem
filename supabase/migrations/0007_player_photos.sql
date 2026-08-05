-- 0007_player_photos.sql
-- Headshot URL, populated by the ingestion job from the FPL `photo` field.
-- Nullable: not every player has an image, and the CDN path can change.

alter table players add column if not exists photo_url text;
