use axum::{
    extract::{Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::db::{DbPool, Lock, LockParticipant};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
struct CreateMultisigRequest {
    lock_root_hash: String, // Base58-encoded lock-root hash (firstName) computed on client
    threshold: i32,
    total_signers: i32,
    signer_pkhs: Vec<String>, 
    created_by_pkh: String,
}

#[derive(Debug, Serialize)]
struct CreateMultisigResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ListMultisigsQuery {
    pkh: Option<String>,
}

#[derive(Debug, Serialize)]
struct MultisigResponse {
    id: String,
    lock_root_hash: String, 
    threshold: i32,
    total_signers: i32,
    created_at: String,
    created_by_pkh: String,
}

#[derive(Debug, Serialize)]
struct MultisigDetailResponse {
    id: String,
    lock_root_hash: String, 
    threshold: i32,
    total_signers: i32,
    created_at: String,
    created_by_pkh: String,
    // need this to reconstruct spending condition
    participants: Vec<String>, 
}

pub fn router() -> Router<DbPool> {
    Router::new()
        .route("/", post(create_multisig).get(list_multisigs))
        .route("/:id", get(get_multisig))
}

async fn create_multisig(
    State(pool): State<DbPool>,
    Json(req): Json<CreateMultisigRequest>,
) -> Result<Json<CreateMultisigResponse>, AppError> {
    // Check if a multisig with this lock_root_hash already exists
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM locks WHERE lock_root_hash = ? LIMIT 1"
    )
    .bind(&req.lock_root_hash)
    .fetch_optional(&pool)
    .await?;
    
    if let Some(existing_id) = existing {
        return Err(AppError::InvalidInput(
            format!("A multisig with this spending condition already exists (ID: {})", existing_id)
        ));
    }
    
    let multisig_id = Uuid::new_v4();
    
    // insert multisig spending condition 
    sqlx::query(
        "INSERT INTO locks (id, lock_root_hash, threshold, total_signers, created_at, created_by_pkh) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(multisig_id.to_string())
    .bind(&req.lock_root_hash)
    .bind(req.threshold)
    .bind(req.total_signers)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&req.created_by_pkh)
    .execute(&pool)
    .await?;
    
    // insert multisig wallet participants
    for pkh in &req.signer_pkhs {
        sqlx::query(
            "INSERT INTO lock_participants (lock_id, pkh) VALUES (?, ?)"
        )
        .bind(multisig_id.to_string())
        .bind(pkh)
        .execute(&pool)
        .await?;
    }
    
    Ok(Json(CreateMultisigResponse {
        id: multisig_id.to_string(),
    }))
}

async fn list_multisigs(
    State(pool): State<DbPool>,
    Query(params): Query<ListMultisigsQuery>,
) -> Result<Json<Vec<MultisigResponse>>, AppError> {
    let locks: Vec<Lock> = if let Some(pkh) = params.pkh {
        // Get multisigs where this PKH is a participant
        sqlx::query_as::<_, Lock>(
            "SELECT DISTINCT l.id, l.threshold, l.total_signers, l.created_at, l.created_by_pkh, l.lock_root_hash 
             FROM locks l 
             INNER JOIN lock_participants lp ON l.id = lp.lock_id 
             WHERE lp.pkh = ?"
        )
        .bind(pkh)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Lock>(
            "SELECT id, threshold, total_signers, created_at, created_by_pkh, lock_root_hash FROM locks"
        )
        .fetch_all(&pool)
        .await?
    };
    
    let response: Vec<MultisigResponse> = locks.into_iter().map(|lock| {
        MultisigResponse {
            id: lock.id,
            lock_root_hash: lock.lock_root_hash,
            threshold: lock.threshold,
            total_signers: lock.total_signers,
            created_at: lock.created_at,
            created_by_pkh: lock.created_by_pkh,
        }
    }).collect();
    
    Ok(Json(response))
}

async fn get_multisig(
    State(pool): State<DbPool>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Json<MultisigDetailResponse>, AppError> {
    let lock: Lock = sqlx::query_as::<_, Lock>(
        "SELECT id, threshold, total_signers, created_at, created_by_pkh, lock_root_hash FROM locks WHERE id = ?"
    )
    .bind(&id)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Multisig {} not found", id)))?;
    
    // Get participants
    let participants: Vec<LockParticipant> = sqlx::query_as::<_, LockParticipant>(
        "SELECT lock_id, pkh FROM lock_participants WHERE lock_id = ?"
    )
    .bind(&id)
    .fetch_all(&pool)
    .await?;
    
    let pkhs: Vec<String> = participants.into_iter().map(|p| p.pkh).collect();
    
    Ok(Json(MultisigDetailResponse {
        id: lock.id,
        lock_root_hash: lock.lock_root_hash,
        threshold: lock.threshold,
        total_signers: lock.total_signers,
        created_at: lock.created_at,
        created_by_pkh: lock.created_by_pkh,
        participants: pkhs,
    }))
}

