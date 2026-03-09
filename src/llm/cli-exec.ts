import type { ExecFileException } from "node:child_process";
import type { ExecFileFn } from "../markitdown.js";

type CliExecError = ExecFileException & {
  cmd?: string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

function toUtf8String(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function formatErrorMessageWithStderr(
  message: string,
  stderrText: string,
  separator: ": " | "\n" = ": ",
): string {
  const trimmedStderr = stderrText.trim();
  if (!trimmedStderr || message.includes(trimmedStderr)) return message;
  return `${message}${separator}${trimmedStderr}`;
}

function formatTimeoutLabel(timeoutMs: number): string {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    if (timeoutMs % 60_000 === 0) return `${Math.floor(timeoutMs / 60_000)}m`;
    if (timeoutMs % 1000 === 0) return `${Math.floor(timeoutMs / 1000)}s`;
    return `${Math.floor(timeoutMs)}ms`;
  }
  return "unknown time";
}

function getExecErrorCodeText(error: CliExecError): string {
  if (typeof error.code === "string") return error.code;
  if (Buffer.isBuffer(error.code)) return toUtf8String(error.code);
  if (typeof error.code === "number") return String(error.code);
  return "";
}

function isExecTimeoutError(error: CliExecError): boolean {
  if (getExecErrorCodeText(error).toUpperCase() === "ETIMEDOUT") return true;
  return error.killed === true && error.signal === "SIGTERM";
}

function getExecErrorMessage(error: CliExecError): string {
  return typeof error.message === "string" && error.message.trim().length > 0
    ? error.message.trim()
    : "CLI command failed";
}

function getExecCommand(error: CliExecError, cmd: string, args: string[]): string {
  return typeof error.cmd === "string" && error.cmd.trim().length > 0
    ? error.cmd.trim()
    : [cmd, ...args].join(" ");
}

export async function execCliWithInput({
  execFileImpl,
  cmd,
  args,
  input,
  timeoutMs,
  env,
  cwd,
}: {
  execFileImpl: ExecFileFn;
  cmd: string;
  args: string[];
  input: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  cwd?: string;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = execFileImpl(
      cmd,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        cwd,
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const stderrText = toUtf8String(stderr);
        if (error) {
          if (isExecTimeoutError(error)) {
            const timeoutMessage =
              `CLI command timed out after ${formatTimeoutLabel(timeoutMs)}: ${getExecCommand(error, cmd, args)}. ` +
              "Increase --timeout (e.g. 5m).";
            reject(
              new Error(formatErrorMessageWithStderr(timeoutMessage, stderrText, "\n"), {
                cause: error,
              }),
            );
            return;
          }
          reject(
            new Error(formatErrorMessageWithStderr(getExecErrorMessage(error), stderrText), {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout: toUtf8String(stdout), stderr: stderrText });
      },
    );
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
