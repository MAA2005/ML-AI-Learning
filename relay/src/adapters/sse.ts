/**
 * Minimal Server-Sent Events parser over a fetch `ReadableStream`.
 *
 * Shared by the streaming adapters, which then interpret the payloads
 * differently: OpenAI-compatible emits one `data:` JSON chunk per event and a
 * `data: [DONE]` terminator; Anthropic emits named events (`event: <type>`) with
 * their own JSON. This layer only splits the byte stream into `{event?, data}`
 * blocks — it does not parse the JSON.
 */

export interface SseEvent {
  /** The `event:` field, if the server sent one (Anthropic does; OpenAI doesn't). */
  event?: string;
  /** The joined `data:` field(s) of one event block. */
  data: string;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          // Blank line dispatches the accumulated event.
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join("\n") };
          }
          dataLines = [];
          eventName = undefined;
        } else if (line[0] === ":") {
          // Comment / heartbeat — ignore.
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).replace(/^ /, "").trim();
        }
      }
    }
    // Flush a trailing event that wasn't followed by a blank line.
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}
