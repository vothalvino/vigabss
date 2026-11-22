-- Rollback 015 — removes 'transcribe' from ai_usage_events.operation. Usage
-- rows of that kind are deleted first (the earlier ENUM cannot hold them), so
-- the month's recorded AI cost drops by what voice notes had cost. The earlier
-- code never transcribes.

DROP PROCEDURE IF EXISTS r015_ai_usage_transcribe;
DELIMITER $$
CREATE PROCEDURE r015_ai_usage_transcribe()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_usage_events' AND COLUMN_NAME = 'operation'
       AND COLUMN_TYPE LIKE '%''transcribe''%'
  ) THEN
    DELETE FROM ai_usage_events WHERE operation = 'transcribe';
    ALTER TABLE ai_usage_events MODIFY COLUMN operation ENUM('chat','embed') NOT NULL;
  END IF;
END $$
DELIMITER ;
CALL r015_ai_usage_transcribe();
DROP PROCEDURE IF EXISTS r015_ai_usage_transcribe;
