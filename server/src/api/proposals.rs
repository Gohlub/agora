use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::db::{DbPool, Proposal, ProposalSignature, TransactionHistory, ProposalStatus, TransactionStatus};
use crate::error::AppError;

// === Request/Response types ===

#[derive(Debug, Deserialize)]
pub struct CreateProposalRequest {
    pub tx_id: String,
    pub lock_root_hash: String,
    pub proposer_pkh: String,
    pub threshold: i32,
    pub raw_tx_json: String,           // Serialized unsigned RawTx
    pub notes_json: String,            // Serialized notes for signing
    pub spend_conditions_json: String, // Serialized spend conditions
    pub total_input_nicks: i64,
    pub seeds: Vec<SeedSummary>,       // Human-readable seed info
    pub proposer_signed_tx_json: String, // Proposer signs at creation
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SeedSummary {
    pub recipient: String,
    pub amount_nicks: i64,
}

#[derive(Debug, Serialize)]
pub struct CreateProposalResponse {
    pub id: String,
    pub tx_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ListProposalsQuery {
    pub pkh: Option<String>,           // Filter by participant PKH
    pub lock_root_hash: Option<String>, // Filter by wallet
    pub status: Option<String>,        // Filter by status
}

#[derive(Debug, Serialize)]
pub struct ProposalResponse {
    pub id: String,
    pub tx_id: String,
    pub lock_root_hash: String,
    pub proposer_pkh: String,
    pub status: String,
    pub threshold: i32,
    pub signatures_collected: i32,
    pub total_input_nicks: i64,
    pub seeds: Vec<SeedSummary>,
    pub signers: Vec<String>,          // PKHs who have signed
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct SignatureEntry {
    pub signer_pkh: String,
    pub signed_tx_json: String,
    pub signed_at: String,
}

#[derive(Debug, Serialize)]
pub struct ProposalDetailResponse {
    pub id: String,
    pub tx_id: String,
    pub lock_root_hash: String,
    pub proposer_pkh: String,
    pub status: String,
    pub threshold: i32,
    pub signatures_collected: i32,
    pub raw_tx_json: String,
    pub notes_json: String,
    pub spend_conditions_json: String,
    pub total_input_nicks: i64,
    pub seeds: Vec<SeedSummary>,
    pub signers: Vec<String>,
    /// All collected signatures with their signed tx data
    pub signatures: Vec<SignatureEntry>,
    pub participants: Vec<String>,     // All wallet participants
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct SignProposalRequest {
    pub signer_pkh: String,
    /// The signed RawTx protobuf as JSON - contains this signer's signature
    pub signed_tx_json: String,
}

#[derive(Debug, Serialize)]
pub struct SignProposalResponse {
    pub success: bool,
    pub signatures_collected: i32,
    pub ready_to_broadcast: bool,
}

#[derive(Debug, Deserialize)]
pub struct BroadcastProposalRequest {
    pub _broadcaster_pkh: String,
    /// The final transaction ID after merging signatures (may differ from original proposal tx_id)
    pub final_tx_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DirectSpendRequest {
    pub tx_id: String,
    pub lock_root_hash: String,
    pub sender_pkh: String,
    pub total_input_nicks: i64,
    pub seeds: Vec<SeedSummary>,
}

#[derive(Debug, Serialize)]
pub struct DirectSpendResponse {
    pub success: bool,
    pub history_id: String,
}

#[derive(Debug, Serialize)]
pub struct TransactionHistoryResponse {
    pub id: String,
    pub tx_id: String,
    pub lock_root_hash: String,
    pub proposer_pkh: String,
    pub status: String,
    pub total_input_nicks: i64,
    pub seeds: Vec<SeedSummary>,
    pub signers: Vec<String>,
    pub created_at: String,
    pub broadcast_at: Option<String>,
    pub confirmed_at: Option<String>,
}

// === Router ===

pub fn router() -> Router<DbPool> {
    Router::new()
        .route("/", post(create_proposal).get(list_proposals))
        .route("/:id", get(get_proposal))
        .route("/:id/sign", post(sign_proposal))
        .route("/:id/broadcast", post(mark_broadcast))
        .route("/history", get(get_history))
        .route("/direct", post(direct_spend))
}

// === Handlers ===

async fn create_proposal(
    State(pool): State<DbPool>,
    Json(req): Json<CreateProposalRequest>,
) -> Result<Json<CreateProposalResponse>, AppError> {
    // Check if proposal with this tx_id already exists
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM proposals WHERE tx_id = ? LIMIT 1"
    )
    .bind(&req.tx_id)
    .fetch_optional(&pool)
    .await?;
    
