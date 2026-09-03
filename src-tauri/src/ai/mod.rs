#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
use crate::papers::Paper;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;

pub(crate) mod commands;
mod keychain;
mod prompts;
mod registry;
mod stream;

// The test module (tests.rs) reaches the internal items through these
// re-exports; they are test-only so the non-test build does not see
// them as unused.
#[cfg(test)]
pub(crate) use keychain::*;
#[cfg(test)]
pub(crate) use prompts::*;
#[cfg(test)]
pub(crate) use registry::*;
#[cfg(test)]
pub(crate) use stream::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
}

#[cfg(test)]
mod tests;
