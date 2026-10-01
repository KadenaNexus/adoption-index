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

-- v7: accounts, sessions, subscriptions and payments (Milestone 2). Nothing above changes.
-- Login and session tokens are stored only as SHA-256 hex. Login emails are sent at request time and never stored.
CREATE TABLE IF NOT EXISTS users(id bigserial PRIMARY KEY, email text UNIQUE NOT NULL CHECK(email=lower(email) AND length(email) BETWEEN 3 AND 254), created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz);
-- Each sign-in email carries a link (token_hash) and a 6-digit code (code_hash = SHA-256 of email:code), both single-use; at most 5 wrong codes.
CREATE TABLE IF NOT EXISTS login_tokens(token_hash text PRIMARY KEY, email text NOT NULL, code_hash text, attempts integer NOT NULL DEFAULT 0, next_path text, request_ip text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE INDEX IF NOT EXISTS login_tokens_by_email ON login_tokens(email,created_at);
CREATE INDEX IF NOT EXISTS login_tokens_by_ip ON login_tokens(request_ip,created_at);
-- One row per wrong sign-in code; at most 10 per email per 24 hours, so a 6-digit code cannot be guessed over time.
CREATE TABLE IF NOT EXISTS login_code_failures(email text NOT NULL, at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS login_code_failures_by_email ON login_code_failures(email,at);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS wallet_challenges(nonce text PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, address text NOT NULL CHECK(address ~ '^0x[0-9a-f]{40}$'), message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE IF NOT EXISTS wallets(address text PRIMARY KEY CHECK(address ~ '^0x[0-9a-f]{40}$'), user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, message text NOT NULL, signature text NOT NULL, linked_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS wallets_by_user ON wallets(user_id);
CREATE TABLE IF NOT EXISTS subscriptions(user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, plan text NOT NULL, started_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>started_at), updated_at timestamptz NOT NULL DEFAULT now());
-- rail 'evm': network bsc|bsc-testnet, chain '56'|'97', tx_hash 0x + 64 lowercase hex, token_address = the token contract, decimals 18.
-- Amounts are integers in token base units.
CREATE TABLE IF NOT EXISTS payment_intents(id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, rail text NOT NULL CHECK(rail IN ('evm')), network text NOT NULL, chain text NOT NULL, plan text NOT NULL, token text NOT NULL, token_address text NOT NULL, decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 36), amount numeric(78,0) NOT NULL CHECK(amount>0), pay_to text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, payment_id bigint);
CREATE INDEX IF NOT EXISTS payment_intents_by_user ON payment_intents(user_id,created_at);
CREATE TABLE IF NOT EXISTS payments(id bigserial PRIMARY KEY, rail text NOT NULL CHECK(rail IN ('evm')), network text NOT NULL, chain text NOT NULL, tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'), user_id bigint NOT NULL REFERENCES users(id), intent_id bigint REFERENCES payment_intents(id), from_address text NOT NULL, to_address text NOT NULL, token text NOT NULL, token_address text NOT NULL, decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 36), amount numeric(78,0) NOT NULL CHECK(amount>0), required_amount numeric(78,0) NOT NULL CHECK(required_amount>0), plan text NOT NULL, status text NOT NULL CHECK(status IN ('pending','confirmed','underpaid','failed')), failure_reason text, block_number bigint, block_hash text, source text NOT NULL CHECK(source IN ('checkout','manual','reconciler')), period_start timestamptz, period_end timestamptz, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(network,tx_hash));
CREATE INDEX IF NOT EXISTS payments_by_user ON payments(user_id,created_at);
CREATE INDEX IF NOT EXISTS payments_pending ON payments(status) WHERE status='pending';
CREATE TABLE IF NOT EXISTS unmatched_transfers(network text NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL, from_address text NOT NULL, token text NOT NULL, amount numeric(78,0) NOT NULL, block_number bigint NOT NULL, seen_at timestamptz NOT NULL DEFAULT now(), resolved_note text, PRIMARY KEY(network,tx_hash,log_index));
CREATE TABLE IF NOT EXISTS alert_rules(id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, direction text NOT NULL CHECK(direction IN ('above','below')), threshold numeric(8,1) NOT NULL CHECK(threshold>=0 AND threshold<=100000), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,direction,threshold));
CREATE TABLE IF NOT EXISTS email_outbox(id bigserial PRIMARY KEY, dedupe_key text UNIQUE NOT NULL, kind text NOT NULL, to_email text NOT NULL, subject text NOT NULL, text_body text NOT NULL, html_body text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')), attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text, provider_id text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(next_attempt_at) WHERE status='queued';
CREATE TABLE IF NOT EXISTS worker_state(key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admin_actions(id bigserial PRIMARY KEY, admin_email text NOT NULL, action text NOT NULL, user_id bigint REFERENCES users(id), details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;

-- v8: reports from the public "Report a data issue" form. The email is optional. ip_hash serves only the rate limit: it
-- is a keyed hash of the visitor's address (no address is stored), cleared two days on, when the next report arrives.
-- The form requires the evidence; the table does not, so that rule can change without a migration. Once deployed this
-- statement no longer changes the table: later changes go in a new block of ALTER statements, as in v6.
CREATE TABLE IF NOT EXISTS data_reports(id bigserial PRIMARY KEY, indicator text NOT NULL CHECK(indicator IN ('index','addresses','contracts','tvl','hashrate','commits','other')), description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000), evidence text CHECK(evidence IS NULL OR length(evidence) BETWEEN 1 AND 500), email text CHECK(email IS NULL OR (email=lower(email) AND length(email) BETWEEN 3 AND 254)), ip_hash text, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by text, resolved_note text, CHECK((resolved_at IS NULL)=(resolved_note IS NULL)));
CREATE INDEX IF NOT EXISTS data_reports_by_time ON data_reports(created_at);
CREATE INDEX IF NOT EXISTS data_reports_by_ip ON data_reports(ip_hash,created_at) WHERE ip_hash IS NOT NULL;
INSERT INTO schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
