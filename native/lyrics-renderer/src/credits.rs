//! Skia footer credits (`native-lyrics-view.tsx` footer): songwriter and
//! attribution lines shaped once per layout, below the last lyric row.
use crate::{
    live::Credits,
    typography::{Fonts, Settings},
};
use parley::{
    Alignment, AlignmentOptions, FontFamily, FontWeight, LayoutContext, LineHeight,
    PositionedLayoutItem, StyleProperty,
};
use vello::{
    Glyph, Scene,
    kurbo::{Affine, Rect},
    peniko::{BlendMode, Color, Fill},
};

/// Skia `styles.footer` / `styles.credits` in logical points.
const MARGIN_TOP: f64 = 18.0;
const PADDING_TOP: f64 = 18.0;
const PADDING_BOTTOM: f64 = 32.0;
const PADDING_HORIZONTAL: f64 = 28.0;
const WIDTH: f64 = 0.88;
const FONT_SIZE: f64 = 13.0;
const LINE_HEIGHT: f64 = 18.0;
/// Skia `.credits` colour: `rgba(255,255,255,0.56)`.
pub(crate) const ALPHA: f64 = 0.56;

pub(crate) struct Footer {
    scene: Scene,
    /// Footer text top below the final row bottom (margin plus padding).
    pub(crate) inset: f64,
    /// Footer block bottom below the final row bottom. Row heights change as
    /// lazy layout measures them, so absolute tops are derived at use.
    pub(crate) tail: f64,
    pub(crate) height: f64,
    x: f64,
    width: f64,
    profiles: Vec<(Rect, i32)>,
}

/// Visible credit lines in Skia order, plus the byte length of the bold
/// label (`styles.strong`, weight 800). Empty when there is nothing to show.
fn lines(credits: &Credits) -> Vec<(String, usize)> {
    let mut result = Vec::new();
    if !credits.songwriters.is_empty() {
        let label = "Written By: ";
        result.push((
            format!("{label}{}", credits.songwriters.join(", ")),
            label.len(),
        ));
    }
    let Some(attribution) = &credits.attribution else {
        return result;
    };
    if let Some(provider) = attribution.provider.as_deref().filter(|v| !v.is_empty()) {
        let label = "Provided By: ";
        result.push((format!("{label}{provider}"), label.len()));
    }
    if attribution.community {
        result.push((
            "These lyrics have been provided by the Spicy Lyrics community".into(),
            0,
        ));
    }
    if let Some(maker) = attribution.maker.as_deref().filter(|v| !v.is_empty()) {
        let label = "Made By: ";
        result.push((format!("{label}@{maker}"), label.len()));
    }
    if let Some(uploader) = attribution.uploader.as_deref().filter(|v| !v.is_empty()) {
        let label = "Uploaded By: ";
        result.push((format!("{label}@{uploader}"), label.len()));
    }
    result
}

/// Build the footer (placed relative to the final row at draw). `top` is the content bottom; the
/// returned scene excludes the container margins and alpha (applied at draw).
pub(crate) fn build(
    credits: &Credits,
    settings: &Settings,
    width: u32,
    scale: f32,
    fonts: &mut Fonts,
) -> Option<Footer> {
    let rows = lines(credits);
    if rows.is_empty() || !fonts.ready || width == 0 {
        return None;
    }
    let dpr = f64::from(scale);
    let block_width = (f64::from(width) * WIDTH - 2.0 * PADDING_HORIZONTAL * dpr).max(1.0);
    let block_left = if settings.landscape {
        f64::from(width) * (1.0 - WIDTH)
    } else {
        0.0
    };
    let x = block_left + PADDING_HORIZONTAL * dpr;
    let size = FONT_SIZE * dpr;
    let leading = LINE_HEIGHT * dpr;
    let mut layouts = LayoutContext::<()>::new();
    let mut scene = Scene::new();
    let mut cursor = 0.0;
    let mut profiles = Vec::new();
    for (text, bold) in rows {
        let mut builder = layouts.ranged_builder(&mut fonts.context, &text, 1.0, true);
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            "'SF Pro Display', sans-serif".into(),
        )));
        builder.push_default(StyleProperty::FontSize(size as f32));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(600.0)));
        builder.push_default(StyleProperty::LineHeight(LineHeight::Absolute(
            leading as f32,
        )));
        if bold > 0 {
            builder.push(StyleProperty::FontWeight(FontWeight::new(800.0)), 0..bold);
        }
        let mut layout = builder.build(&text);
        layout.break_all_lines(Some(block_width as f32));
        layout.align(
            if settings.landscape {
                Alignment::End
            } else {
                Alignment::Start
            },
            AlignmentOptions::default(),
        );
        for line in layout.lines() {
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(gr) = item {
                    let run = gr.run();
                    let glyphs: Vec<Glyph> = gr
                        .positioned_glyphs()
                        .map(|g| Glyph {
                            id: g.id,
                            x: g.x,
                            y: g.y,
                        })
                        .collect();
                    scene
                        .draw_glyphs(run.font())
                        .font_size(run.font_size())
                        .normalized_coords(
                            &run.normalized_coords()
                                .iter()
                                .map(|c| c.to_bits())
                                .collect::<Vec<_>>(),
                        )
                        .transform(Affine::translate((0.0, cursor)))
                        .brush(Color::WHITE)
                        .draw(Fill::NonZero, glyphs.into_iter());
                }
            }
        }
        let profile = if text.starts_with("Made By: ") {
            -3
        } else if text.starts_with("Uploaded By: ") {
            -4
        } else {
            0
        };
        if profile != 0 {
            profiles.push((
                Rect::new(
                    0.0,
                    cursor,
                    block_width,
                    cursor + f64::from(layout.height()),
                ),
                profile,
            ));
        }
        cursor += f64::from(layout.height());
    }
    let inset = MARGIN_TOP * dpr + PADDING_TOP * dpr;
    Some(Footer {
        scene,
        inset,
        tail: inset + cursor + PADDING_BOTTOM * dpr,
        height: cursor,
        x,
        width: block_width,
        profiles,
    })
}

