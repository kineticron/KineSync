//! Android partitions and OEM font configuration complement Fontique's system scan.
use std::path::{Path, PathBuf};

/// Include configured files even when they live outside the standard directories.
/// Missing partitions, unreadable configs and invalid fonts are intentionally isolated.
pub(crate) fn font_paths(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in roots {
        let fonts = root.join("fonts");
        paths.push(fonts.clone());
        let Ok(entries) = std::fs::read_dir(root.join("etc")) else {
            continue;
        };
        let mut configs: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "xml")
                    && path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().contains("font"))
            })
            .collect();
        configs.sort();
        for config in configs {
            let Ok(xml) = std::fs::read_to_string(config) else {
                continue;
            };
            let Ok(doc) = roxmltree::Document::parse(&xml) else {
                continue;
            };
            for node in doc
                .descendants()
                .filter(|n| n.has_tag_name("font") || n.has_tag_name("file"))
            {
                let Some(name) = node.text().map(str::trim).filter(|s| !s.is_empty()) else {
                    continue;
                };
                let path = Path::new(name);
                if path.is_absolute() {
                    paths.push(path.to_owned());
                } else {
                    // Vendor configuration can refer to a system or product font.
                    paths.extend(roots.iter().map(|root| root.join("fonts").join(path)));
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// An explicit stack lets the shaper try every discovered family for each cluster,
/// including collection faces and scripts without Android postScriptName mappings.
pub(crate) fn family_stack(context: &mut parley::FontContext, primary: &str) -> String {
    let mut names: Vec<_> = context
        .collection
        .family_names()
        .map(str::to_owned)
        .collect();
    names.sort();
    names.dedup();
    let mut stack = primary.to_owned();
    for name in names {
        stack.push_str(", '");
        stack.push_str(&name.replace('\\', "\\\\").replace('\'', "\\'"));
        stack.push('\'');
    }
    stack
}

#[cfg(target_os = "android")]
pub(crate) fn load(context: &mut parley::FontContext) {
    let mut roots: Vec<_> = [
        "/system",
        "/system_ext",
        "/vendor",
        "/product",
        "/odm",
        "/data",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    for variable in [
        "ANDROID_ROOT",
        "ANDROID_VENDOR_ROOT",
        "ANDROID_PRODUCT_ROOT",
        "ANDROID_SYSTEM_EXT_ROOT",
    ] {
        if let Some(root) = std::env::var_os(variable) {
            roots.push(root.into());
        }
    }
    let mut paths = font_paths(&roots);
    paths.push(PathBuf::from("/data/fonts/files"));
    // Fontique scans metadata and keeps file sources. TTC faces retain their indexes.
    // A configured file is often also inside a scanned directory. Canonicalize
    // aliases and avoid registering the same collection through both paths.
    let mut paths: Vec<_> = paths
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect();
    paths.sort();
    paths.dedup();
    let directories: Vec<_> = paths.iter().filter(|path| path.is_dir()).cloned().collect();
    paths.retain(|path| {
        !directories
            .iter()
            .any(|directory| path != directory && path.starts_with(directory))
    });
    context.collection.load_fonts_from_paths(paths);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn collection_faces_are_discovered_with_their_indexes() {
        let mut ttc = b"ttcf\x00\x01\x00\x00\x00\x00\x00\x02".to_vec();
        ttc.resize(20, 0);
        for (index, bytes) in [
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf")
                .as_slice(),
            include_bytes!("../../../ExpoLyrics/assets/fonts/SF-Pro-Display-Bold.otf").as_slice(),
        ]
        .into_iter()
        .enumerate()
        {
            while !ttc.len().is_multiple_of(4) {
                ttc.push(0);
            }
            let base = ttc.len() as u32;
            ttc[12 + index * 4..16 + index * 4].copy_from_slice(&base.to_be_bytes());
            let mut face = bytes.to_vec();
            let tables = u16::from_be_bytes([face[4], face[5]]) as usize;
            for table in 0..tables {
                let start = 12 + table * 16 + 8;
                let offset = u32::from_be_bytes(face[start..start + 4].try_into().unwrap());
                face[start..start + 4].copy_from_slice(&(offset + base).to_be_bytes());
            }
            ttc.extend(face);
        }
        let mut context = parley::FontContext::new();
        context.collection =
            parley::fontique::Collection::new(parley::fontique::CollectionOptions {
                system_fonts: false,
                ..Default::default()
            });
        let families = context.collection.register_fonts(ttc.into(), None);
        let mut indexes: Vec<_> = families
            .iter()
            .flat_map(|(_, fonts)| fonts.iter().map(|font| font.index()))
            .collect();
        indexes.sort();
        assert_eq!(indexes, [0, 1]);
        let stack = family_stack(&mut context, "'Missing primary'");
        assert!(stack.starts_with("'Missing primary', "));
        assert!(stack.contains("'SF Pro Display'"));
        let mut layouts = parley::LayoutContext::new();
        let layout = crate::scene::shape(
            "available Latin",
            &mut context,
            &mut layouts,
            32.0,
            40.0,
            400.0,
            &stack,
            &[],
            0.0,
        );
        assert!(
            layout
                .lines()
                .flat_map(|line| line.runs())
                .flat_map(|run| run.visual_clusters())
                .flat_map(|cluster| cluster.glyphs())
                .all(|glyph| glyph.id != 0)
        );
    }
    #[test]
    fn discovers_partition_configs_and_survives_partial_failure() {
        let root = std::env::temp_dir().join(format!("kinesync-fonts-{}", std::process::id()));
        let system = root.join("system");
        let vendor = root.join("vendor");
        std::fs::create_dir_all(system.join("etc")).unwrap();
        std::fs::create_dir_all(vendor.join("etc")).unwrap();
        std::fs::create_dir_all(vendor.join("fonts")).unwrap();
        std::fs::write(
            system.join("etc/fonts.xml"),
            "<familyset><family lang='ja'><font index='1'>shared.ttc</font></family></familyset>",
        )
        .unwrap();
        std::fs::write(vendor.join("etc/fonts_customization.xml"), "<fonts-modification><family><font>/custom/fallback.otf</font></family></fonts-modification>").unwrap();
        std::fs::write(vendor.join("etc/fallback_fonts.xml"), "broken xml").unwrap();
        std::fs::write(vendor.join("fonts/broken.ttf"), b"invalid").unwrap();
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../ExpoLyrics/assets/fonts/SF-Pro-Display-Regular.otf"
            ),
            vendor.join("fonts/available.otf"),
        )
        .unwrap();
        let paths = font_paths(&[system.clone(), vendor.clone(), root.join("missing")]);
        assert!(paths.contains(&vendor.join("fonts/shared.ttc")));
        assert!(paths.contains(&PathBuf::from("/custom/fallback.otf")));
        let mut context = parley::FontContext::new();
        context.collection =
            parley::fontique::Collection::new(parley::fontique::CollectionOptions {
                system_fonts: false,
                ..Default::default()
            });
        context.collection.load_fonts_from_paths(paths);
        assert!(family_stack(&mut context, "sans-serif").contains("'SF Pro Display'"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