    if let Some(existing_id) = existing {
        return Err(AppError::InvalidInput(
            format!("A proposal with this transaction ID already exists (ID: {})", existing_id)
        ));
    }
    
    // Verify the lock exists
    let lock_exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM locks WHERE lock_root_hash = ? LIMIT 1"
    )
    .bind(&req.lock_root_hash)
    .fetch_optional(&pool)
    .await?;
    
    if lock_exists.is_none() {
        return Err(AppError::NotFound(
            format!("Wallet with lock_root_hash {} not found", req.lock_root_hash)
        ));
    }
    
    let proposal_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let seeds_json = serde_json::to_string(&req.seeds)
        .map_err(|e| AppError::InvalidInput(format!("Failed to serialize seeds: {}", e)))?;
    
    let status_str = serde_json::to_string(&ProposalStatus::Pending)
        .map_err(|e| AppError::InvalidInput(format!("Failed to serialize status: {}", e)))?
        .trim_matches('"')
        .to_string();
    
    sqlx::query(
        "INSERT INTO proposals (id, tx_id, lock_root_hash, proposer_pkh, status, threshold, 
         raw_tx_json, notes_json, spend_conditions_json, total_input_nicks, seeds_json, 
         created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&proposal_id)
    .bind(&req.tx_id)
    .bind(&req.lock_root_hash)
    .bind(&req.proposer_pkh)
    .bind(&status_str)
    .bind(req.threshold)
    .bind(&req.raw_tx_json)
    .bind(&req.notes_json)
    .bind(&req.spend_conditions_json)
    .bind(req.total_input_nicks)
    .bind(&seeds_json)
    .bind(&now)
    .bind(&now)
    .execute(&pool)
    .await?;
    
    // Record proposer's signature
    sqlx::query(
        "INSERT INTO proposal_signatures (proposal_id, signer_pkh, signed_tx_json, signed_at) VALUES (?, ?, ?, ?)"
    )
    .bind(&proposal_id)
    .bind(&req.proposer_pkh)
    .bind(&req.proposer_signed_tx_json)
    .bind(&now)
    .execute(&pool)
    .await?;
    
    // Check if ready (same logic as sign_proposal)
    let sig_count: i32 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM proposal_signatures WHERE proposal_id = ?"
    )
    .bind(&proposal_id)
    .fetch_one(&pool)
    .await?;
    
    if sig_count >= req.threshold {
        let ready_status = serde_json::to_string(&ProposalStatus::Ready)
            .unwrap_or_else(|_| "ready".to_string())
            .trim_matches('"')
            .to_string();
        sqlx::query("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?")
            .bind(&ready_status)
            .bind(&now)
            .bind(&proposal_id)
            .execute(&pool)
            .await?;
    }
    
