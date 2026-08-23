//! A real overlap the author has declared intentional. NOT reported (condition 5).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Mana(pub u32);

pub fn drain_mana(mut q: Query<&mut Mana>) { for mut m in &mut q { m.0 += 1; } }
pub fn regen_mana(mut q: Query<&mut Mana>) { for mut m in &mut q { m.0 += 1; } }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(Update, (drain_mana.ambiguous_with(regen_mana), regen_mana));
    app
}
