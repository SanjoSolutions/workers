import { execFile } from "child_process";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runGit(args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            exitCode: 0,
            stdout,
            stderr,
          });
          return;
        }

        const spawnError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (spawnError.code === "ENOENT") {
          reject(error);
          return;
        }

        resolve({
          exitCode: typeof spawnError.code === "number" ? spawnError.code : 1,
          stdout: spawnError.stdout ?? stdout ?? "",
          stderr: spawnError.stderr ?? stderr ?? "",
        });
      },
    );
  });
}
