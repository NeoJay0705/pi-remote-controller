# user-development-anthropic tasks

## 1. Configuration addition and offline evidence

Delegate to `system-execution-agent`, working directory set to the repository root.

- Snapshot the original live-instance configuration in a unique temporary directory outside the repository.
- Append the confirmed Anthropic user-development variant with a targeted edit.
- Compare against the snapshot and validate the edited file through the existing compiled configuration loader.
- Return changed path, exact commands/results, and temporary snapshot/validation artifact paths.

Acceptance: only the approved profile is added; original settings remain identical; exact values and inherited fields match; actual configuration loader accepts three profiles. No restart, session scan, database query, endpoint request, model call, or unrelated change.

## 2. Main-agent acceptance

Independently inspect the actual configuration, compare it with the saved original, and verify loader results. If checks fail, reject the result and request only the necessary correction. Record outcome and limitations in the verification document.
