import { execFile, spawn } from "node:child_process";
import path from "node:path";

export class GitError extends Error {}

export function gitExec(repoPath: string, args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  if (input === undefined) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd: repoPath, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err: unknown, stdout: unknown, stderr: unknown) => {
        if (err) {
          reject(Object.assign(new GitError(`git ${args.join(" ")} failed: ${String((stderr as string) ?? (err as Error).message).slice(0, 500)}`), { stdout, stderr }));
          return;
        }
        resolve({ stdout: (stdout as string) ?? "", stderr: (stderr as string) ?? "" });
      });
    });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoPath, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", (err) => reject(new GitError(`git ${args.join(" ")} failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(Object.assign(new GitError(`git ${args.join(" ")} failed: ${stderr.slice(0, 500)}`), { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function checkGitVersion(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await gitExec(process.cwd(), ["--version"]));
  } catch {
    throw new Error("Git 2.23 or newer is required and must be on PATH (could not run `git --version`).");
  }
  const m = stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) throw new Error("Unable to determine git version. Git 2.23 or newer is required.");
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 2 || (major === 2 && minor < 23)) {
    throw new Error(`Git 2.23 or newer is required (found ${m[0]}).`);
  }
}

export function isCommitSha(s: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(s.trim());
}

export async function repoRootOf(p: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(p, ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function isShallow(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExec(repoPath, ["rev-parse", "--is-shallow-repository"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
