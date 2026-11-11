use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CoreError {
    #[error("Authentication expired for provider {provider}")]
    AuthExpired { provider: String },

    #[error("Provider {provider} returned HTTP {status}: {message}")]
    ProviderHttp {
        provider: String,
        status: u16,
        message: String,
    },

    #[error("Pull request #{pr_number} merged, but transitioning ticket {ticket_key} failed: {reason}")]
    TicketTransitionAfterMerge {
        pr_number: u64,
        ticket_key: String,
        reason: String,
    },

    #[error("Local git error: {0}")]
    GitLocalError(String),

    #[error("Storage error: {0}")]
    StorageError(String),

    #[error("Not found: {0}")]
    NotFound(String),
}
