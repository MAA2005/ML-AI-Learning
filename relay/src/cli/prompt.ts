/**
 * Read a secret from the terminal without echoing it, or from piped stdin when
 * not a TTY (scripts/tests). The value is never placed in argv, so it can't leak
 * into shell history or the process list.
 */

// Control codes, by codepoint, to avoid embedding raw control chars in source.
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;

export async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;

  // Non-interactive: read the first line of piped input.
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }

  // Interactive: raw mode, echo nothing.
  return new Promise<string>((resolve, reject) => {
    process.stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let acc = "";

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (input: string) => {
      for (const ch of input) {
        const code = ch.charCodeAt(0);
        if (code === LF || code === CR || code === CTRL_D) {
          cleanup();
          process.stdout.write("\n");
          resolve(acc);
          return;
        }
        if (code === CTRL_C) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Aborted."));
          return;
        }
        if (code === DEL || code === BACKSPACE) {
          acc = acc.slice(0, -1);
          continue;
        }
        // Ignore other control chars; append printable input only.
        if (code >= 0x20) acc += ch;
      }
    };

    stdin.on("data", onData);
  });
}
