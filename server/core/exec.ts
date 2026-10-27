import { spawn } from "node:child_process";
import type { Exec, ExecResult } from "./types.ts";

/** Node `Exec`: no shell, hard deadline (SIGKILL), never rejects. */
export const nodeExec: Exec = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout, stderr: `${stderr}\n${command}: prazo de ${options.timeoutMs} ms estourou` });
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
