---
globs:
  - ".mise.toml"
  - ".tool-versions"
---

# Tool Version Management

- Tools managed in `.mise.toml` and `.tool-versions` must specify the full patch version (e.g., `3.9.0`)
- Using `latest` or major-only versions (e.g., `3`) is prohibited due to supply chain attack risks
- When updating versions, verify functionality before committing the specific version number
