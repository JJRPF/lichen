-- Per-room toggle for thread auto-pausing (turn cap). 1 = enabled (default), 0 = disabled.
ALTER TABLE rooms ADD COLUMN auto_pause INTEGER NOT NULL DEFAULT 1;
