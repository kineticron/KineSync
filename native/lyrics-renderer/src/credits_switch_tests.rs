//! CPU scene/motion regression. No Android surface or device visual claims.
use crate::{
    ffi::{manual_frame_for_test, replace_track_scroll, resize_track_scroll},
    live::TrackPacket,
    motion::FollowScroll,
    scene::TrackScene,
    typography::{Fonts, Style},
};

pub(crate) fn track(style: Style, width: u32, height: u32, scale: f32) -> TrackScene {
    track_variant(style, width, height, scale, false)
}

fn track_variant(style: Style, width: u32, height: u32, scale: f32, long: bool) -> TrackScene {
    let packets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../test/credits-switch-track.json")).unwrap();
    let index = usize::from(style == Style::Amll);
    let packet = TrackPacket::parse(&serde_json::to_vec(&packets[index]).unwrap()).unwrap();
    let mut settings = packet.settings.clone().unwrap();
    settings.landscape = width > height;
    settings.font_scale = if settings.landscape { 0.9 } else { 1.0 };
    let credits = packet.credits.clone();
    let mut fonts = Fonts::default();
    fonts
        .register(
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"),
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"),
        )
        .unwrap();
    let mut lines = packet.into_lines();
    if long {
        let source = lines.clone();
        lines = (0..80)
            .map(|i| {
                let mut line = source[i % source.len()].clone();
                let shift = (i / source.len()) as f64 * 50_000.0;
                line.start += shift;
                line.end += shift;
                line.background_end += shift;
                for atom in &mut line.atoms {
                    atom.start += shift;
                    atom.end += shift;
                }
                for voice in line.paint.iter_mut().chain(line.backgrounds.iter_mut()) {
                    voice.start += shift;
                    voice.end += shift;
                    voice.translation = Some(
                        "A long translated lyric that wraps over several measured lines. "
                            .repeat(12),
                    );
                    for word in &mut voice.words {
                        word.start += shift;
                        word.end += shift;
                        if let Some(group) =
                            word.appearance.as_mut().and_then(|a| a.emphasis.as_mut())
                        {
                            group.start += shift;
                            group.end += shift;
                        }
                    }
                }
                line
            })
            .collect();
    }
    TrackScene::with_fonts_credits(
        lines,
        width,
        height,
        scale,
        Some(&settings),
        credits.as_ref(),
        &mut fonts,
    )
    .unwrap()
}

fn assert_footer(track: &TrackScene, scroll: f64, time: f64) {
    let footer = track.footer.as_ref().unwrap();
    let y = track.footer_y(footer, track.scroll_anchor(), scroll, 0.0);
    assert!(y >= 0.0 && y + footer.height <= f64::from(track.height));
    // Search actual footer hit rectangles, not guessed text positions or offsets.
    for target in [-2, -3, -4] {
        assert!(
            (0..track.height).any(|y| {
                (0..track.width)
                    .step_by(4)
                    .any(|x| track.footer_hit(f64::from(x), f64::from(y), scroll, time) == target)
            }),
            "footer target {target} must be on screen"
        );
    }
}

