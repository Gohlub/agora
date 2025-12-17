use sqlx::{sqlite::{SqliteConnectOptions, SqlitePoolOptions}, Pool, Sqlite};
use std::str::FromStr;
use std::time::Duration;

pub type DbPool = Pool<Sqlite>;

pub async fn create_pool(database_url: &str) -> Result<DbPool, sqlx::Error> {
    // Create parent directories if they don't exist
    if let Some(path_str) = database_url.strip_prefix("sqlite:") {
        let path = std::path::Path::new(path_str);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }
    
    let options = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true);
    
    SqlitePoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await
}

