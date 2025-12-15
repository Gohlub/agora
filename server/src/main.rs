mod api;
mod config;
mod db;
mod error;

use dotenv::dotenv;
use std::net::SocketAddr;
use tower::ServiceBuilder;
use tower_http::cors::{CorsLayer, Any, AllowOrigin};
use tower_http::trace::TraceLayer;
use tracing_subscriber;

use config::Config;
use db::create_pool;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load environment variables
    dotenv().ok();

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "agora_gateway=info,tower_http=info".into()),
        )
        .init();

    // Load configuration
    let config = Config::from_env();

    // Create database pool
    tracing::info!("Connecting to database: {}", config.database_url);
    let pool = create_pool(&config.database_url).await?;
    
    // Run migrations
    tracing::info!("Running database migrations...");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await?;

    // Create router
    let app = api::create_router(pool)
        .layer(
            ServiceBuilder::new()
                .layer(TraceLayer::new_for_http())
                .layer(
                    CorsLayer::new()
                        .allow_origin(AllowOrigin::exact(config.cors_origin.parse().map_err(|e| format!("Invalid CORS origin: {}", e))?))
                        .allow_methods(Any)
                        .allow_headers(Any),
                ),
        );

    // Start server
    let addr = SocketAddr::from(([0, 0, 0, 0], config.api_port));
    tracing::info!("Server starting on {}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
