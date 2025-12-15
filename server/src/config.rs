use std::env;

pub struct Config {
    pub database_url: String,
    pub api_port: u16,
    pub cors_origin: String,
}

impl Config {
    pub fn from_env() -> Self {
        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite:./data.db".to_string());
        
        let api_port = env::var("API_PORT")
            .unwrap_or_else(|_| "3000".to_string())
            .parse()
            .unwrap_or(3000);
        
        let cors_origin = env::var("CORS_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:5173".to_string());

        Self {
            database_url,
            api_port,
            cors_origin,
        }
    }
}

