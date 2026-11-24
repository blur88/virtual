# Project Settings & Active Project Registry

## Status
accepted

## Context
The AI Office coordinates engineering workflows across multiple Target Projects located in separate folders on the same server. We need a lightweight, persistent way to track known repositories, allow adding, editing, and removing project entries, and maintain one designated Active Project without requiring a database, git worktrees, or duplicate repositories.

## Decision
We record project configuration in a local JSON registry at `/home/blur/virtual/.office/projects.json`.
1. **Schema**:
   ```json
   {
     "activeProjectId": "proj-1",
     "projects": [
       {
         "id": "proj-1",
         "name": "My Project",
         "path": "/home/blur/my-project",
         "addedAt": "2026-11-25T00:00:00Z",
         "updatedAt": "2026-11-25T00:00:00Z"
       }
     ]
   }
   ```
2. **Access & Permissions**:
   - Modified exclusively by the human user through the Web UI Project Settings or manual configuration.
   - Riley and all future AI Office agents have strictly read-only access to this file.
3. **Full Project Management (CRUD)**:
   - **Add**: Validates directory exists and is a valid Git repository root (`git -C <path> rev-parse --show-toplevel`). Prevents duplicate paths.
   - **Edit**: Allows updating display name or path (re-validating Git existence and path uniqueness).
   - **Select Active**: Updates `activeProjectId`. Only one project is active at a time.
   - **Remove**: Deletes project metadata from `.office/projects.json` without modifying or deleting the underlying repository on disk.
4. **Dynamic Git State**:
   - Current Git branch is read dynamically on request (`git -C <path> branch --show-current`) rather than stored as stale state.
5. **Consumption**:
   - Riley re-reads `.office/projects.json` before each workflow recommendation to formulate accurate context and copy-paste transition commands.

## Consequences
- Zero-dependency configuration that survives application restarts, session compaction, and container rebuilds.
- Clear separation of concerns: users manage projects; agents consume the active selection in read-only mode.
- Complete CRUD capabilities for project metadata with zero risk of accidental repository deletion.
