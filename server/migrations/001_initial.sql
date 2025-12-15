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


-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_lock_participants_pkh ON lock_participants(pkh);
CREATE INDEX IF NOT EXISTS idx_transactions_lock_id ON transactions(lock_root_hash);

