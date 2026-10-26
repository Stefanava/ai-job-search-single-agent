# AI Job Search Agent (single-agent)

A small, framework-free agent built directly on the Claude API. One agent, one loop, one prompt:
it searches job boards and meetup sites for a UK-based Engineering Manager open to relocating
within Europe, saves genuine matches, and drafts tailored outreach when asked.

It's the single-agent counterpart to
[ai-job-search-multi-agent](https://github.com/Stefanava/ai-job-search-multi-agent), which does the
same job with separate Researcher, Screener, Writer and Critic agents, retrieval over the CV, and a
human review step. Both repos share the same brief and `config/criteria.json`, so the difference
between them is the architecture, not the task.

## What it does

Given a single prompt ("run this week's scan"), the agent:

1. Reads `config/criteria.json` for role, location, compensation, and source rules.
2. Calls `list_excluded_companies` and `list_existing_leads` (your own local JSON files) so it
   doesn't resurface companies already in your pipeline or leads already saved.
3. Uses Claude's built-in `web_search` tool to search the configured job boards and meetup sites.
4. Calls `save_lead` for anything that's genuinely new and matches your criteria.
5. If the prompt asks for outreach, drafts a short paragraph per job lead from your CV and calls
   `save_draft`.
6. Prints a summary, including anything that needs your judgement (e.g. a listing that doesn't
   say whether it hires from the UK).

## Single agent vs multi-agent

| | This repo | ai-job-search-multi-agent |
|---|---|---|
| Agents | One loop does everything | Researcher, Screener, Writer, Critic |
| CV grounding | Whole CV in the system prompt | `retrieve_context` pulls relevant chunks |
| Draft review | You read `data/drafts.json` | Critic scores each draft, Writer retries, then you review |
| Lead review | None, every saved lead is a lead | Screener scores fit, you approve/reject before drafting |
| Moving parts | 2 source files | ~17 source files |

Which one is worth running depends on whether the extra review and grounding produce better
leads and drafts than the cost and complexity they add. That's the question a separate
build-vs-buy evaluation of the two answers.

## Architecture, briefly

- **`src/agent.js`**: the loop. Sends messages to Claude, logs what it does, and hands control
  back to Claude until it stops asking for tools (`stop_reason !== "tool_use"`).
- **`src/tools.js`**: the *client* tools (`list_excluded_companies`, `list_existing_leads`,
  `save_lead`, `save_draft`). These are the tools this script has to actually implement and run
  locally. `web_search` is a *server* tool. Anthropic runs it and hands back results before the
  response even reaches this script, so there's no handler for it here.
- **`config/criteria.json`**: the search rules. Edit this, not the code, to change what counts as
  a match.
- **`context/`**: your real CV and cover-letter notes as `.md` or `.txt`, read into the system
  prompt for drafting. Gitignored apart from its README and a fake `example/` CV, which the agent
  falls back to if you haven't added your own.
- **`data/excluded_companies.json`**: companies already in your pipeline (applied, rejected,
  paused). Gitignored, since it's real pipeline data. See `data/excluded_companies.example.json`
  for a fake stand-in with the same shape.
- **`data/leads.json`** and **`data/drafts.json`**: where new leads and drafts land. Gitignored for
  the same reason. Both tools fall back to an empty list if the file is missing, so a fresh clone
  runs fine with neither there.

## Setup

```bash
cd ai-job-search-single-agent
npm install
cp .env.example .env
# edit .env and add your real ANTHROPIC_API_KEY
cp data/excluded_companies.example.json data/excluded_companies.json  # or your own real data
# optional: put your real CV in context/ (e.g. context/cv.txt)
npm start
```

Or run with a custom instruction:

```bash
node --env-file=.env src/agent.js "Find new Engineering Manager roles on relocate.me and draft a short outreach paragraph for each"
```

### Compensation floor

`config/criteria.json`'s `compensation_floor` ships blank (`null`/`null`) in this repo on purpose. It's
a real negotiating position, not something to publish in a public git history. Set your own numbers in
a local, uncommitted edit if you want the agent to weigh compensation.

This rule is never enforced in code. The whole `criteria.json` object is dumped into the system prompt
as text, and the model is trusted to apply the rule correctly. Run the eval below any time to check
that trust is warranted, on a fixture floor, without needing your real numbers anywhere:

```bash
npm run eval:compensation
```

`evals/cases.json` holds the fixture floor and labelled test cases; `evals/run_compensation_eval.js`
runs a single structured-output call per case and reports agreement. It doesn't gate anything. It's a
prompt-quality signal to read, not a pass/fail build check.

## Why build it at all

This started as the code version of a Cowork scheduled task doing the same weekly scan. Cowork can't
overwrite files once written to its outputs folder, so every tracker update had to be a new dated
file, which is clunky for anything that should accumulate over time. This script runs against your
own filesystem, so `data/leads.json` just grows normally. A small, concrete build-vs-buy trade-off.

## Extending it

Roughly in order of how useful they'd be:

1. **Write leads straight into the real tracker.** Swap `data/leads.json` for the `xlsx` npm
   package (SheetJS) and append rows directly to the application tracker spreadsheet. This closes
   the loop between the agent and the thing you actually look at.
2. **Add a LinkedIn check, carefully.** LinkedIn has no public jobs-search API, and automating a
   logged-in session against it (scraping, headless browser on a schedule) is the exact pattern
   their bot detection is built to catch, which puts the account at risk. Don't wire this into an
   unattended loop. If you want LinkedIn coverage, use a Claude-in-Chrome-assisted session you
   trigger yourself while logged in.
3. **Notifications.** Add a tool that posts the run summary somewhere you'll actually see it
   (email, Slack webhook, etc.). The multi-agent repo's `src/shared/mailer.js` is one way to do it.
4. **Run it on a schedule yourself.** `cron` (macOS/Linux) or `launchd` (macOS) calling
   `node --env-file=.env src/agent.js` weekly.
5. **Swap the model or add the Claude Agent SDK.** This script hand-rolls the tool-use loop so you
   can see every part of it. Once that's familiar, the [Claude Agent SDK](https://docs.claude.com)
   wraps a lot of this boilerplate (context management, retries, structured tool running).

## A note on honesty in the output

The system prompt tells Claude not to pad results with weak matches just to have something to
report, to flag location eligibility when a listing doesn't make it clear, and never to invent
experience in a draft. Worth keeping those instructions if you extend the prompt. A job search agent
that oversells thin matches to look useful is worse than one that plainly says "nothing new this
week."
