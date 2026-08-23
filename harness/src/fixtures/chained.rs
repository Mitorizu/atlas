//! `.chain()` orders the tuple's members, so the overlap is resolved (§7.6, condition 2).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Hp(pub u32);

pub fn damage_hp(mut q: Query<&mut Hp>) { for mut h in &mut q { h.0 += 1; } }
pub fn report_hp(q: Query<&Hp>) { for _h in &q {} }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(Update, (damage_hp, report_hp).chain());
    app
}
