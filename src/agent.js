// Minimal agentic loop using the Claude API directly - no framework, so you
// can see exactly what an "agent" actually is: a model, a system prompt, a
// set of tools, and a loop that keeps calling the model until it stops
// asking for tools.
//
// Two kinds of tools are in play:
//  - "web_search" is a SERVER tool: Anthropic runs it and hands Claude the
//    results before the response even comes back to us. We don't implement it.
//  - "list_excluded_companies" / "list_existing_leads" / "save_lead" /
//    "save_draft" are CLIENT tools: Claude asks for them, and this script has
//    to actually run them (see tools.js) and hand the result back on the
//    next turn.
//
// One agent does the whole job - search, save, and draft outreach when asked.
// ../ai-job-search-multi-agent splits the same job across Researcher,
// Screener, Writer and Critic agents with a human review step; this is the
// single-agent counterpart to compare it against.

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { toolDefinitions, handleToolCall } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const criteria = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "criteria.json"), "utf-8")
);

// The whole CV goes straight into the system prompt - no retrieval step, the
// main difference from the multi-agent version's retrieve_context. Real files
// sit directly in context/ (gitignored); the fake example/ corpus is the
// fallback so a fresh clone still runs.
function loadContext() {
  const contextDir = path.join(__dirname, "..", "context");
  const readDir = (dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => /\.(md|txt)$/.test(f) && f !== "README.md")
          .map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(dir, f), "utf-8").trim()}`)
      : [];
  const real = readDir(contextDir);
  if (real.length) return real.join("\n\n");
  console.warn("[context] No real CV/cover-letter files found directly in context/ - using the fake example in context/example/.");
  return readDir(path.join(contextDir, "example")).join("\n\n");
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const SYSTEM_PROMPT = `You are a job search assistant for a UK-based Engineering Manager who is open to
relocating within Europe. The search focuses on remote and relocation-friendly roles.

Hard constraint, not a preference: the candidate must be able to work in the role's location.
Remote roles must be open to candidates based in the UK or Europe. Roles tied to a European
office need relocation support, visa sponsorship, or a clear sign the company hires from the UK.
If a listing doesn't make location eligibility clear, still surface it but flag it explicitly
(e.g. "location eligibility unclear - verify before applying"). Never silently drop it and
never silently include it as if it were confirmed.

Search criteria (edit config/criteria.json to change this without touching code):
${JSON.stringify(criteria, null, 2)}

Workflow:
1. Call list_excluded_companies and list_existing_leads first, so you know what to skip.
2. Use web_search to look for new Engineering Manager (or equivalent) roles on the configured
   job sources, and new meetups on the configured meetup sources/locations/topics.
3. For each genuinely new match that fits the criteria and isn't already excluded or already
   saved, call save_lead.
4. Only if the task asks for outreach, draft a short tailored paragraph per job lead and call
   save_draft with the lead's link unchanged. Drafts are for the candidate to review before use.
5. Finish with a short plain-text summary: how many job leads and meetups you saved, any drafts,
   and anything that needs a human judgement call (e.g. the location eligibility flag).

Drafting rules:
- Ground every factual claim in the candidate context below. Never invent experience, titles,
  dates, or achievements - if the context doesn't support a claim, leave it out.
- UK English, no em dashes, no colons used as a stylistic flourish, direct and concrete over
  generic enthusiasm.
- Be specific to the lead - reference the actual company and role.

Be honest about zero results. Do not pad the list with weak matches just to have something to report.

Candidate context (CV and cover-letter notes - the only source of truth about their background):
${loadContext()}`;

const tools = [
  { type: "web_search_20250305", name: "web_search", max_uses: 15 },
  ...toolDefinitions,
];

const MAX_ITERATIONS = 20; // safety cap so a bug can't loop forever and burn tokens

async function runAgent(userPrompt) {
  const messages = [{ role: "user", content: userPrompt }];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // Log what happened this turn so the loop is visible, not a black box.
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        console.log("\n[claude]", block.text.trim());
      } else if (block.type === "server_tool_use") {
        console.log(`\n[web_search] "${block.input.query}"`);
      } else if (block.type === "tool_use") {
        console.log(`\n[tool call] ${block.name}(${JSON.stringify(block.input)})`);
      }
    }

    // max_tokens means the reply was cut off, not finished: any complete tool
    // calls in it still need running, and the model needs to carry on.
    // Treating it as done silently dropped saves mid-run.
    const truncated = response.stop_reason === "max_tokens";
    if (truncated) console.warn("\nReply hit max_tokens - continuing.");

    if (response.stop_reason !== "tool_use" && !truncated) {
      // "end_turn" (done) or "pause_turn" (long search - just resubmit as-is,
      // which happens naturally on the next loop iteration since `messages`
      // already has the paused turn appended).
      if (response.stop_reason === "pause_turn") continue;
      return; // done
    }

    // Only CLIENT tool_use blocks need a local handler - server_tool_use
    // (web_search) is already resolved inside response.content.
    const clientCalls = response.content.filter((b) => b.type === "tool_use");
    if (clientCalls.length === 0) {
      if (truncated) messages.push({ role: "user", content: "Your last reply was cut off by the output limit. Continue from where you stopped." });
      continue;
    }

    const toolResults = clientCalls.map((block) => {
      let result;
      try {
        result = handleToolCall(block.name, block.input);
      } catch (err) {
        result = { error: String(err) };
      }
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      };
    });

    messages.push({ role: "user", content: toolResults });
  }

  console.warn(`\nHit the ${MAX_ITERATIONS}-iteration safety cap without finishing - check the log above.`);
}

const prompt =
  process.argv[2] ||
  "Run this week's job search scan: find new Engineering Manager leads and relevant meetups, per the configured criteria. Don't draft outreach.";

runAgent(prompt).catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
