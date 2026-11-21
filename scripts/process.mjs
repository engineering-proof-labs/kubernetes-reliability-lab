import { spawn } from "node:child_process";
import { basename } from "node:path";

export function runCommand(
  command,
  args,
  { cwd, capture = false, input } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }

    child.once("error", (error) => {
      reject(
        new Error(`Could not start ${basename(command)}: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code, signal) => {
      if (code !== 0) {
        const details = `${stdout}${stderr}`.trim();
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(
          new Error(
            `${basename(command)} ${args.join(" ")} failed with ${reason}${details ? `:\n${details}` : ""}`,
          ),
        );
        return;
      }

      resolve(stdout.trim());
    });

    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}