#[test]
fn credits_switch_preserves_manual_footer_and_fresh_follow_at_exact_fixture_end() {
    for (width, height, scale) in [
        (390, 640, 1.0),
        (560, 320, 1.0),
        (720, 1100, 2.0),
        (900, 1329, 1.5),
    ] {
        for time in [49_599.0, 49_600.0, 51_600.0] {
            for following in [true, false] {
                let mut spicy = track(Style::Spicy, width, height, scale);
                spicy.prepare(time).unwrap();
                let mut scroll = FollowScroll::default();
                scroll.configure(Style::Spicy, f64::from(scale), spicy.lines().len());
                let command = spicy.scroll_command(time, 0.0);
                scroll.sample(&command, 1000.0, true);
                if !following {
                    // Exact preceding maker tap: no drag, ownership becomes manual.
                    let before_tap = scroll.position();
                    scroll.set_manual_bounds(spicy.max_scroll(), f64::from(spicy.height));
                    for frame in 0..10 {
                        let after_tap =
                            scroll.sample(&command, 1016.0 + f64::from(frame) * 16.0, false);
                        assert_eq!(
                            after_tap, before_tap,
                            "a tap must leave the viewport in place"
                        );
                        assert!(
                            !scroll.animating(),
                            "a valid offset must not start a rebound"
                        );
                    }
                }
                if time >= 49_600.0 {
                    assert_footer(&spicy, scroll.position(), time);
                }
                let mut amll = track(Style::Amll, width, height, scale);
                replace_track_scroll(&mut scroll, Some(&spicy), &mut amll, true, following, time)
                    .unwrap();
                scroll.snap_next(); // JS sends snap=true for the new generation.
                amll.prepare(time).unwrap();
                assert_ne!(spicy.max_scroll(), amll.max_scroll());
                for frame in 0..=2100 {
                    if !following {
                        manual_frame_for_test(
                            &mut amll,
                            &mut scroll,
                            time,
                            1200.0 + f64::from(frame) * 1000.0 / 60.0,
                        );
                    }
                    let command = amll.scroll_command(time, scroll.position());
                    scroll.sample(
                        &command,
                        1200.0 + f64::from(frame) * 1000.0 / 60.0,
                        following,
                    );
                }
                if time >= 49_600.0 {
                    assert_footer(&amll, scroll.position(), time);
                }
                // Fresh AMLL at the same time is independent of prior style/history.
                let mut fresh = track(Style::Amll, width, height, scale);
                let mut fresh_scroll = FollowScroll::default();
                replace_track_scroll(&mut fresh_scroll, None, &mut fresh, false, true, time)
                    .unwrap();
                fresh.prepare(time).unwrap();
                let offset = fresh_scroll.sample(&fresh.scroll_command(time, 0.0), 1000.0, true);
                assert!((offset - fresh.scroll_target(time)).abs() < 1e-9);
                if time >= 49_600.0 {
                    assert_footer(&fresh, offset, time);
                }
            }
        }
    }
}

#[test]
fn credits_switch_keeps_user_row_and_clamps_without_restoring_follow_or_fling() {
    let time = 51_600.0;
    let mut old = track(Style::Spicy, 390, 640, 1.0);
    old.prepare(time).unwrap();
    old.prepare_viewport(0.0).unwrap();
    let mut scroll = FollowScroll::default();
    scroll.configure(Style::Spicy, 1.0, old.lines().len());
    scroll.sample(&old.scroll_command(time, 0.0), 0.0, true);
    let manual = old.row_top(2) + 0.25 * (old.row_top(3) - old.row_top(2));
    scroll.drag(manual - scroll.position(), old.max_scroll(), 640.0);
    scroll.fling(0.5, old.max_scroll(), 640.0);
    let mut next = track(Style::Amll, 390, 640, 1.0);
    replace_track_scroll(&mut scroll, Some(&old), &mut next, true, false, time).unwrap();
    let expected = next.row_top(2) + 0.25 * (next.row_top(3) - next.row_top(2));
    assert!((scroll.position() - expected).abs() < 1e-8);
    assert!(scroll.position() < next.scroll_target(time));
    let command = next.scroll_command(time, scroll.position());
    assert!((scroll.sample(&command, 35_000.0, false) - expected).abs() < 1e-8);
    assert!(!scroll.animating());
    // Explicit resume still follows, rather than remaining frozen forever.
    for frame in 0..600 {
        scroll.sample(&command, 35_000.0 + f64::from(frame) * 16.0, true);
    }
    assert_footer(&next, scroll.position(), time);
    // New track identities reset instead of inheriting a previous manual row.
    let mut fresh = track(Style::Amll, 390, 640, 1.0);
    replace_track_scroll(&mut scroll, Some(&next), &mut fresh, false, false, 0.0).unwrap();
    fresh.prepare(0.0).unwrap();
    assert_eq!(
        scroll.sample(&fresh.scroll_command(0.0, 0.0), 40_000.0, false),
        0.0
    );
    assert_eq!(
        scroll.sample(&fresh.scroll_command(0.0, 0.0), 40_016.0, true),
        fresh.scroll_target(0.0)
    );
    // Rubber-band offsets are clamped to the new scene's valid bounds.
    scroll.drag(-10_000.0, fresh.max_scroll(), 640.0);
    let mut replacement = track(Style::Spicy, 390, 640, 1.0);
    replace_track_scroll(
        &mut scroll,
        Some(&fresh),
        &mut replacement,
        true,
        false,
        0.0,
    )
    .unwrap();
    assert_eq!(scroll.position(), 0.0);
}

