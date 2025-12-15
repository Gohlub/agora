pub mod multisigs;

use axum::Router;
use crate::db::DbPool;

pub fn create_router(pool: DbPool) -> Router {
    Router::new()
        .nest("/api/multisigs", multisigs::router())
        .with_state(pool)
}