    Ok(Json(CreateProposalResponse {
        id: proposal_id,
        tx_id: req.tx_id,
    }))
}

async fn list_proposals(
    State(pool): State<DbPool>,
    Query(params): Query<ListProposalsQuery>,
) -> Result<Json<Vec<ProposalResponse>>, AppError> {
    // Build query based on filters
    let proposals: Vec<Proposal> = if let Some(pkh) = &params.pkh {
        // Get proposals for wallets where this PKH is a participant
        sqlx::query_as::<_, Proposal>(
            "SELECT DISTINCT p.* FROM proposals p
             INNER JOIN lock_participants lp ON p.lock_root_hash = lp.lock_root_hash
             WHERE lp.pkh = ?
             ORDER BY p.created_at DESC"
        )
        .bind(pkh)
        .fetch_all(&pool)
        .await?
    } else if let Some(lock_root_hash) = &params.lock_root_hash {
        sqlx::query_as::<_, Proposal>(
            "SELECT * FROM proposals WHERE lock_root_hash = ? ORDER BY created_at DESC"
        )
        .bind(lock_root_hash)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Proposal>(
            "SELECT * FROM proposals ORDER BY created_at DESC"
        )
        .fetch_all(&pool)
        .await?
    };
    
    // Filter by status if provided
    let proposals: Vec<Proposal> = if let Some(status_str) = &params.status {
        let filter_status: ProposalStatus = status_str.parse()
            .map_err(|e| AppError::InvalidInput(format!("Invalid status: {} - {}", status_str, e)))?;
        proposals.into_iter().filter(|p| p.status == filter_status).collect()
    } else {
        proposals
    };
    
    // Get signatures for each proposal
    let mut responses = Vec::new();
    for proposal in proposals {
        let signatures: Vec<ProposalSignature> = sqlx::query_as::<_, ProposalSignature>(
            "SELECT * FROM proposal_signatures WHERE proposal_id = ?"
        )
        .bind(&proposal.id)
        .fetch_all(&pool)
        .await?;
        
        let signers: Vec<String> = signatures.iter().map(|s| s.signer_pkh.clone()).collect();
        let seeds: Vec<SeedSummary> = serde_json::from_str(&proposal.seeds_json).unwrap_or_default();
        
        responses.push(ProposalResponse {
            id: proposal.id,
            tx_id: proposal.tx_id,
            lock_root_hash: proposal.lock_root_hash,
            proposer_pkh: proposal.proposer_pkh,
            status: serde_json::to_string(&proposal.status)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
            threshold: proposal.threshold,
            signatures_collected: signers.len() as i32,
            total_input_nicks: proposal.total_input_nicks,
            seeds,
            signers,
            created_at: proposal.created_at,
            updated_at: proposal.updated_at,
        });
    }
    
    Ok(Json(responses))
}

async fn get_proposal(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
) -> Result<Json<ProposalDetailResponse>, AppError> {
    let proposal: Proposal = sqlx::query_as::<_, Proposal>(
        "SELECT * FROM proposals WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Proposal {} not found", id)))?;
    
    // Get signatures with their data
    let db_signatures: Vec<ProposalSignature> = sqlx::query_as::<_, ProposalSignature>(
        "SELECT * FROM proposal_signatures WHERE proposal_id = ?"
    )
    .bind(&proposal.id)
    .fetch_all(&pool)
    .await?;
    
    let signers: Vec<String> = db_signatures.iter().map(|s| s.signer_pkh.clone()).collect();
    let signatures: Vec<SignatureEntry> = db_signatures.iter().map(|s| SignatureEntry {
        signer_pkh: s.signer_pkh.clone(),
        signed_tx_json: s.signed_tx_json.clone(),
        signed_at: s.signed_at.clone(),
    }).collect();
    
    // Get participants
    let participants: Vec<String> = sqlx::query_scalar(
        "SELECT pkh FROM lock_participants WHERE lock_root_hash = ?"
    )
    .bind(&proposal.lock_root_hash)
    .fetch_all(&pool)
    .await?;
    
    let seeds: Vec<SeedSummary> = serde_json::from_str(&proposal.seeds_json).unwrap_or_default();
    
    Ok(Json(ProposalDetailResponse {
        id: proposal.id,
        tx_id: proposal.tx_id,
        lock_root_hash: proposal.lock_root_hash,
        proposer_pkh: proposal.proposer_pkh,
        status: serde_json::to_string(&proposal.status)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string(),
        threshold: proposal.threshold,
        signatures_collected: signers.len() as i32,
        raw_tx_json: proposal.raw_tx_json,
        notes_json: proposal.notes_json,
        spend_conditions_json: proposal.spend_conditions_json,
        total_input_nicks: proposal.total_input_nicks,
        seeds,
        signers,
        signatures,
        participants,
        created_at: proposal.created_at,
        updated_at: proposal.updated_at,
    }))
}