#[test]
fn credits_switch_keeps_logical_anchor_through_lazy_preparation_and_pending_seek() {
    let time = 399_600.0;
    for footer in [false, true] {
        let mut old = track_variant(Style::Spicy, 320, 600, 1.0, true);
        old.prepare(time).unwrap();
        old.prepare_viewport(old.row_top(40)).unwrap();
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 1.0, old.lines().len());
        scroll.sample(&old.scroll_command(time, 0.0), 0.0, true);
        let manual = if footer {
            old.max_scroll()
        } else {
            old.row_top(40) + 0.4 * (old.row_top(41) - old.row_top(40))
        };
        scroll.drag(manual - scroll.position(), old.max_scroll(), 600.0);
        scroll.sample(&old.scroll_command(time, manual), 16.0, false);
        scroll.snap_next(); // Explicit seek while manual, before packet replacement.
        let mut next = track_variant(Style::Amll, 320, 600, 1.0, true);
        replace_track_scroll(&mut scroll, Some(&old), &mut next, true, false, time).unwrap();
        assert!(scroll.explicit_snap_pending());
        let mut measured_shift = false;
        let mut previous = scroll.position();
        for pass in 0..6 {
            // The actual renderer prepares playback, then the manual viewport.
            let offset = manual_frame_for_test(
                &mut next,
                &mut scroll,
                time,
                1000.0 + f64::from(pass) * 16.0,
            );
            let expected = if footer {
                next.max_scroll()
            } else {
                next.row_top(40) + 0.4 * (next.row_top(41) - next.row_top(40))
            };
            assert!((scroll.position() - expected).abs() < 1e-7);
            assert!(
                scroll.explicit_snap_pending(),
                "manual frames cannot consume explicit seek snaps"
            );
            if footer {
                assert_footer(&next, offset, time);
            }
            // Measure previously estimated tall translated rows before the anchor.
            next.prepare_viewport(next.row_top(pass as usize)).unwrap();
            measured_shift |= (previous - scroll.position()).abs() > 1.0;
            previous = scroll.position();
        }
        assert!(
            measured_shift,
            "exercise prefix changes after initial replacement"
        );
        next.clear_manual_anchor(); // kr_set_following(true)
        let command = next.scroll_command(time, scroll.position());
        assert_eq!(scroll.sample(&command, 5000.0, true), command.offset);
        assert!(!scroll.explicit_snap_pending());
        assert_footer(&next, scroll.position(), time);
    }
}

#[test]
fn credits_switch_manual_frame_without_anchor_preserves_rubber_band_and_fling() {
    let mut scene = track(Style::Amll, 390, 640, 1.0);
    scene.prepare(3000.0).unwrap();
    let mut actual = FollowScroll::default();
    let mut control = FollowScroll::default();
    for scroll in [&mut actual, &mut control] {
        scroll.configure(Style::Amll, 1.0, scene.lines().len());
        scroll.sample(&scene.scroll_command(3000.0, 0.0), 0.0, true);
        scroll.drag(-200.0, scene.max_scroll(), 640.0);
    }
    assert!(actual.position() < 0.0);
    // Full render-order preparation must not clamp a user-owned rubber band.
    let got = manual_frame_for_test(&mut scene, &mut actual, 3000.0, 16.0);
    let expected = control.sample(
        &scene.scroll_command(3000.0, control.position()),
        16.0,
        false,
    );
    assert_eq!(got, expected);
    assert!(got < 0.0);
    for scroll in [&mut actual, &mut control] {
        scroll.drag(250.0, scene.max_scroll(), 640.0);
        scroll.fling(0.8, scene.max_scroll(), 640.0);
    }
    for frame in 0..100 {
        let now = 32.0 + f64::from(frame) * 16.0;
        let got = manual_frame_for_test(&mut scene, &mut actual, 3000.0, now);
        let expected = control.sample(
            &scene.scroll_command(3000.0, control.position()),
            now,
            false,
        );
        assert!((got - expected).abs() < 1e-9);
    }
}

