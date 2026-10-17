import type { NoteRecord } from "../tools.js";
import type { Provider } from "./types.js";

const NOTE_TEXT = /(?:内容是|内容[:：]|[:：])\s*([\s\S]+)$/;

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function noteText(message: string): string {
  const match = NOTE_TEXT.exec(message);
  return clip((match?.[1] ?? message).trim(), 500);
}

export function createFakeProvider(): Provider {
  return {
    name: "fake",
    async runTurn(history, tools, emit) {
      const message = history.at(-1)?.text ?? "";
      const chunks: string[] = [];
      const say = (text: string) => {
        chunks.push(text);
        emit({ type: "text", text });
      };
      if (/列出|查看|list/i.test(message)) {
        const result = await tools.call("list_notes", {});
        if (!result.ok) {
          say(`没有列出。${result.output}`);
          return { text: chunks.join("") };
        }
        let notes: NoteRecord[] = [];
        try {
          const parsed = JSON.parse(result.output) as unknown;
          if (Array.isArray(parsed)) notes = parsed as NoteRecord[];
        } catch {
          say(result.output);
          return { text: chunks.join("") };
        }
        const lines = [`现在有 ${notes.length} 条笔记`, ...notes.map((note) => `- ${note.text}`)];
        say(lines.join("\n"));
        return { text: chunks.join("") };
      }
      if (/发|send/i.test(message)) {
        const text = noteText(message);
        say("好的，我调用 send_note，它会等你在审批台批准。");
        const result = await tools.call("send_note", { text });
        say(result.ok ? `已发送：${text}` : `没有发送。${result.output}`);
        return { text: chunks.join("") };
      }
      say("fake provider：说「发一条笔记：…」/ \"send …\" 来发笔记，说「列出笔记」/ \"list\" 来列出。");
      return { text: chunks.join("") };
    },
    async close() {},
  };
}
