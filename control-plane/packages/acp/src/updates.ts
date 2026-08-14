/**
 * Reading assistant text out of `session/update` payloads.
 *
 * This is the one place that knows the shape. Two callers need it for
 * different reasons -- a routine writes the final text into its run record,
 * and the voice bridge speaks it aloud -- and the day the payload changes,
 * both should break here rather than one of them quietly going silent.
 *
 * Thought chunks are deliberately excluded. `agent_thought_chunk` is the
 * model's reasoning, not its answer: putting it in a run summary is noise, and
 * speaking it aloud would have an agent narrate its own deliberation.
 */

/** The text of one `agent_message_chunk`, or null for anything else. */
export function assistantTextOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  if (!("sessionUpdate" in payload) || payload.sessionUpdate !== "agent_message_chunk") return null;
  if (!("content" in payload)) return null;

  const content = payload.content;
  if (content === null || typeof content !== "object") return null;
  if (!("type" in content) || content.type !== "text") return null;
  if (!("text" in content) || typeof content.text !== "string") return null;

  return content.text.length > 0 ? content.text : null;
}

/**
 * Every assistant chunk in order, joined.
 *
 * Joined with no separator because the chunks are a stream: they are already
 * split mid-word, and anything inserted between them shows up in the middle of
 * a sentence.
 */
export function joinAssistantText(payloads: Iterable<unknown>): string {
  let joined = "";
  for (const payload of payloads) {
    const text = assistantTextOf(payload);
    if (text !== null) joined += text;
  }
  return joined;
}
