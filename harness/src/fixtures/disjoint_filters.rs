//! `With<Player>` versus `Without<Player>` can never match the same entity, so the two
//! systems cannot actually conflict. NOT ambiguous (condition 4).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Energy(pub u32);

#[derive(Component)]
pub struct Player;

pub fn player_energy(mut q: Query<&mut Energy, With<Player>>) { for mut e in &mut q { e.0 += 1; } }
pub fn other_energy(mut q: Query<&mut Energy, Without<Player>>) { for mut e in &mut q { e.0 += 1; } }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(Update, (player_energy, other_energy));
    app
}
