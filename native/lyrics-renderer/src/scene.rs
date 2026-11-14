//! Shape whole lines once. Frames reuse encoded white glyph scenes and byte-range clips.
use crate::{Line, focus, progress};
use parley::{
    Alignment, AlignmentOptions, FontContext, FontFamily, FontWeight, LayoutContext, LineHeight,
    PositionedLayoutItem, StyleProperty,
};
use vello::{
    Glyph, Scene,
    kurbo::{Affine, Rect},
    peniko::{BlendMode, Color, Fill},
};

type Error = Box<dyn std::error::Error>;

struct CachedLine {
    white: Scene,
    height: f64,
    /// One or more visual fragments for each timed atom, including wrapped syllables.
    atoms: Vec<Vec<Rect>>,
}

pub struct TrackScene {
    pub lines: Vec<Line>,
    cached: Vec<CachedLine>,
    pub width: u32,
    pub height: u32,
    pub font_size: f64,
    pub glyph_count: usize,
    pub missing_glyphs: usize,
}

impl TrackScene {
    pub fn new(width: u32, height: u32) -> Result<Self, Error> {
        Self::from_lines(crate::fixture()?, width, height, 1.0)
    }

    pub fn from_lines(
        lines: Vec<Line>,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, Error> {
        if lines.is_empty()
            || width == 0
            || height == 0
            || !scale.is_finite()
            || scale <= 0.0
            || scale > 4.0
        {
            return Err("Invalid layout size, scale or empty lyrics".into());
        }
        let mut fonts = FontContext::new();
        let mut layouts = LayoutContext::<()>::new();
        let font_size = 34.0 * scale;
        let lane = if width < height {
            (width as f32 - 64.0 * scale).max(font_size)
        } else {
            width as f32 * 0.67
        };
        let mut cached = Vec::new();
        let mut glyph_count = 0;
        let mut missing_glyphs = 0;
        for line in &lines {
            let mut builder = layouts.ranged_builder(&mut fonts, &line.text, 1.0, true);
            builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
                if cfg!(target_vendor = "apple") {
                    "sans-serif"
                } else {
                    "Noto Sans CJK KR"
                }
                .into(),
            )));
            builder.push_default(StyleProperty::FontSize(font_size));
            builder.push_default(StyleProperty::FontWeight(FontWeight::new(800.0)));
            builder.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
                1.35,
            )));
            let mut layout = builder.build(&line.text);
            layout.break_all_lines(Some(lane));
            layout.align(Alignment::Start, AlignmentOptions::default());
            let mut white = Scene::new();
            let mut atoms = vec![Vec::new(); line.atoms.len()];
            for row in layout.lines() {
                for item in row.items() {
                    if let PositionedLayoutItem::GlyphRun(gr) = item {
                        let run = gr.run();
                        let glyphs: Vec<Glyph> = gr
                            .positioned_glyphs()
                            .map(|g| {
                                glyph_count += 1;
                                missing_glyphs += usize::from(g.id == 0);
                                Glyph {
                                    id: g.id,
                                    x: g.x,
                                    y: g.y,
                                }
                            })
                            .collect();
                        white
                            .draw_glyphs(run.font())
                            .font_size(run.font_size())
                            .normalized_coords(
                                &run.normalized_coords()
                                    .iter()
                                    .map(|c| c.to_bits())
                                    .collect::<Vec<_>>(),
                            )
                            .brush(Color::WHITE)
                            .draw(Fill::NonZero, glyphs.into_iter());
                    }
                }
                let metrics = row.metrics();
                let mut x = metrics.offset as f64;
                for run in row.runs() {
                    for cluster in run.visual_clusters() {
                        let advance = cluster.advance() as f64;
                        let range = cluster.text_range();
                        for (i, atom) in line.atoms.iter().enumerate() {
                            if range.start < atom.bytes.end && range.end > atom.bytes.start {
                                let rect = Rect::new(
                                    x,
                                    metrics.block_min_coord as f64,
                                    x + advance,
                                    metrics.block_max_coord as f64,
                                );
                                // Union touching fragments within the same visual row.
                                if let Some(last) = atoms[i].last_mut().filter(|r: &&mut Rect| {
                                    (r.y0 - rect.y0).abs() < 0.1 && (r.x1 - rect.x0).abs() < 0.1
                                }) {
                                    *last = last.union(rect);
                                } else {
                                    atoms[i].push(rect);
                                }
                            }
                        }
                        x += advance;
                    }
                }
            }
            cached.push(CachedLine {
                white,
                height: layout.height() as f64,
                atoms,
            });
        }
        if missing_glyphs > 0 {
            return Err(
                format!("{missing_glyphs} missing glyphs (tofu); install Noto Sans CJK").into(),
            );
        }
        Ok(Self {
            lines,
            cached,
            width,
            height,
            font_size: font_size as f64,
            glyph_count,
            missing_glyphs,
        })
    }

    /// Returns protected band in output pixels, including the entire next line.
    pub fn frame(&self, time: f64, scene: &mut Scene) -> (f32, f32) {
        scene.reset();
        let active = focus(&self.lines, time);
        let scale = self.font_size / 34.0;
        let margin = if self.width < self.height {
            32.0 * scale
        } else {
            self.width as f64 * 0.165
        };
        let anchor = self.height as f64 * 0.37;
        let gap = self.font_size * 0.7;
        let mut positions = vec![0.0; self.lines.len()];
        positions[active] = anchor;
        for i in (0..active).rev() {
            positions[i] = positions[i + 1] - self.cached[i].height - gap;
        }
        for i in active + 1..positions.len() {
            positions[i] = positions[i - 1] + self.cached[i - 1].height + gap;
        }
        for (i, cached) in self.cached.iter().enumerate() {
            let y = positions[i];
            if y + cached.height < -40.0 || y > self.height as f64 + 40.0 {
                continue;
            }
            let transform = Affine::translate((margin, y));
            let bounds = Rect::new(-8.0, -8.0, self.width as f64, cached.height + 8.0);
            let singing = time >= self.lines[i].start && time < self.lines[i].end;
            let opacity = if i == active || singing {
                0.4
            } else if i == active + 1 {
                0.5
            } else {
                0.38
            };
            scene.push_layer(
                Fill::NonZero,
                BlendMode::default(),
                opacity,
                transform,
                &bounds,
            );
            scene.append(&cached.white, Some(transform));
            scene.pop_layer();
            if i == active || singing {
                for (atom, fragments) in self.lines[i].atoms.iter().zip(&cached.atoms) {
                    let mut remaining = fragments.iter().map(|r| r.width()).sum::<f64>()
                        * progress(time, atom.start, atom.end);
                    for rect in fragments {
                        let fill = remaining.clamp(0.0, rect.width());
                        remaining -= rect.width();
                        if fill <= 0.0 {
                            continue;
                        }
                        let clip = Rect::new(rect.x0, rect.y0, rect.x0 + fill, rect.y1);
                        scene.push_clip_layer(Fill::NonZero, transform, &clip);
                        scene.append(&cached.white, Some(transform));
                        scene.pop_layer();
                    }
                }
            }
        }
        let first = self
            .lines
            .iter()
            .position(|line| time >= line.start && time < line.end)
            .unwrap_or(active);
        let last = self
            .lines
            .iter()
            .rposition(|line| time >= line.start && time < line.end)
            .unwrap_or(active);
        let next = (last.max(active) + 1).min(self.lines.len() - 1);
        (
            (positions[first.min(active)] - 10.0 * scale) as f32,
            (positions[next] + self.cached[next].height + 10.0 * scale) as f32,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_live_leads_keep_both_in_protected_band() {
        let track = TrackScene::new(390, 844).unwrap();
        let mut scene = Scene::new();
        let overlapping = track.frame(88_200.0, &mut scene);
        let after = track.frame(88_500.0, &mut scene);
        assert!(overlapping.0 < 844.0 * 0.37 - 40.0);
        assert!((after.0 - (844.0 * 0.37 - 10.0)).abs() < 0.1);
    }
}
