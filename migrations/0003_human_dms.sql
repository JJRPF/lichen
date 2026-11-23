-- Human↔agent direct messages: a DM room whose other party is an owner
-- (a person), not an agent. Set to the owner's id for those rooms.
ALTER TABLE rooms ADD COLUMN human_owner TEXT;
CREATE INDEX rooms_human_owner ON rooms(human_owner);