async fn sign_proposal(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
    Json(req): Json<SignProposalRequest>,
) -> Result<Json<SignProposalResponse>, AppError> {
    // Get proposal
    let proposal: Proposal = sqlx::query_as::<_, Proposal>(
        "SELECT * FROM proposals WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Proposal {} not found", id)))?;
    
    if proposal.status != ProposalStatus::Pending {
        return Err(AppError::InvalidInput(
            format!("Cannot sign proposal with status: {:?}", proposal.status)
        ));
    }
    
    // Verify signer is a participant
    let is_participant: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM lock_participants WHERE lock_root_hash = ? AND pkh = ?"
    )
    .bind(&proposal.lock_root_hash)
    .bind(&req.signer_pkh)
    .fetch_optional(&pool)
    .await?;
    
    if is_participant.is_none() {
        return Err(AppError::InvalidInput(
            format!("PKH {} is not a participant of this wallet", req.signer_pkh)
        ));
    }
    
    // Check if already signed
    let already_signed: Option<String> = sqlx::query_scalar(
        "SELECT signer_pkh FROM proposal_signatures WHERE proposal_id = ? AND signer_pkh = ?"
    )
    .bind(&proposal.id)
    .bind(&req.signer_pkh)
    .fetch_optional(&pool)
    .await?;
    
    if already_signed.is_some() {
        return Err(AppError::InvalidInput(
            format!("PKH {} has already signed this proposal", req.signer_pkh)
        ));
    }
    
    // Record signature with the signed tx data
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO proposal_signatures (proposal_id, signer_pkh, signed_tx_json, signed_at) VALUES (?, ?, ?, ?)"
    )
    .bind(&proposal.id)
    .bind(&req.signer_pkh)
    .bind(&req.signed_tx_json)
    .bind(&now)
    .execute(&pool)
    .await?;
    
    // Count signatures
    let sig_count: i32 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM proposal_signatures WHERE proposal_id = ?"
    )
    .bind(&proposal.id)
    .fetch_one(&pool)
    .await?;
    
    let ready_to_broadcast = sig_count >= proposal.threshold;
    
    // Update status if ready
    if ready_to_broadcast {
        let status_str = serde_json::to_string(&ProposalStatus::Ready)
            .unwrap_or_else(|_| "ready".to_string())
            .trim_matches('"')
            .to_string();
        sqlx::query("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?")
            .bind(&status_str)
            .bind(&now)
            .bind(&proposal.id)
            .execute(&pool)
            .await?;
    } else {
        sqlx::query("UPDATE proposals SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&proposal.id)
            .execute(&pool)
            .await?;
    }
    
    Ok(Json(SignProposalResponse {
        success: true,
        signatures_collected: sig_count,
        ready_to_broadcast,
    }))
}

async fn mark_broadcast(
    State(pool): State<DbPool>,
    Path(id): Path<String>,
    Json(req): Json<BroadcastProposalRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let proposal: Proposal = sqlx::query_as::<_, Proposal>(
        "SELECT * FROM proposals WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Proposal {} not found", id)))?;
    
    let now = chrono::Utc::now().to_rfc3339();
    
    // Use the final tx_id if provided (after signature merging), otherwise use original
    let final_tx_id = req.final_tx_id.as_ref().unwrap_or(&proposal.tx_id);
    
    // Get signers
    let signers: Vec<String> = sqlx::query_scalar(
        "SELECT signer_pkh FROM proposal_signatures WHERE proposal_id = ?"
    )
    .bind(&proposal.id)
    .fetch_all(&pool)
    .await?;
    
    let signers_json = serde_json::to_string(&signers)
        .map_err(|e| AppError::InvalidInput(format!("Failed to serialize signers: {}", e)))?;
    
    // Create history entry with the FINAL tx_id (after merging signatures)
    let history_id = Uuid::new_v4().to_string();
    let tx_status_str = serde_json::to_string(&TransactionStatus::Broadcast)
        .unwrap_or_else(|_| "broadcast".to_string())
        .trim_matches('"')
        .to_string();
    sqlx::query(
        "INSERT INTO transaction_history (id, tx_id, lock_root_hash, proposer_pkh, status,
         total_input_nicks, seeds_json, signers_json, created_at, broadcast_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&history_id)
    .bind(final_tx_id)
    .bind(&proposal.lock_root_hash)
    .bind(&proposal.proposer_pkh)
    .bind(&tx_status_str)
    .bind(proposal.total_input_nicks)
    .bind(&proposal.seeds_json)
    .bind(&signers_json)
    .bind(&proposal.created_at)
    .bind(&now)
    .execute(&pool)
    .await?;
    
    // Update proposal status
    let status_str = serde_json::to_string(&ProposalStatus::Broadcast)
        .unwrap_or_else(|_| "broadcast".to_string())
        .trim_matches('"')
        .to_string();
    sqlx::query("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ?")
        .bind(&status_str)
        .bind(&now)
        .bind(&proposal.id)
        .execute(&pool)
        .await?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "history_id": history_id
    })))
}