impl Footer {
    pub(crate) fn hit_test(&self, x: f64, local_y: f64, scale: f64) -> i32 {
        let point = vello::kurbo::Point::new(x - self.x, local_y);
        if let Some((_, target)) = self.profiles.iter().find(|(rect, _)| rect.contains(point)) {
            return *target;
        }
        if Rect::new(
            -PADDING_HORIZONTAL * scale,
            -PADDING_TOP * scale,
            self.width + PADDING_HORIZONTAL * scale,
            self.height + PADDING_BOTTOM * scale,
        )
        .contains(point)
        {
            -2
        } else {
            -1
        }
    }

    /// Draw ordinary RGBA at `y` (surface px). Returns visible text bounds.
    pub(crate) fn draw(
        &self,
        scene: &mut Scene,
        y: f64,
        _width: u32,
        screen_height: f64,
        scale: f64,
    ) -> Option<(f64, f64)> {
        if y + self.height < -40.0 || y > screen_height + 40.0 {
            return None;
        }
        let transform = Affine::translate((self.x, y));
        let bounds = Rect::new(-64.0, -64.0, self.width + 128.0, self.height + 128.0);
        scene.push_layer(
            Fill::NonZero,
            BlendMode::default(),
            ALPHA as f32,
            transform,
            &bounds,
        );
        scene.append(&self.scene, Some(transform));
        scene.pop_layer();
        Some((y - 10.0 * scale, y + self.height + 10.0 * scale))
    }
}

/// Validation bounds shared with `TrackPacket::parse`.
pub(crate) fn valid(credits: &Credits) -> bool {
    let text = |value: &str| value.len() <= 2000;
    credits.songwriters.len() <= 64
        && credits
            .songwriters
            .iter()
            .all(|writer| text(writer) && !writer.contains('\0'))
        && credits.attribution.as_ref().is_none_or(|a| {
            a.provider
                .as_deref()
                .is_none_or(|v| text(v) && !v.contains('\0'))
                && a.maker
                    .as_deref()
                    .is_none_or(|v| text(v) && !v.contains('\0'))
                && a.maker_url
                    .as_deref()
                    .is_none_or(|v| text(v) && !v.contains('\0'))
                && a.uploader_url
                    .as_deref()
                    .is_none_or(|v| text(v) && !v.contains('\0'))
                && a.uploader
                    .as_deref()
                    .is_none_or(|v| text(v) && !v.contains('\0'))
        })
}

/// Static Skia empty branch, shaped without a timed row or playback anchor.
pub(crate) fn empty_scene(
    empty: &crate::live::EmptyState,
    width: u32,
    height: u32,
    scale: f32,
    fonts: &mut Fonts,
) -> Scene {
    let dpr = f64::from(scale);
    let mut context = LayoutContext::<()>::new();
    let mut paragraphs = Vec::new();
    let mut total = 0.0;
    for (text, size, weight, alpha) in [
        (&empty.title, 22.0, 700.0, 1.0),
        (&empty.subtitle, 13.0, 600.0, ALPHA),
    ] {
        let mut builder = context.ranged_builder(&mut fonts.context, text, 1.0, true);
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(
            "'SF Pro Display', sans-serif".into(),
        )));
        builder.push_default(StyleProperty::FontSize((size * dpr) as f32));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(weight)));
        if size == 13.0 {
            builder.push_default(StyleProperty::LineHeight(LineHeight::Absolute(
                (18.0 * dpr) as f32,
            )));
        }
        let mut layout = builder.build(text);
        layout.break_all_lines(Some((f64::from(width) - 56.0 * dpr).max(1.0) as f32));
        layout.align(Alignment::Center, AlignmentOptions::default());
        total += f64::from(layout.height());
        paragraphs.push((layout, alpha));
    }
    let mut scene = Scene::new();
    let mut y = (f64::from(height) - total) / 2.0;
    for (layout, alpha) in paragraphs {
        for line in layout.lines() {
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(gr) = item {
                    let run = gr.run();
                    scene
                        .draw_glyphs(run.font())
                        .font_size(run.font_size())
                        .normalized_coords(
                            &run.normalized_coords()
                                .iter()
                                .map(|c| c.to_bits())
                                .collect::<Vec<_>>(),
                        )
                        .transform(Affine::translate((28.0 * dpr, y)))
                        .brush(Color::new([1.0, 1.0, 1.0, alpha as f32]))
                        .draw(
                            Fill::NonZero,
                            gr.positioned_glyphs().map(|g| Glyph {
                                id: g.id,
                                x: g.x,
                                y: g.y,
                            }),
                        );
                }
            }
        }
        y += f64::from(layout.height());
    }
    scene
}
