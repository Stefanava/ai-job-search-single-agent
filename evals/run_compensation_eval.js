// Eval for the compensation-floor rule in config/criteria.json. This rule is
// never enforced in code - the whole criteria object, compensation_floor
// included, is dumped into the agent's system prompt as text, and a person
// reading that text is trusted to apply it correctly when deciding whether
// to save a lead. That's a soft constraint, not a hard filter, so it's worth
// checking on its own rather than assuming it always works.
//
// This isolates just that one rule with a single structured-output call (not
// the full search-and-save agent loop) against a fixed set of labelled
// fixture leads, so a wording change to the rule - or a model change - can
// be checked against known-good decisions rather than trusting a live run
// on faith.
//
// Uses a fake fixture floor (evals/cases.json), never the real one. The real
// floor is redacted to null in the committed config/criteria.json, and this
// file exists specifically so testing the rule doesn't require putting real
// numbers anywhere.
//
// Deliberately does NOT exit non-zero on a disagreement - a disagreement
// here is something to read and think about, not a build gate.
//
// Usage: npm run eval:compensation

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new Anthropic();

const { fixture_floor, cases } = JSON.parse(
  fs.readFileSync(path.join(__dirname, "cases.json"), "utf-8")
);

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["include", "exclude"] },
    reasoning: {
      type: "string",
      description: "1-2 sentences, grounded only in the rule and the stated compensation - no outside judgement.",
    },
  },
  required: ["decision", "reasoning"],
  additionalProperties: false,
};

async function judge(statedCompensation) {
  const response = await client.messages.parse({
    model: "claude-sonnet-5",
    max_tokens: 512,
    system: `You decide whether a single job lead should be included or excluded from a job search
pipeline, based ONLY on the compensation-floor rule below. Do not weigh role fit, seniority,
location, or anything else about the lead - only whether the stated (or absent) compensation
clears the floor per this rule.

Compensation floor: £${fixture_floor.gbp} / €${fixture_floor.eur}
Rule: ${fixture_floor.rule}`,
    messages: [
      {
        role: "user",
        content: `Stated compensation for this lead: ${statedCompensation || "(not mentioned in the listing)"}`,
      },
    ],
    output_config: { format: { type: "json_schema", schema: DECISION_SCHEMA } },
  });
  return response.parsed_output;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in, or export it directly.");
    process.exit(1);
  }

  console.log(`Running compensation-floor eval against ${cases.length} fixed case(s)...`);
  console.log(`Fixture floor: £${fixture_floor.gbp} / €${fixture_floor.eur} (fake numbers, not the real floor)\n`);

  const results = [];
  for (const testCase of cases) {
    const verdict = await judge(testCase.stated_compensation);
    const agree = verdict.decision === testCase.reference.decision;

    results.push({
      id: testCase.id,
      why: testCase.why,
      stated_compensation: testCase.stated_compensation,
      expected: testCase.reference.decision,
      actual: verdict.decision,
      reasoning: verdict.reasoning,
      agree,
    });

    console.log(`[${agree ? "AGREE" : "DISAGREE"}] ${testCase.id}`);
    console.log(`  stated: ${testCase.stated_compensation || "(unstated)"}`);
    console.log(`  expected: ${testCase.reference.decision}, actual: ${verdict.decision}`);
    if (!agree) console.log(`  reasoning: ${verdict.reasoning}`);
    console.log("");
  }

  const agreeCount = results.filter((r) => r.agree).length;
  console.log(`----------------------------------------------------------------`);
  console.log(`${agreeCount}/${results.length} cases agreed with the reference decision.`);
  console.log(`This is a prompt-quality signal, not a build gate - read the disagreements above,`);
  console.log(`don't just look at the count.`);

  const resultsDir = path.join(__dirname, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `eval_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${path.relative(process.cwd(), outPath)}`);
}

main();
