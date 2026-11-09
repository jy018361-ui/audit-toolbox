//! The package version selects a channel for both the GUI and worker processes.
pub fn is_dev_version(version: &str) -> bool {
    version.split_once('-').is_some_and(|(_, suffix)| suffix.starts_with("dev."))
}

pub fn is_dev() -> bool {
    is_dev_version(env!("CARGO_PKG_VERSION"))
}

pub fn application_name() -> &'static str {
    if is_dev() { "AuditToolboxDev" } else { "AuditToolbox" }
}

pub fn credential_service() -> &'static str {
    application_name()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_alpha_versions_stay_on_the_production_channel() {
        assert!(!is_dev_version("2.0.0-alpha.131"));
        assert!(!is_dev_version("2.0.0"));
        assert!(is_dev_version("2.0.0-dev.1"));
        assert!(is_dev_version("2.1.0-dev.25"));
    }

    #[test]
    fn storage_and_credentials_use_the_build_channel() {
        let expected = if env!("CARGO_PKG_VERSION").contains("-dev.") {
            "AuditToolboxDev"
        } else {
            "AuditToolbox"
        };
        assert_eq!(application_name(), expected);
        assert_eq!(credential_service(), expected);
    }
}
