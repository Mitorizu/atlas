//! Ordering declared between SETS, not systems (condition 2 + §7.6 configure_sets).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Vel(pub u32);

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct StepSet;

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct SyncSet;

pub fn step_vel(mut q: Query<&mut Vel>) { for mut v in &mut q { v.0 += 1; } }
pub fn sync_vel(q: Query<&Vel>) { for _v in &q {} }

pub fn build() -> App {
    let mut app = App::new();
    app.configure_sets(Update, (StepSet.before(SyncSet),));
    app.add_systems(Update, (step_vel.in_set(StepSet), sync_vel.in_set(SyncSet)));
    app
}
