CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
-- Fixed collection metadata is checked by migration, indexing and aggregation.
-- Daily history is append-only in time; initial_history_days is not a retention TTL.
CREATE TABLE IF NOT EXISTS collection_state(
 singleton boolean PRIMARY KEY CHECK(singleton), start_day date NOT NULL,
 initial_history_days integer NOT NULL CHECK(initial_history_days>0),
 method_version text NOT NULL, history_policy text NOT NULL CHECK(history_policy='growing-permanent'),
 initialized_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chain_checkpoints(
 chain integer PRIMARY KEY CHECK(chain BETWEEN 0 AND 19), height bigint NOT NULL,
 hash text NOT NULL, block_time timestamptz NOT NULL, anchor_hash text NOT NULL,
 baseline_inventory jsonb NOT NULL, baseline_header jsonb NOT NULL, coverage_start date NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blocks(
 chain integer NOT NULL CHECK(chain BETWEEN 0 AND 19), height bigint NOT NULL,
 hash text NOT NULL, parent text NOT NULL, block_time timestamptz NOT NULL,
 creation_time bigint NOT NULL CHECK(creation_time>=0),
 payload_hash text NOT NULL, work numeric(78,0) NOT NULL CHECK(work>0),
 transaction_count integer NOT NULL CHECK(transaction_count>=0), source_digest text NOT NULL,
 PRIMARY KEY(chain,height), UNIQUE(chain,hash)
);
-- Bounded replay tail only: ingestion retains at most 500 headers per chain.
-- Historical work/account coverage lives permanently in compact daily summaries.
-- Only the raw replay header tail is pruned; collection coverage_start never advances.
CREATE TABLE IF NOT EXISTS daily_chain_stats(
 day date NOT NULL, chain integer NOT NULL CHECK(chain BETWEEN 0 AND 19),
 work numeric(90,0) NOT NULL CHECK(work>0), block_count bigint NOT NULL CHECK(block_count>0),
 transaction_count bigint NOT NULL CHECK(transaction_count>=0),
 first_height bigint NOT NULL, last_height bigint NOT NULL CHECK(last_height>=first_height),
 first_parent text NOT NULL, first_creation_time bigint NOT NULL, last_header jsonb NOT NULL,
 PRIMARY KEY(day,chain), CHECK(block_count=last_height-first_height+1)
);
CREATE INDEX IF NOT EXISTS blocks_by_time ON blocks(block_time,chain);
CREATE TABLE IF NOT EXISTS daily_accounts(
 day date NOT NULL, chain integer NOT NULL, account text NOT NULL CHECK(length(account)>0),
 PRIMARY KEY(day,chain,account)
);
-- existed_before_window refers to the one fixed collection boundary, never a rolling window.
CREATE TABLE IF NOT EXISTS modules(
 chain integer NOT NULL, name text NOT NULL, existed_before_window boolean NOT NULL,
 first_height bigint, first_request_key text, PRIMARY KEY(chain,name)
);
CREATE TABLE IF NOT EXISTS module_deployments(
 chain integer NOT NULL, height bigint NOT NULL, block_hash text NOT NULL,
 block_time timestamptz NOT NULL, request_key text NOT NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('new','upgrade')),
 artifact_status text NOT NULL CHECK(artifact_status IN ('included','excluded','review')),
 policy_version text NOT NULL, evidence jsonb NOT NULL,
 PRIMARY KEY(chain,request_key,name)
);
CREATE INDEX IF NOT EXISTS deployments_by_time ON module_deployments(block_time);
-- Durable unresolved declarations are a publication barrier, not an exclusion
-- list. There is intentionally no manually writable "resolved" flag. Removing
-- evidence requires verified canonical replay plus chronological ledger rebuild.
CREATE TABLE IF NOT EXISTS module_identity_reviews(
 chain integer NOT NULL CHECK(chain BETWEEN 0 AND 19), height bigint NOT NULL,
 block_hash text NOT NULL, block_time timestamptz NOT NULL, request_key text NOT NULL,
 transaction_index integer NOT NULL CHECK(transaction_index>=0),
 declaration_index integer NOT NULL CHECK(declaration_index>=0),
 literal_name text, identity_source text NOT NULL,
 source_start integer CHECK(source_start>=0), source_end integer CHECK(source_end>=source_start),
 policy_version text NOT NULL, evidence_digest text NOT NULL, evidence jsonb NOT NULL,
 queued_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chain,request_key,declaration_index),
 UNIQUE(chain,height,transaction_index,declaration_index)
);
CREATE INDEX IF NOT EXISTS module_identity_reviews_by_time ON module_identity_reviews(block_time);
CREATE TABLE IF NOT EXISTS account_extraction_state(
 singleton boolean PRIMARY KEY CHECK(singleton), version text NOT NULL,
 status text NOT NULL CHECK(status IN ('repair_required','repairing','ready')),
 details jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO account_extraction_state(singleton,version,status)
 SELECT true,'pact-transfer-v2',CASE WHEN EXISTS(SELECT 1 FROM blocks) THEN 'repair_required' ELSE 'ready' END
 ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS source_evidence(
 id bigserial PRIMARY KEY, source text NOT NULL, day date, digest text NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
 UNIQUE(source,digest)
);
CREATE TABLE IF NOT EXISTS source_observations(
 source text NOT NULL, day date NOT NULL, version text NOT NULL, payload jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source,day,version)
);
CREATE TABLE IF NOT EXISTS daily_metrics(
 day date PRIMARY KEY, raw jsonb NOT NULL, coverage jsonb NOT NULL,
 registry_version text NOT NULL, method_version text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS index_snapshots(
 day date PRIMARY KEY REFERENCES daily_metrics(day), score numeric(7,1) NOT NULL CHECK(score>=0),
 payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_runs(
 id bigserial PRIMARY KEY, kind text NOT NULL, trigger text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','incomplete')),
 through_day date, details jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS api_keys(
 id bigserial PRIMARY KEY, label text NOT NULL, key_hash text UNIQUE NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;

-- v6: the fixed-baseline index has no ceiling. Widen existing databases in place.
ALTER TABLE index_snapshots DROP CONSTRAINT IF EXISTS index_snapshots_score_check;
ALTER TABLE index_snapshots ALTER COLUMN score TYPE numeric(7,1);
ALTER TABLE index_snapshots ADD CONSTRAINT index_snapshots_score_check CHECK(score>=0);
-- Derived scores replaced by an explicit method migration are archived, never discarded.
CREATE TABLE IF NOT EXISTS index_snapshot_archive(
 method_version text NOT NULL, day date NOT NULL, score numeric(7,1) NOT NULL, payload jsonb NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(method_version,day)
);
CREATE TABLE IF NOT EXISTS method_migrations(
 id bigserial PRIMARY KEY, from_version text NOT NULL, to_version text NOT NULL, days integer NOT NULL CHECK(days>=0),
 raw_sha256 text NOT NULL, archived_sha256 text NOT NULL, snapshots_sha256 text NOT NULL,
 migrated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
