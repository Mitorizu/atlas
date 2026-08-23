//! Two unordered systems touching the same component, one of them writing. AMBIGUOUS.
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Health(pub u32);

pub fn writes_health(mut q: Query<&mut Health>) { for mut h in &mut q { h.0 += 1; } }
pub fn reads_health(q: Query<&Health>) { for _h in &q {} }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(Update, (writes_health, reads_health));
    app
}
