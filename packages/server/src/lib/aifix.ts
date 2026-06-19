import type { AgentFeedback, Spec } from "@specregistry/shared";
import type { Db } from "../db.js";
import { runLlmText } from "./llm.js";

const SYSTEM = `You are a technical specification editor for SpecRegistry, a system that governs
versioned Markdown specification documents. You will receive the current published content of a
specification file and a piece of feedback from an autonomous AI agent that found an ambiguity,
contradiction, or outdated guidance while working against that specification.

Produce a revised version of the COMPLETE specification document that resolves the reported issue.

Rules:
- Output ONLY the full revised markdown document. No preamble, no commentary, no code fences around the whole document.
- Do not include reasoning, analysis, chain-of-thought, scratch notes, bullet-point planning, or references to what you inspected.
- The first non-whitespace character of your response must be "#".
- Preserve the document's existing structure, headings, tone, and formatting conventions.
- Make the smallest change that fully resolves the feedback; do not rewrite unrelated sections.
- If the feedback identifies a contradiction, resolve it decisively in the direction that best fits the rest of the document.`;

export function sanitizeDraftFixOutput(raw: string, currentSpecContent: string): string {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:markdown|md)?\s*([\s\S]*?)```/gi, "$1")
    .trim();

  const firstHeading = currentSpecContent.match(/^# .+$/m)?.[0];
  if (firstHeading) {
    const exactHeadingIndex = text.indexOf(firstHeading);
    if (exactHeadingIndex > 0) text = text.slice(exactHeadingIndex).trimStart();
  }

  if (!text.startsWith("#")) {
    const firstMarkdownHeading = text.search(/^#\s+/m);
    if (firstMarkdownHeading > 0) text = text.slice(firstMarkdownHeading).trimStart();
  }

  return text.trim();
}

export async function draftFix(db: Db, spec: Spec, feedback: AgentFeedback): Promise<string> {
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

  const { text } = await runLlmText(db, {
    system: SYSTEM,
    user: userMessage,
    maxTokens: 16000,
    route: "draft_fix",
  });
  return sanitizeDraftFixOutput(text, spec.content);
}
