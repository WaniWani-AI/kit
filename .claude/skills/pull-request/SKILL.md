---
name: pull-request
description: Ensure a Linear ticket exists, then create and push a GitHub pull request for the latest commit — assigned to the author and linked so Linear auto-closes it. Use when the user runs /pull-request or asks to open a PR, create a pull request, push their branch as a PR, or "PR this".
---

# Create a Pull Request

Create a GitHub pull request immediately using the following rules:

## Step 1: Ensure a Linear ticket exists (do this BEFORE pushing)

1. Check whether a Linear ticket is already associated with this work. Look for a ticket identifier (e.g. `WAN-123`) in the current branch name and in the latest commit message(s).
2. If a ticket identifier is found, reuse it - no need to create a new one.
3. If NO ticket is found, create one with the Linear MCP:
   - Do NOT hardcode an email. The Linear MCP is authenticated as the person running this skill, so assign the issue with `assignee: "me"` - this is the reliable team-safe way to assign to the current user. (Git/GitHub email may differ from the Linear email, so matching by email is unreliable; only fall back to `list_users` matching if `"me"` is unavailable.) Use `list_teams` to resolve the team.
   - Create the issue with a concise title derived from the latest commit message, assigned to `"me"`.
   - Set its state to "In Progress".
   - Capture the returned ticket identifier (e.g. `WAN-123`) and its URL.
   - Verify the assignment took effect (the created issue's `assignee` should be the current user); if it didn't, retry the assignment explicitly with `save_issue`.

## Step 2: Create the PR

4. Push any uncommitted changes first if needed. If there are uncommitted changes, commit them first before creating the PR.
5. Ensure we're on the correct branch (not main/master).
6. Create the PR with `PR_SKILL=1 gh pr create --assignee @me`. The `PR_SKILL=1` prefix is required: a repo hook blocks any `gh pr create` without it, precisely so that PRs are only ever created through this skill.
7. Use the latest commit message as the PR title.
8. Write the PR body following [.github/PULL_REQUEST_TEMPLATE.md](../../../.github/PULL_REQUEST_TEMPLATE.md):
   - **`Closes WAN-123` line** (real identifier) if the ticket is not already in the branch name — this is what makes Linear link and auto-close the ticket. Include it even when the branch name has the ticket if in doubt; it is harmless.
   - **`## Summary`** — what the PR does, in plain words. Link the plan issue if the work has one.
   - **`## How to see it working`** — mandatory, never empty. What the running product does after this merges that it didn't do before: a screenshot, a request to run, or the production path that behaves differently. If the honest answer is "merging changes nothing", STOP — do not open the PR; tell the user it violates the behavior-first rule (see CLAUDE.md) and needs to be rewired or split.
   - **`## Review focus`** — optional; where a reviewer should spend attention.

Important:

- Keep the PR title simple - just use the commit message as-is.
- Do not add extra formatting or emoji to the title.
- The Linear ticket check/creation MUST happen before pushing.
