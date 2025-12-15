use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// Database models - these match the SQLite schema (TEXT for UUIDs and timestamps)
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Lock {
    #[sqlx(rename = "id")]
    pub id: String, // Stored as TEXT in SQLite
    pub threshold: i32,
    pub total_signers: i32,
    #[sqlx(rename = "created_at")]
    pub created_at: String, // Stored as TEXT (RFC3339) in SQLite
    pub created_by_pkh: String,
    #[sqlx(rename = "lock_root_hash")]
    pub lock_root_hash: String, // Base58-encoded lock-root hash (firstName) - UNIQUE
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LockParticipant {
    pub lock_id: String,
    pub pkh: String,
}





