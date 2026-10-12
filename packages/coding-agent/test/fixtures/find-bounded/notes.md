# Retention notes

Artifacts are written once and never rewritten in place.

The spill threshold is a setting, not a constant: it is read from
`tools.artifactSpillThreshold` and multiplied by 1024 before comparison.

Blobs are content-addressed by SHA-256 and live outside the session directory.