/// Direct spend for 1-of-n wallets - bypasses proposal flow, records directly to history
async fn direct_spend(
    State(pool): State<DbPool>,
    Json(req): Json<DirectSpendRequest>,
) -> Result<Json<DirectSpendResponse>, AppError> {
    // Verify the lock exists
    let lock_exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM locks WHERE lock_root_hash = ? LIMIT 1"
    )
    .bind(&req.lock_root_hash)
    .fetch_optional(&pool)
    .await?;
    
    if lock_exists.is_none() {
        return Err(AppError::NotFound(
            format!("Wallet with lock_root_hash {} not found", req.lock_root_hash)
        ));
    }
    
    // Verify sender is a participant
    let is_participant: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM lock_participants WHERE lock_root_hash = ? AND pkh = ?"
    )
    .bind(&req.lock_root_hash)
    .bind(&req.sender_pkh)
    .fetch_optional(&pool)
    .await?;
    
    if is_participant.is_none() {
        return Err(AppError::InvalidInput(
            format!("PKH {} is not a participant of this wallet", req.sender_pkh)
        ));
    }
    
    let now = chrono::Utc::now().to_rfc3339();
    let history_id = Uuid::new_v4().to_string();
    
    let seeds_json = serde_json::to_string(&req.seeds)
        .map_err(|e| AppError::InvalidInput(format!("Failed to serialize seeds: {}", e)))?;
    let signers_json = serde_json::to_string(&vec![&req.sender_pkh])
        .map_err(|e| AppError::InvalidInput(format!("Failed to serialize signers: {}", e)))?;
    
    let tx_status_str = serde_json::to_string(&TransactionStatus::Broadcast)
        .unwrap_or_else(|_| "broadcast".to_string())
        .trim_matches('"')
        .to_string();
    
    sqlx::query(
        "INSERT INTO transaction_history (id, tx_id, lock_root_hash, proposer_pkh, status,
         total_input_nicks, seeds_json, signers_json, created_at, broadcast_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&history_id)
    .bind(&req.tx_id)
    .bind(&req.lock_root_hash)
    .bind(&req.sender_pkh)
    .bind(&tx_status_str)
    .bind(req.total_input_nicks)
    .bind(&seeds_json)
    .bind(&signers_json)
    .bind(&now)
    .bind(&now)
    .execute(&pool)
    .await?;
    
    Ok(Json(DirectSpendResponse {
        success: true,
        history_id,
    }))
}

async fn get_history(
    State(pool): State<DbPool>,
    Query(params): Query<ListProposalsQuery>,
) -> Result<Json<Vec<TransactionHistoryResponse>>, AppError> {
    let history: Vec<TransactionHistory> = if let Some(pkh) = &params.pkh {
        // Get history for wallets where this PKH is a participant
        sqlx::query_as::<_, TransactionHistory>(
            "SELECT DISTINCT h.* FROM transaction_history h
             INNER JOIN lock_participants lp ON h.lock_root_hash = lp.lock_root_hash
             WHERE lp.pkh = ?
             ORDER BY h.broadcast_at DESC"
        )
        .bind(pkh)
        .fetch_all(&pool)
        .await?
    } else if let Some(lock_root_hash) = &params.lock_root_hash {
        sqlx::query_as::<_, TransactionHistory>(
            "SELECT * FROM transaction_history WHERE lock_root_hash = ? ORDER BY broadcast_at DESC"
        )
        .bind(lock_root_hash)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, TransactionHistory>(
            "SELECT * FROM transaction_history ORDER BY broadcast_at DESC"
        )
        .fetch_all(&pool)
        .await?
    };
    
    let responses: Vec<TransactionHistoryResponse> = history.into_iter().map(|h| {
        let seeds: Vec<SeedSummary> = serde_json::from_str(&h.seeds_json).unwrap_or_default();
        let signers: Vec<String> = serde_json::from_str(&h.signers_json).unwrap_or_default();
        
        TransactionHistoryResponse {
            id: h.id,
            tx_id: h.tx_id,
            lock_root_hash: h.lock_root_hash,
            proposer_pkh: h.proposer_pkh,
            status: serde_json::to_string(&h.status)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
            total_input_nicks: h.total_input_nicks,
            seeds,
            signers,
            created_at: h.created_at,
            broadcast_at: h.broadcast_at,
            confirmed_at: h.confirmed_at,
        }
    }).collect();
    
    Ok(Json(responses))
}

