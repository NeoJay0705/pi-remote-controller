# nested-project-picker — Requirements (user-confirmed)

## Problem
Projects are discovered only as direct children of `projectDiscovery.root` (e.g. `~/repos`). Directories such as `repos/sub/repo1` are invisible, and there is no way to create a directory from the UI.

## Requirements
- **N1 Browse.** The Web UI offers a directory browser that starts at `projectDiscovery.root` and lists sub-directories one level at a time (on demand, not recursive). The owner may enter any sub-directory, whether or not it is a git repo.
- **N2 Select.** The owner may select any directory below the root (not the root itself), including container directories such as `repos/sub`, as a Project. The selected directory becomes the active Project; its sessions are listed and new sessions can be created with it as cwd. Session directory follows the existing rule `piSessionDirectory(sessionRoot, cwd)`.
- **N3 Create.** In the currently browsed directory the owner may enter a name and create one sub-directory, which is then selected as the Project. Name rules: non-empty, no `/`, `\`, NUL, not starting with `.`, at most 255 bytes. An existing entry is an error; nothing is overwritten. No `git init`.
- **N4 Boundary.** Browsing, creating and selecting never leave `projectDiscovery.root`. Symlinks are not followed or listed, hidden (`.x`) entries are not listed, non-directories are not listed.
- **N4a Eligible directories.** Hidden directories, names containing `\`, symlinks and non-directories are neither listed nor selectable. Existing directories whose Pi session-directory name (`piSessionDirectory` basename) would exceed 255 bytes (filesystem NAME_MAX; a Pi encoding limitation we keep) are rejected at select/create time with an error, before any filesystem change.
- **N5 Persistence.** Selected directories are remembered in the data directory and reappear in the Project list after a service restart, so their sessions remain reachable.
- **N6 Compatibility.** First-level directories under the root still appear automatically; static `projects` config, Project ids (cwd hash), existing APIs and behavior are unchanged.

## Out of scope
Recursive listing, git detection, deleting/renaming/removing directories or remembered projects, per-directory session counts.
