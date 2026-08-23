//! Each fixture is its own file with its own `App::new()`, so atlas scopes them
//! separately (§7.3) and systems from different fixtures are never compared.
use bevy_app::App;

pub mod chained;
pub mod disjoint_filters;
pub mod ordered;
pub mod plain_conflict;
pub mod separate_schedules;
pub mod set_ordered;
pub mod suppressed;
pub mod transitively_ordered;

pub fn all() -> Vec<(&'static str, fn() -> App)> {
    vec![
        ("plain_conflict", plain_conflict::build as fn() -> App),
        ("ordered", ordered::build),
        ("transitively_ordered", transitively_ordered::build),
        ("set_ordered", set_ordered::build),
        ("disjoint_filters", disjoint_filters::build),
        ("suppressed", suppressed::build),
        ("chained", chained::build),
        ("separate_schedules", separate_schedules::build),
    ]
}
