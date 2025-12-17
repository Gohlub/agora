use axum::{
    extract::{Query, State},
    routing::{post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
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
    lock_root_hash: String,
}

#[derive(Debug, Deserialize)]
struct ListMultisigsQuery {
    pkh: Option<String>,
}

#[derive(Debug, Serialize)]
struct MultisigResponse {
    lock_root_hash: String, 
    threshold: i32,
    total_signers: i32,
    created_at: String,
    created_by_pkh: String,
    participants: Vec<String>, 
}

pub fn router() -> Router<DbPool> {
    Router::new()
        .route("/", post(create_multisig).get(list_multisigs))
}

async fn create_multisig(
    State(pool): State<DbPool>,
    Json(req): Json<CreateMultisigRequest>,
) -> Result<Json<CreateMultisigResponse>, AppError> {
    // Check if a multisig with this lock_root_hash already exists
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT lock_root_hash FROM locks WHERE lock_root_hash = ? LIMIT 1"
    )
    .bind(&req.lock_root_hash)
    .fetch_optional(&pool)
    .await?;
    
    if existing.is_some() {
        return Err(AppError::InvalidInput(
            "A multisig with this spending condition already exists".to_string()
        ));
    }
    
    // insert multisig spending condition 
    sqlx::query(
        "INSERT INTO locks (lock_root_hash, threshold, total_signers, created_at, created_by_pkh) VALUES (?, ?, ?, ?, ?)"
    )
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
            "INSERT INTO lock_participants (lock_root_hash, pkh) VALUES (?, ?)"
        )
        .bind(&req.lock_root_hash)
        .bind(pkh)
        .execute(&pool)
        .await?;
    }
    
    Ok(Json(CreateMultisigResponse {
        lock_root_hash: req.lock_root_hash,
    }))
}

async fn list_multisigs(
    State(pool): State<DbPool>,
    Query(params): Query<ListMultisigsQuery>,
) -> Result<Json<Vec<MultisigResponse>>, AppError> {
    let locks: Vec<Lock> = if let Some(pkh) = params.pkh {
        // Get multisigs where this PKH is a participant
        sqlx::query_as::<_, Lock>(
            "SELECT DISTINCT l.lock_root_hash, l.threshold, l.total_signers, l.created_at, l.created_by_pkh 
             FROM locks l 
             INNER JOIN lock_participants lp ON l.lock_root_hash = lp.lock_root_hash 
             WHERE lp.pkh = ?"
        )
        .bind(pkh)
        .fetch_all(&pool)
        .await?
    } else {
        sqlx::query_as::<_, Lock>(
            "SELECT lock_root_hash, threshold, total_signers, created_at, created_by_pkh FROM locks"
        )
        .fetch_all(&pool)
        .await?
    };
    
    if locks.is_empty() {
        return Ok(Json(vec![]));
    }
    
    // Fetch all participants for the retrieved locks in a single query
    let lock_hashes: Vec<&str> = locks.iter().map(|l| l.lock_root_hash.as_str()).collect();
    let placeholders = lock_hashes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query = format!(
        "SELECT lock_root_hash, pkh FROM lock_participants WHERE lock_root_hash IN ({})",
        placeholders
    );
    
    let mut query_builder = sqlx::query_as::<_, LockParticipant>(&query);
    for hash in &lock_hashes {
        query_builder = query_builder.bind(*hash);
    }
    let all_participants: Vec<LockParticipant> = query_builder.fetch_all(&pool).await?;
    
    // Group participants by lock_root_hash
    let mut participants_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for p in all_participants {
        participants_map.entry(p.lock_root_hash).or_default().push(p.pkh);
    }
    
    let response: Vec<MultisigResponse> = locks.into_iter().map(|lock| {
        let participants = participants_map.remove(&lock.lock_root_hash).unwrap_or_default();
        MultisigResponse {
            lock_root_hash: lock.lock_root_hash,
            threshold: lock.threshold,
            total_signers: lock.total_signers,
            created_at: lock.created_at,
            created_by_pkh: lock.created_by_pkh,
            participants,
        }
    }).collect();
    
    Ok(Json(response))
}

