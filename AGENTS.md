# Stereovisor Agent Workflow

## Scope

Stereovisor is a local-first Electron application for turning a still image into an editable layered 2.5D scene. Keep AI inference local, preserve the existing renderer/service boundary, and make changes inside this repository unless the user explicitly expands the scope.

## Before Editing

1. Inspect the relevant owner path end to end: UI state, API request, service job, model runner, and rendered result.
2. Read the nearby tests and project documentation before changing behavior.
3. State the working assumptions and a short implementation plan in commentary when the task is more than a trivial edit.
4. Search for existing settings, translations, controls, and lifecycle conventions before adding new ones.

## Dirty Worktree Preference

A dirty workspace is not by itself a reason to stop. It may contain user changes or work from another agent. Stay focused on the requested job and preserve unrelated progress.

- Inspect `git status` and the diff for files relevant to the task.
- Treat unrelated modified files as owned by someone else; do not reset, checkout, stash, delete, or rewrite them.
- If a relevant file is already modified, understand the existing change and integrate surgically instead of replacing it.
- Use narrow patches and avoid broad formatting or generated-file churn.
- Ask the user only when an actual overlapping conflict prevents a safe implementation or the requested behavior is ambiguous in a way that changes the design.

## Implementation Rules

- Prefer the smallest change that satisfies the request; do not refactor adjacent code without a direct reason.
- Preserve existing API compatibility where practical, especially positional function arguments used by tests or scripts.
- Keep persisted settings centralized and sanitized at the boundary. New user-facing text belongs in the localization source and generated locale output.
- Keep local AI work cancellable and report progress through the existing job mechanism.
- Use `apply_patch` for source edits. Keep source files ASCII unless existing content requires otherwise.
- Do not commit, amend, or alter unrelated history unless explicitly requested.

## Verification

Define a concrete success check for each behavior change, then run the narrowest useful verification loop:

1. Add or update a focused test for the changed behavior.
2. Run `npm test -- --run` for renderer behavior.
3. Run `npm run typecheck` and `npm run i18n:check` when TypeScript, settings, or translations are involved.
4. Run `npm run test:service` for service, pipeline, model, or API changes.
5. Run `npm run build` before handing off a user-visible application change.
6. Run `npm run package` for Electron packaging changes and smoke-test the generated `release/win-unpacked/Stereovisor.exe` before handing off an executable.
7. Report exactly which checks passed, which were not run, and any remaining risk.

## Communication

Keep progress updates concise and actionable. Lead the final response with the user-visible outcome, then list the important files and verification results. Do not claim a clean worktree when unrelated changes remain.
