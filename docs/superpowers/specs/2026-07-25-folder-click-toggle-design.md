# Folder Click Expand/Collapse

## Goal

Clicking a folder name selects and displays that folder's images while also
inverting its current expanded state, matching the adjacent toggle icon.

## Behavior

- Applies to the root folder and nested folders.
- The expanded state is captured before asynchronous folder loading starts.
- Clicking the toggle icon keeps its existing expand/collapse-only behavior.
- Selecting an image keeps its existing behavior of opening the containing
  folder.

## Implementation

Reuse `setFolderExpanded` in the existing folder click handlers. Pass the
folder name click's intended expanded state through the existing asynchronous
selection flow. Do not add dependencies or refactor unrelated explorer code.

## Verification

Add a small Node-based regression check that proves a folder click both selects
the folder and alternates its expanded state. Run the existing explorer check
as regression coverage.