#[test]
fn credits_switch_cached_resize_uses_current_manual_anchor_not_cached_ownership() {
    let time = 51_600.0;
    let mut a = track(Style::Amll, 390, 640, 1.0);
    let mut b = track(Style::Amll, 560, 320, 1.0);
    a.prepare(time).unwrap();
    let mut scroll = FollowScroll::default();
    scroll.configure(Style::Amll, 1.0, a.lines().len());
    scroll.sample(&a.scroll_command(time, 0.0), 0.0, true);
    // A receives a logical footer anchor through a same-track replacement.
    let mut spicy = track(Style::Spicy, 390, 640, 1.0);
    spicy.prepare(time).unwrap();
    replace_track_scroll(&mut scroll, Some(&spicy), &mut a, true, false, time).unwrap();
    resize_track_scroll(&mut scroll, &a, &mut b, false, time, 1.0).unwrap();
    // A is now cached with its old footer anchor. User scrolls elsewhere on B.
    assert!(a.has_manual_anchor());
    b.clear_manual_anchor();
    b.prepare_viewport(0.0).unwrap();
    let manual = b.row_top(2) + 0.3 * (b.row_top(3) - b.row_top(2));
    scroll.drag(manual - scroll.position(), b.max_scroll(), 320.0);
    resize_track_scroll(&mut scroll, &b, &mut a, false, time, 1.0).unwrap();
    for frame in 0..4 {
        manual_frame_for_test(&mut a, &mut scroll, time, 1000.0 + f64::from(frame) * 16.0);
        let expected = a.row_top(2) + 0.3 * (a.row_top(3) - a.row_top(2));
        assert!((scroll.position() - expected).abs() < 1e-7);
        assert!(scroll.position() < a.scroll_target(time));
    }
    // Following ownership must also clear cached manual anchors on resize.
    resize_track_scroll(&mut scroll, &a, &mut b, true, time, 1.0).unwrap();
    assert!(!b.has_manual_anchor());
}

#[test]
fn credits_switch_rejects_unrelated_rows_and_handles_empty_layouts() {
    let time = 51_600.0;
    let mut old = track(Style::Spicy, 390, 640, 1.0);
    old.prepare(time).unwrap();
    for revision in ["count", "order", "text", "empty"] {
        let mut scroll = FollowScroll::default();
        scroll.configure(Style::Spicy, 1.0, old.lines().len());
        scroll.sample(&old.scroll_command(time, 0.0), 0.0, true);
        let template = track(Style::Amll, 390, 640, 1.0);
        let mut lines = template.lines().to_vec();
        match revision {
            "count" => {
                lines.pop();
            }
            "order" => lines.swap(0, 1),
            "text" => lines[0].text = "An unrelated lyric revision".into(),
            _ => {}
        }
        let mut fonts = Fonts::default();
        fonts
            .register(
                include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"),
                include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf"),
            )
            .unwrap();
        let settings = crate::typography::Settings {
            style: Style::Amll,
            landscape: false,
            font_scale: 1.0,
        };
        let mut next =
            TrackScene::with_fonts(lines, 390, 640, 1.0, Some(&settings), &mut fonts).unwrap();
        replace_track_scroll(
            &mut scroll,
            if revision == "empty" {
                None
            } else {
                Some(&old)
            },
            &mut next,
            true,
            false,
            time,
        )
        .unwrap();
        assert_eq!(
            scroll.position(),
            0.0,
            "{revision} must not reuse an old row index"
        );
        let command = next.scroll_command(time, 0.0);
        assert_eq!(scroll.sample(&command, 35_000.0, false), 0.0);
    }
}
