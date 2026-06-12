import Anthropic from "@anthropic-ai/sdk";
import type { AgentFeedback, Spec } from "@specregistry/shared";
import { HttpError } from "../helpers.js";

const SYSTEM = `You are a technical specification editor for SpecRegistry, a system that governs
versioned Markdown specification documents. You will receive the current published content of a
specification file and a piece of feedback from an autonomous AI agent that found an ambiguity,
contradiction, or outdated guidance while working against that specification.

Produce a revised version of the COMPLETE specification document that resolves the reported issue.

Rules:
- Output ONLY the full revised markdown document. No preamble, no commentary, no code fences around the whole document.
- Preserve the document's existing structure, headings, tone, and formatting conventions.
- Make the smallest change that fully resolves the feedback; do not rewrite unrelated sections.
- If the feedback identifies a contradiction, resolve it decisively in the direction that best fits the rest of the document.`;

export async function draftFix(spec: Spec, feedback: AgentFeedback): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, "AI draft-fix requires ANTHROPIC_API_KEY to be configured on the server");
  }
  const client = new Anthropic();

  const userMessage = `## Specification: ${spec.filename} (v${spec.current_version})

<specification>
${spec.content}
</specification>

## Agent feedback to resolve

- Reported by: ${feedback.agent_identifier}
- Issue type: ${feedback.error_type}
- Against spec version: ${feedback.spec_version}
${feedback.context_code_snippet ? `- Code context:\n\`\`\`\n${feedback.context_code_snippet}\n\`\`\`` : ""}

${feedback.description}`;

  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });
  const message = await stream.finalMessage();

  const revised = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!revised) {
    throw new HttpError(502, `Model returned no revision (stop_reason: ${message.stop_reason})`);
  }
  return revised;
}
