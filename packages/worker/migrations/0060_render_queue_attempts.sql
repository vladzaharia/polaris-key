-- Feeds (adapter review): a render that keeps failing must not hold the head of
-- `registry_render_queue`. The drain counts each failed attempt on the row (only while its
-- `generation` is still the one it read) and reads the queue fewest-attempts first, so fresh rows
-- always render ahead of failing ones; an enqueue resets the count, since the row then names a
-- new state (`core/registryQueue.ts`).
ALTER TABLE registry_render_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
