// The upstream SSE parser must survive arbitrary TCP chunk boundaries. A CRLF
// pair split across two reads used to merge frames and then throw
// "malformed SSE frame" mid-stream, so clients silently lost events.

import { expect, test } from "bun:test";
import { parseSse } from "../src/upstream.ts";

const encoder = new TextEncoder();

const frame = (name: string, json: string, sep = "\r\n"): string => `event: ${name}${sep}data: ${json}${sep}${sep}`;

const wire = (sep = "\r\n"): string =>
  frame("message_start", '{"type":"message_start"}', sep) +
  frame("content_block_delta", '{"type":"content_block_delta","delta":{"text":"hi"}}', sep) +
  frame("message_stop", '{"type":"message_stop"}', sep);

async function collect(chunks: string[]): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const types: string[] = [];
  for await (const event of parseSse(stream)) types.push((event as { type: string }).type);
  return types;
}

test("every two-chunk split of an SSE body yields all events", async () => {
  for (const sep of ["\r\n", "\n"]) {
    const body = wire(sep);
    expect(await collect([body])).toHaveLength(3);
    for (let cut = 1; cut < body.length; cut += 1) {
      expect(await collect([body.slice(0, cut), body.slice(cut)])).toHaveLength(3);
    }
  }
});

test("byte-at-a-time delivery still parses cleanly", async () => {
  const body = wire();
  const chunks = [...body].map((char) => char);
  expect(await collect(chunks)).toHaveLength(3);
});

test("a truncated tail fails loudly instead of dropping events silently", async () => {
  // A half-delivered frame is upstream corruption: surface it, never ignore it.
  const body = wire().slice(0, -20);
  await expect(collect([body])).rejects.toThrow(/malformed SSE frame/);
});
