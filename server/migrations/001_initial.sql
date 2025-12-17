-- ============================================================================
-- Initial Schema: Multisig Wallets and Transaction Proposals
-- ============================================================================

-- Multisig locks (spend conditions)
CREATE TABLE IF NOT EXISTS locks (
    lock_root_hash TEXT PRIMARY KEY, -- Base58-encoded lock-root hash (firstName) - unique identifier
    threshold INTEGER NOT NULL,
    total_signers INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    created_by_pkh TEXT NOT NULL
);

-- Lock participants (pkhs that can sign)
CREATE TABLE IF NOT EXISTS lock_participants (
    lock_root_hash TEXT NOT NULL, 
    pkh TEXT NOT NULL,
    PRIMARY KEY (lock_root_hash, pkh),
    FOREIGN KEY (lock_root_hash) REFERENCES locks(lock_root_hash) ON DELETE CASCADE
);

-- Transaction proposals (unsigned transactions awaiting signatures)
CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,                    -- UUID
    tx_id TEXT NOT NULL UNIQUE,             -- Transaction ID (hash of tx contents)
    lock_root_hash TEXT NOT NULL,           -- Which multisig wallet
    proposer_pkh TEXT NOT NULL,             -- Who created the proposal
    status TEXT NOT NULL DEFAULT 'pending', -- pending, ready, broadcast, confirmed, expired
    threshold INTEGER NOT NULL,             -- Required signatures (m)
    
    -- Serialized transaction data (JSON)
    raw_tx_json TEXT NOT NULL,              -- Unsigned RawTx protobuf as JSON
    notes_json TEXT NOT NULL,               -- Notes array for signing
    spend_conditions_json TEXT NOT NULL,    -- SpendConditions for signing
    
    -- Human-readable summary
    total_input_nicks INTEGER NOT NULL,     -- Total input amount
    seeds_json TEXT NOT NULL,               -- Array of {recipient, amount} for display
    
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    
    FOREIGN KEY (lock_root_hash) REFERENCES locks(lock_root_hash) ON DELETE CASCADE
);

-- Collected signatures for proposals
CREATE TABLE IF NOT EXISTS proposal_signatures (
    proposal_id TEXT NOT NULL,
    signer_pkh TEXT NOT NULL,
    -- The signed RawTx JSON from this signer (contains their signature in the witness)
    -- At broadcast time, we extract and aggregate all signatures
    signed_tx_json TEXT NOT NULL,
    signed_at TEXT NOT NULL,
    
    PRIMARY KEY (proposal_id, signer_pkh),
    FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
);

-- Transaction history (completed/broadcast transactions)
CREATE TABLE IF NOT EXISTS transaction_history (
    id TEXT PRIMARY KEY,
    tx_id TEXT NOT NULL,
    lock_root_hash TEXT NOT NULL,
    proposer_pkh TEXT NOT NULL,
    status TEXT NOT NULL,                   -- broadcast, confirmed, failed
    
    total_input_nicks INTEGER NOT NULL,
    seeds_json TEXT NOT NULL,
    signers_json TEXT NOT NULL,             -- Array of PKHs who signed
    
    created_at TEXT NOT NULL,               -- When proposal was created
    broadcast_at TEXT,                      -- When tx was broadcast
    confirmed_at TEXT,                      -- When tx was confirmed (if applicable)
    
    FOREIGN KEY (lock_root_hash) REFERENCES locks(lock_root_hash) ON DELETE CASCADE
);

-- ============================================================================
-- Indexes for performance
-- ============================================================================

-- Lock indexes
CREATE INDEX IF NOT EXISTS idx_lock_participants_pkh ON lock_participants(pkh);

-- Proposal indexes
CREATE INDEX IF NOT EXISTS idx_proposals_lock_root_hash ON proposals(lock_root_hash);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposal_signatures_signer ON proposal_signatures(signer_pkh);

-- Transaction history indexes
CREATE INDEX IF NOT EXISTS idx_transaction_history_lock_root ON transaction_history(lock_root_hash);
