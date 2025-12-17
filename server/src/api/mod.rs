pub mod multisigs;
pub mod proposals;

use axum::Router;
use crate::db::DbPool;

pub fn create_router(pool: DbPool) -> Router {
    Router::new()
        .nest("/api/multisigs", multisigs::router())
        .nest("/api/proposals", proposals::router())
        .with_state(pool)
}

