-- Rollback 023 — drops olt_onu_readings. The remembered distance and signal of
-- each ONU are lost; they build up again as ports are read.

DROP TABLE IF EXISTS olt_onu_readings;
