# Contributing to PlayVow

PlayVow is open source, and you do not need deep programming experience to make a contribution. If you can describe a change, click around in a browser, and work with an AI assistant, you can help.

The easiest path is **GitHub Codespaces**. It opens a ready-to-use copy of PlayVow in your browser. The Codespaces demo is local-only. It doesn't connect to production, SteamGifts, or Steam.

## First Contribution: Change Some Text

This walkthrough gets you from the GitHub page to a pull request with one visible text change.

1. Open the PlayVow repository on GitHub.
2. Select **Code**.
3. Select **Codespaces**.
4. Select **Create codespace**.
5. Wait for setup to finish.
6. Open the forwarded **PlayVow** preview. If it does not open, use the **Ports** tab and open port `3000`.

Then open the AI chat panel in Codespaces, usually GitHub Copilot Chat, and paste:

```text
I am new to coding and want to make one small text change in PlayVow.

Please ask me what page the text is on, what it currently says, and what I want it changed to. Then find the smallest file to edit, make only that change, and tell me exactly what page I should preview.

Avoid unrelated refactors.
```

Answer the assistant's questions. Example:

```text
The text is on the admin users page.
It currently says "Promote or demote moderators."
I want it to say "Manage moderator and admin roles."
```

After the AI edits the file, refresh the PlayVow preview and check the page. If you cannot find the page, ask:

```text
Please tell me the exact preview URL path where I can see this change.
```

When the change looks right, ask:

```text
The change looks right in the preview. Please run the checks that make sense for this change and summarize the result in plain English.
```

If something fails, ask:

```text
Please explain the failure in plain English and make the smallest safe fix.
```

When the preview and checks look good, ask:

```text
Please help me submit this change for review.

Create a short branch name, commit only the files for this change, and help me open a pull request. Use a clear PR title and include what changed, why it changed, and how I previewed or tested it.
```

Useful words:

- **Branch**: a safe working copy for your change.
- **Commit**: a saved snapshot of your change.
- **Pull request**: a request for maintainers to review and merge your change.

A great first pull request might change only one line. Small changes are easier to review and easier to merge.

## Safe First Changes

Good first changes:

- wording on a page
- table labels
- help notes
- button labels
- small styling tweaks
- documentation

Changes that need more care:

- database migrations
- authentication or roles
- scheduled jobs
- SteamGifts scraping
- Steam API polling
- production deploy scripts
- secrets or cookies

You can still work on harder changes with help, but ask the AI assistant to explain the safety checks before editing.

## Riskier Changes

For database changes, ask the AI assistant:

```text
I want to store a new field. Please inspect the database, repos, server queries, and seed data. Make a minimal migration and update tests or demo data where needed.
```

For external data changes, ask:

```text
Please add or update sample data for this external response so tests do not depend on the live network.
```

For scheduled job changes, ask:

```text
I want to change a worker job. Please inspect the scheduler, the job file, related repos, sample data, and tests. Explain how we can test this safely before editing.
```

## Keep Changes Small

- don't commit real `.env` secrets
- don't use production credentials in Codespaces
- don't touch deploy scripts unless the change is about deployment
- don't change generated files by hand
- don't make broad refactors while fixing a small issue
- don't delete tests because they are failing

If you are unsure, ask:

```text
Is this change touching any production-risky area? Please explain before editing further.
```
