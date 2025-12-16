use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// Proposal status 
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProposalStatus {
    Pending,
    Ready,
    Broadcast,
    Confirmed,
    Expired,
}

// Transaction history status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransactionStatus {
    Broadcast,
    Confirmed,
    Failed,
}

// Database models 
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Lock {
    #[sqlx(rename = "lock_root_hash")]
    pub lock_root_hash: String, // Base58-encoded lock-root hash (firstName) - PRIMARY KEY
    pub threshold: i32,
    pub total_signers: i32,
    #[sqlx(rename = "created_at")]
    pub created_at: String, // Stored as TEXT (RFC3339) in SQLite
    pub created_by_pkh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LockParticipant {
    pub lock_root_hash: String,
    pub pkh: String,
}

// Transaction proposal awaiting signatures
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Proposal {
    pub id: String,
    pub tx_id: String,
    pub lock_root_hash: String,
    pub proposer_pkh: String,
    #[sqlx(try_from = "String")]
    pub status: ProposalStatus,
    pub threshold: i32,
    pub raw_tx_json: String,
    pub notes_json: String,
    pub spend_conditions_json: String,
    pub total_input_nicks: i64,
    pub seeds_json: String,
    pub created_at: String,
    pub updated_at: String,
}

impl TryFrom<String> for ProposalStatus {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "pending" => Ok(ProposalStatus::Pending),
            "ready" => Ok(ProposalStatus::Ready),
            "broadcast" => Ok(ProposalStatus::Broadcast),
            "confirmed" => Ok(ProposalStatus::Confirmed),
            "expired" => Ok(ProposalStatus::Expired),
            _ => Err(format!("Invalid proposal status: {}", value)),
        }
    }
}

impl std::str::FromStr for ProposalStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(ProposalStatus::Pending),
            "ready" => Ok(ProposalStatus::Ready),
            "broadcast" => Ok(ProposalStatus::Broadcast),
            "confirmed" => Ok(ProposalStatus::Confirmed),
            "expired" => Ok(ProposalStatus::Expired),
            _ => Err(format!("Invalid proposal status: {}", s)),
        }
    }
}

// Signature record for a proposal (includes the actual signed tx data)
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ProposalSignature {
    pub proposal_id: String,
    pub signer_pkh: String,
    pub signed_tx_json: String, // The signed RawTx from this signer
    pub signed_at: String,
}

// Completed transaction history
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct TransactionHistory {
    pub id: String,
    pub tx_id: String,
    pub lock_root_hash: String,
    pub proposer_pkh: String,
    #[sqlx(try_from = "String")]
    pub status: TransactionStatus,
    pub total_input_nicks: i64,
    pub seeds_json: String,
    pub signers_json: String,
    pub created_at: String,
    pub broadcast_at: Option<String>,
    pub confirmed_at: Option<String>,
}

impl TryFrom<String> for TransactionStatus {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "broadcast" => Ok(TransactionStatus::Broadcast),
            "confirmed" => Ok(TransactionStatus::Confirmed),
            "failed" => Ok(TransactionStatus::Failed),
            _ => Err(format!("Invalid transaction status: {}", value)),
        }
    }
}

