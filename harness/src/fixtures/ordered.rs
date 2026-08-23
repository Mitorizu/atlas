//! Same overlap as plain_conflict, but explicitly ordered. NOT ambiguous (condition 2).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Score(pub u32);

pub fn writes_score(mut q: Query<&mut Score>) { for mut s in &mut q { s.0 += 1; } }
pub fn reads_score(q: Query<&Score>) { for _s in &q {} }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(Update, (writes_score, reads_score.after(writes_score)));
    app
}
