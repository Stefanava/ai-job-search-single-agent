# Context for drafting

Drop your real CV and past cover letters here as `.md` or `.txt` files. This whole directory is
gitignored except this file and `example/`, so nothing you put here gets pushed.

The agent reads every file directly in this directory into its system prompt and uses it as the
only source of truth when drafting outreach. There's no retrieval step: the whole CV goes in, which
is fine at this size and is the main difference from the multi-agent version's `retrieve_context`.

If this directory has no real files directly in it, the agent falls back to the fake example CV in
`example/`, so it still runs end to end without your real documents.
