//! a -> b -> c. a and c never overlap in time, so their access conflict is not ambiguous.
//! Requires TRANSITIVE closure of the ordering graph (condition 2).
use bevy_app::prelude::*;
use bevy_ecs::prelude::*;

#[derive(Component)]
pub struct Pos(pub u32);

pub fn first_pos(mut q: Query<&mut Pos>) { for mut p in &mut q { p.0 += 1; } }
pub fn middle_pos(q: Query<&Pos>) { for _p in &q {} }
pub fn last_pos(mut q: Query<&mut Pos>) { for mut p in &mut q { p.0 += 1; } }

pub fn build() -> App {
    let mut app = App::new();
    app.add_systems(Update, (first_pos, middle_pos.after(first_pos), last_pos.after(middle_pos)));
    app
}
