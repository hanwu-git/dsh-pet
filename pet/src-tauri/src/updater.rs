// dsh-pet v2.0 vendor notice for this file:
// Upstream KuroCat's updater.rs implemented self-upgrade against qianyi.one / GitHub
// releases. Per the integration decision, self-upgrade is REMOVED entirely — this tree is
// the final repository and upgrade responsibility lives with the dsh-pet plugin market.
// Only the version constant is kept (used by get_app_version and the menu footer).

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
