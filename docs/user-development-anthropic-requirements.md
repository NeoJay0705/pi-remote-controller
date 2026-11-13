# user-development-anthropic requirements

## Confirmed scope

User confirmed on 2026-11-13:

- Keep the two existing live-instance profiles unchanged.
- Add profile ID `user-development-anthropic` with display name `user-development — claude-sonnet-5-5 high`.
- Use provider `anthropic`, model `claude-sonnet-5-5`, thinking `high`.
- Inherit extensions, tools, and appendSystemPrompts from the existing `user-development` profile.
- Target `.test-artifacts/live-instance/local.json` (relative to the repository root) only; do not change application code or example defaults.
- Do not automatically restart the service. The running service may keep its previously loaded profiles until an independently authorized restart.

## Required outcome

After the service next loads the configuration, the existing Profile selectors can offer all three profiles, including the new Anthropic variant. Existing sessions and profile selections remain unchanged by this configuration edit.

## Dependency evidence

- `pi --offline --list-models claude-sonnet-5-5` lists an exact `anthropic / claude-sonnet-5-5` entry with thinking support.
- `pi --help` lists `high` as an accepted thinking level.
- Model listing is local capability evidence, not proof of provider authentication, remote inference availability, or extension/model compatibility.
