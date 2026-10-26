// Client-side tools the agent can call. These run locally, on your machine,
// against plain JSON files - so there's no "outputs folder can't be
// overwritten" restriction like Cowork has. This is the actual advantage
// of owning the code: full read/write control over your own filesystem.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const LEADS_PATH = path.join(DATA_DIR, "leads.json");
const EXCLUDED_PATH = path.join(DATA_DIR, "excluded_companies.json");
const DRAFTS_PATH = path.join(DATA_DIR, "drafts.json");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Anthropic tool definitions (client tools - distinct from the server-side
// "web_search" tool, which Anthropic resolves for us and doesn't need a
// handler here).
export const toolDefinitions = [
  {
    name: "list_excluded_companies",
    description:
      "Return the list of companies already in the pipeline (applied, rejected, paused, or parked). " +
      "Always call this before saving a job lead, so you don't resurface a company already dealt with.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_existing_leads",
    description:
      "Return leads already saved from previous runs, so you don't save duplicates within or across runs.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_lead",
    description:
      "Save a new job lead or meetup lead to the local leads file. Only call this for leads that " +
      "passed the exclusion check and match the search criteria.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["job", "meetup"] },
        name: {
          type: "string",
          description: "Company name (for a job lead) or event name (for a meetup)",
        },
        title_or_topic: {
          type: "string",
          description: "Role title (job) or event topic (meetup)",
        },
        location: { type: "string" },
        link: { type: "string" },
        note: {
          type: "string",
          description: "Why it matches, or any flags (e.g. 'location eligibility unclear - verify before applying')",
        },
      },
      required: ["type", "name", "link"],
    },
  },
  {
    name: "save_draft",
    description: "Save a drafted outreach paragraph for a specific job lead, for human review before use.",
    input_schema: {
      type: "object",
      properties: {
        lead_link: { type: "string", description: "The lead's `link` field, unchanged - identifies which lead this is for" },
        draft_text: { type: "string" },
        status: { type: "string", enum: ["pending_review"] },
      },
      required: ["lead_link", "draft_text", "status"],
    },
  },
];

export function handleToolCall(name, input) {
  switch (name) {
    case "list_excluded_companies":
      return readJson(EXCLUDED_PATH, []);

    case "list_existing_leads":
      return readJson(LEADS_PATH, []);

    case "save_lead": {
      const leads = readJson(LEADS_PATH, []);
      const lead = { ...input, found_at: new Date().toISOString() };
      leads.push(lead);
      writeJson(LEADS_PATH, leads);
      return { saved: true, lead };
    }

    case "save_draft": {
      const drafts = readJson(DRAFTS_PATH, []);
      const draft = { ...input, created_at: new Date().toISOString() };
      drafts.push(draft);
      writeJson(DRAFTS_PATH, drafts);
      return { saved: true, draft };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
