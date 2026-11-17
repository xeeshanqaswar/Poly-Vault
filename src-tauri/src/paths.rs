use std::path::{Component, Path, PathBuf};

/// Lexical equivalent of Node's `path.resolve` (absolute, `.`/`..` folded,
/// no symlink resolution) so stored keys stay identical across both builds.
pub fn resolve(p: impl AsRef<Path>) -> PathBuf {
    let input = p.as_ref();
    let absolute = if input.is_absolute() {
        input.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(input)
    };

    let mut out = PathBuf::new();
    for comp in absolute.components() {
        match comp {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(std::path::MAIN_SEPARATOR.to_string());
    }
    out
}

pub fn key(p: impl AsRef<Path>) -> String {
    resolve(p).to_string_lossy().to_string()
}

/// 32-bit rolling hash rendered in base 36, identical to `hashString` in
/// library.js (JS `charCodeAt` walks UTF-16 code units).
pub fn hash_string(value: &str) -> String {
    let mut hash: i32 = 0;
    for unit in value.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(unit as i32);
    }
    let mut number = hash as u32;
    if number == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while number > 0 {
        out.push(DIGITS[(number % 36) as usize]);
        number /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub fn within_library(target: impl AsRef<Path>, libraries: &[String]) -> bool {
    let resolved = resolve(target);
    libraries.iter().any(|root| resolved.starts_with(resolve(root)))
}

pub fn to_forward_slashes(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub fn rel_path(base: &Path, full: &Path) -> String {
    match full.strip_prefix(base) {
        Ok(rest) => to_forward_slashes(rest),
        Err(_) => to_forward_slashes(full),
    }
}

/// Case-insensitive ordering that approximates JS `localeCompare` for the
/// ASCII asset names this scanner meets in practice.
pub fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let la = a.to_lowercase();
    let lb = b.to_lowercase();
    la.cmp(&lb).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_dot_segments() {
        let p = resolve("assets/./3d/../2d");
        assert!(p.ends_with("assets/2d") || p.ends_with("assets\\2d"));
    }

    #[test]
    fn containment_is_component_wise() {
        let libs = vec![key("C:/Library")];
        assert!(within_library("C:/Library/Chair", &libs));
        assert!(!within_library("C:/Library2/Chair", &libs));
    }

    #[test]
    fn hashes_like_the_node_build() {
        assert_eq!(hash_string(""), "0");
        assert_eq!(hash_string("Chair"), "12qox1");
    }
}
