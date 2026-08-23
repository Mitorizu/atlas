//! Ground-truth oracle for atlas's ambiguity analysis (DESIGN.md §8).
//!
//! Builds each fixture's app with Bevy's own `ambiguity_detection` enabled, then reports
//! `ScheduleGraph::conflicting_systems()` as JSON. `npm test` diffs this against what
//! atlas derives statically from the very same source files.
//!
//! This is the only component of the project that compiles or runs Rust, it is
//! development-time only, and it never runs against a user's repository (§5.1).
use bevy_app::prelude::*;
use bevy_ecs::schedule::{LogLevel, ScheduleBuildSettings, Schedules};
use std::collections::HashMap;

mod fixtures;

fn main() {
    let mut all = serde_json::Map::new();
    for (name, build) in fixtures::all() {
        all.insert(name.to_string(), serde_json::Value::Array(run(build)));
    }
    println!("{}", serde_json::Value::Object(all));
}

/// Builds one fixture app and returns the conflicting system pairs Bevy itself found.
fn run(build: fn() -> App) -> Vec<serde_json::Value> {
    let mut app = build();

    let mut out = Vec::new();
    let world = app.world_mut();
    // Taken out rather than borrowed via `resource_scope`: `initialize` inserts resources,
    // which `resource_scope` refuses.
    let Some(mut schedules) = world.remove_resource::<Schedules>() else {
        return out;
    };
    {
        for (label, schedule) in schedules.iter_mut() {
            schedule.set_build_settings(ScheduleBuildSettings {
                ambiguity_detection: LogLevel::Warn,
                ..ScheduleBuildSettings::default()
            });
            if schedule.initialize(world).is_err() {
                continue;
            }

            let names: HashMap<_, String> = match schedule.systems() {
                Ok(iter) => iter.map(|(key, system)| (key, short(&system.name().to_string()))).collect(),
                Err(_) => continue,
            };

            for (a, b, _) in schedule.graph().conflicting_systems().0.iter() {
                let (Some(x), Some(y)) = (names.get(a), names.get(b)) else { continue };
                let mut pair = [x.clone(), y.clone()];
                pair.sort();
                out.push(serde_json::json!({
                    "schedule": format!("{label:?}"),
                    "a": pair[0],
                    "b": pair[1],
                }));
            }
        }
    }
    world.insert_resource(schedules);
    out.sort_by_key(std::string::ToString::to_string);
    out
}

/// `atlas_ambiguity_oracle::fixtures::plain_conflict::writes_health` -> `writes_health`
fn short(name: &str) -> String {
    name.rsplit("::").next().unwrap_or(name).to_string()
}
