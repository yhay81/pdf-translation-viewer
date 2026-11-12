import type { CancellationToken } from "vscode";
import type { SourceBlock } from "../shared/protocol";
import type { TranslationBackend } from "./backends";
import { buildPrompt } from "./blockProtocol";

export const PLAMO_MODEL = {
  id: "plamo-3.1-prime",
  name: "PLaMo 3.1 Prime",
  vendor: "Preferred Networks",
  family: "PLaMo",
};

/** Only the status reaches the log or the webview. A server error body can contain submitted text. */
export class PlamoError extends Error {
  constructor(readonly reason: number | "connection" | "response") {
    super(`PLaMo API error (${reason})`);
  }
}

/** Decode UTF-8 before splitting events. Both Japanese characters and event boundaries can span reads. */
async function* eventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (done) buffer += "\n\n";
      const events = buffer.split(/\r?\n\r?\n|\r\r/);
      buffer = events.pop()!;
      for (const event of events) {
        const data = event.split(/\r\n|[\r\n]/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function translationFragment(data: string): string | undefined {
  let chunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    throw new PlamoError("response");
  }
  if (chunk?.error || !Array.isArray(chunk?.choices)) throw new PlamoError("response");
  // Role, reasoning, and usage events contain no translation text.
  const content = chunk.choices[0]?.delta?.content;
  return typeof content === "string" ? content : undefined;
}

export class PlamoBackend implements TranslationBackend {
  readonly id = `plamo:${PLAMO_MODEL.id}`;
  readonly label = PLAMO_MODEL.name;
  readonly cacheable = true;
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async *stream(blocks: SourceBlock[], targetLanguage: string, token: CancellationToken): AsyncIterable<string> {
    if (token.isCancellationRequested) return;
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      const response = await fetch("https://api.platform.preferredai.jp/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: PLAMO_MODEL.id,
          messages: [{ role: "user", content: buildPrompt(blocks, targetLanguage) }],
          stream: true,
        }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new PlamoError(response.status);
      if (!response.body) throw new PlamoError("response");
      for await (const data of eventData(response.body)) {
        if (token.isCancellationRequested || data === "[DONE]") return;
        const fragment = translationFragment(data);
        if (fragment) yield fragment;
      }
      throw new PlamoError("response"); // The stream ended before its completion marker.
    } catch (err) {
      if (token.isCancellationRequested) return;
      throw err instanceof PlamoError ? err : new PlamoError("connection");
    } finally {
      subscription.dispose();
      controller.abort();
    }
  }
}
