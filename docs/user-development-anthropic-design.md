# user-development-anthropic design

User approved this minimal design on 2026-11-13. Requirements: [user-development-anthropic-requirements.md](user-development-anthropic-requirements.md).

## Change

Append one profile to `.test-artifacts/live-instance/local.json` by copying the existing `user-development` profile and overriding only ID, name, provider, model, and thinking with the confirmed values. Preserve all existing fields and profiles. No code, example config, session, database, or service lifecycle changes.

The live-instance config is gitignored local deployment state; documentation is tracked separately. The service loads profiles at startup, so this edit alone does not update the running UI.

## Verification

1. Preserve pre-edit evidence in a unique temporary directory outside the repository.
2. Assert JSON validity, exactly one added profile, unchanged existing profiles and non-profile configuration, exact new identity/model settings, and inherited extensions/tools/prompts.
3. Run the existing compiled `dist/server/config.js` loader against the edited configuration, confirming all three profiles and resolved extension/prompt paths. This is read-only configuration validation, not server startup or inference. The loader may enumerate project directories and read picked-project metadata, but must not enumerate sessions, query databases, or call endpoints.
4. Main agent independently checks the actual edited file and validation evidence before acceptance.

No new performance, concurrency, or resilience mechanisms are needed for one additional static profile. Local model listing is capability evidence only; authentication, remote inference, browser behavior, and extension/model interaction are outside this task.
