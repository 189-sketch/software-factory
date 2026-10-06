import { spawn } from "node:child_process";
import path from "node:path";

const WORKER_ENV_KEYS = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MAX_TOKENS",
  "ANTHROPIC_MAX_RETRIES",
  "FACTORY_AUTO_MERGE",
  "FACTORY_DEFAULT_BRANCH",
  "FACTORY_GH_REPO",
  "FACTORY_LLM_TIMEOUT_MS",
  "FACTORY_COMMAND_TIMEOUT_MS",
  "FACTORY_MODEL_ADAPTER",
  "FACTORY_MODEL_CONTEXT_WINDOW",
  "FACTORY_REMOTE_PATH",
  "FACTORY_REVIEW_DIR",
  "FACTORY_STATE_DIR",
  "FACTORY_SYNC_LABELS",
  "FACTORY_SYNC_PROJECTS",
  "FACTORY_TRUSTED_EXECUTION",
  "FACTORY_VERIFY_COMMAND",
  "FACTORY_VERIFY_URL",
  "GIT_DIR",
  "GIT_WORK_TREE",
]);

function portableRelative(root, target, mount) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Worker path is outside its declared mount: ${target}`);
  }
  return `${mount}/${relative.replace(/\\/g, "/")}`.replace(/\/$/, "");
}

export function buildWorkerInvocation(input) {
  const adapter = input.execution?.adapter || "local";
  const commonOptions = {
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  };

  if (adapter === "local") {
    if (!input.execution.trusted) {
      throw new Error("Local worker execution is disabled; set FACTORY_TRUSTED_EXECUTION=1 or choose docker/vm");
    }
    return {
      command: input.runner,
      args: [input.entryPath, ...input.args],
      options: { ...commonOptions, cwd: input.issueWorkdir },
    };
  }

  if (adapter === "docker") {
    if (!input.execution.dockerImage) {
      throw new Error("FACTORY_DOCKER_IMAGE is required for the docker execution adapter");
    }
    if (!input.issueGitDir || !input.gitCommonDir) {
      throw new Error("Docker worker execution requires issueGitDir and gitCommonDir");
    }
    const entry = portableRelative(input.factoryRoot, input.entryPath, "/factory");
    const gitDir = portableRelative(input.gitCommonDir, input.issueGitDir, "/git-common");
    const args = input.args.map((value) => {
      if (path.isAbsolute(value) && path.resolve(value).startsWith(`${path.resolve(input.stateDir)}${path.sep}`)) {
        return portableRelative(input.stateDir, value, "/factory-state");
      }
      if (path.isAbsolute(value) && path.resolve(value).startsWith(`${path.resolve(input.factoryRoot)}${path.sep}`)) {
        return portableRelative(input.factoryRoot, value, "/factory");
      }
      return value;
    });
    const dockerEnv = {
      ...input.env,
      FACTORY_STATE_DIR: "/factory-state",
      FACTORY_TRUSTED_EXECUTION: "1",
      GIT_DIR: gitDir,
      GIT_WORK_TREE: "/workspace",
    };
    const environmentArgs = WORKER_ENV_KEYS
      .filter((key) => dockerEnv[key] !== undefined && dockerEnv[key] !== "")
      .flatMap((key) => ["--env", key]);
    return {
      command: "docker",
      args: [
        "run", "--rm", "--init", "--workdir", "/workspace",
        "--volume", `${path.resolve(input.issueWorkdir)}:/workspace`,
        "--volume", `${path.resolve(input.gitCommonDir)}:/git-common`,
        "--volume", `${path.resolve(input.factoryRoot)}:/factory:ro`,
        "--volume", `${path.resolve(input.stateDir)}:/factory-state`,
        ...environmentArgs,
        input.execution.dockerImage,
        "node", entry, ...args,
      ],
      options: { ...commonOptions, env: dockerEnv, cwd: input.factoryRoot },
    };
  }

  if (adapter === "vm") {
    if (!input.execution.vmCommand) {
      throw new Error("FACTORY_VM_COMMAND is required for the vm execution adapter");
    }
    return {
      command: input.execution.vmCommand,
      args: [
        "--workdir", path.resolve(input.issueWorkdir),
        "--state-dir", path.resolve(input.stateDir),
        "--factory-root", path.resolve(input.factoryRoot),
        "--", input.runner, input.entryPath, ...input.args,
      ],
      options: {
        ...commonOptions,
        env: { ...input.env, FACTORY_TRUSTED_EXECUTION: "1" },
        cwd: input.factoryRoot,
      },
    };
  }

  throw new Error(`Unknown execution adapter: ${adapter}`);
}

export function spawnWorker(input) {
  const invocation = buildWorkerInvocation(input);
  return spawn(invocation.command, invocation.args, invocation.options);
}
