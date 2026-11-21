import { spawn } from "node:child_process";
import { basename } from "node:path";

export function runCommand(
  command,
  args,
  { cwd, capture = false, input, onStdout, signal, timeoutMs } = {},
) {
  return new Promise((resolve, reject) => {
    const pipeStdout = capture || typeof onStdout === "function";
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        pipeStdout ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });

    let stdout = "";
    let stderr = "";
    let intentionallyStopped = false;
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);

    if (pipeStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (capture) {
          stdout += chunk;
        }
        onStdout?.(chunk);
      });
    }

    if (capture) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }

    const stopChild = () => {
      intentionallyStopped = true;
      child.kill("SIGKILL");
    };
    if (signal?.aborted) {
      stopChild();
    } else {
      signal?.addEventListener("abort", stopChild, { once: true });
    }

    child.once("error", (error) => {
      if (intentionallyStopped) {
        return;
      }
      reject(
        new Error(`Could not start ${basename(command)}: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once("close", (code, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopChild);
      if (timedOut) {
        reject(
          new Error(
            `${basename(command)} ${args.join(" ")} timed out after ${timeoutMs} ms`,
          ),
        );
        return;
      }
      if (intentionallyStopped) {
        resolve(stdout.trim());
        return;
      }

      if (code !== 0) {
        const details = `${stdout}${stderr}`.trim();
        const reason = closeSignal
          ? `signal ${closeSignal}`
          : `exit code ${code}`;
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
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
          reject(error);
        }
      });
      child.stdin.end(input);
    }
  });
}
