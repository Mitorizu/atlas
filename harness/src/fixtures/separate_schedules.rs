//! Same component, one writer each, but in different schedules. NOT ambiguous (condition 1).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Shield(pub u32);

pub fn early_shield(mut q: Query<&mut Shield>) { for mut s in &mut q { s.0 += 1; } }
pub fn late_shield(mut q: Query<&mut Shield>) { for mut s in &mut q { s.0 += 1; } }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(PreUpdate, early_shield);
    app.add_systems(Update, late_shield);
    app
}
