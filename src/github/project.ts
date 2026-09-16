import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TriageLabel } from "../core/types.js";
import {
  projectStatusForLabel as projectStatusForPipelineLabel,
  projectStatusForStage as projectStatusForPipelineStage,
} from "../../runtime/pipeline-definition.mjs";
import type { ProjectStatus as PipelineProjectStatus } from "../../runtime/pipeline-definition.mjs";

const exec = promisify(execFile);

export type ProjectStatus = PipelineProjectStatus;

export type GitHubCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const runCommand: GitHubCommandRunner = async (command, args, options = {}) => {
  const result = await exec(command, args, options);
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
};

export interface ProjectSyncResult {
  projectsFound: number;
  itemsAdded: number;
  itemsUpdated: number;
  warnings: string[];
}

interface ProjectField {
  id: string;
  name: string;
  options?: Array<{ id: string; name: string }>;
}

interface ProjectInfo {
  id: string;
  title: string;
  fields: { nodes: Array<ProjectField | null> };
}

interface ProjectItem {
  id: string;
  project: ProjectInfo;
}

export function projectStatusForLabel(label: TriageLabel): ProjectStatus {
  const status = projectStatusForPipelineLabel(label);
  if (!status) throw new Error(`Unknown pipeline label: ${label}`);
  return status;
}

export function projectStatusForStage(stage: string): ProjectStatus | undefined {
  return projectStatusForPipelineStage(stage) ?? undefined;
}

/**
 * Add an issue to every ProjectV2 linked to its repository and set Status.
 * Existing project items are updated as well, including items added by a
 * human before the project was linked to the repository.
 */
export async function syncIssueProjectStatus(
  opts: { repo: string; issueNumber: number; status: ProjectStatus; token: string },
  run: GitHubCommandRunner = runCommand,
): Promise<ProjectSyncResult> {
  const [owner, name, extra] = opts.repo.split("/");
  if (!owner || !name || extra) throw new Error(`Invalid GitHub repository: ${opts.repo}`);
  const env = { ...process.env, GH_TOKEN: opts.token };
  const context = await graphql<ProjectContextResponse>(run, PROJECT_CONTEXT_QUERY, {
    owner,
    name,
    number: opts.issueNumber,
  }, env);
  const repository = context.data?.repository;
  if (!repository?.issue?.id) throw new Error(`GitHub issue #${opts.issueNumber} was not found in ${opts.repo}`);

  const currentItems = new Map<string, ProjectItem>();
  for (const item of repository.issue.projectItems.nodes ?? []) {
    if (item?.project?.id) currentItems.set(item.project.id, item);
  }
  const projects = new Map<string, ProjectInfo>();
  for (const project of repository.projectsV2.nodes ?? []) {
    if (project?.id) projects.set(project.id, project);
  }
  for (const item of currentItems.values()) projects.set(item.project.id, item.project);

  const result: ProjectSyncResult = {
    projectsFound: projects.size,
    itemsAdded: 0,
    itemsUpdated: 0,
    warnings: [],
  };

  for (const project of projects.values()) {
    // GraphQL returns fields as nullable nodes; both `field` and `field.name`
    // can be missing, so every property access has to be optional — otherwise
    // a single null entry in the array crashes the whole sync with
    // `Cannot read properties of undefined (reading 'toLowerCase')`.
    const statusField = project.fields.nodes.find((field) => field?.name?.toLowerCase() === "status");
    const option = statusField?.options?.find((entry) => normalizeStatus(entry.name) === normalizeStatus(opts.status));
    if (!statusField || !option) {
      result.warnings.push(`Project ${project.title} has no Status option named ${opts.status}`);
      continue;
    }

    let itemId = currentItems.get(project.id)?.id;
    if (!itemId) {
      const added = await graphql<AddItemResponse>(run, ADD_ITEM_MUTATION, {
        project: project.id,
        content: repository.issue.id,
      }, env);
      itemId = added.data?.addProjectV2ItemById?.item?.id;
      if (!itemId) throw new Error(`GitHub did not add issue #${opts.issueNumber} to Project ${project.title}`);
      result.itemsAdded += 1;
    }

    const updated = await graphql<UpdateStatusResponse>(run, UPDATE_STATUS_MUTATION, {
      project: project.id,
      item: itemId,
      field: statusField.id,
      option: option.id,
    }, env);
    if (updated.data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) {
      throw new Error(`GitHub did not confirm Status=${opts.status} for issue #${opts.issueNumber} in Project ${project.title}`);
    }
    result.itemsUpdated += 1;
  }

  return result;
}

function normalizeStatus(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

async function graphql<T>(
  run: GitHubCommandRunner,
  query: string,
  variables: Record<string, string | number>,
  env: NodeJS.ProcessEnv,
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const output = await run("gh", args, { env });
  const parsed = JSON.parse(output.stdout || "{}") as T & { errors?: Array<{ message?: string }> };
  if (parsed.errors?.length) {
    throw new Error(parsed.errors.map((error) => error.message || "Unknown GraphQL error").join("; "));
  }
  return parsed;
}

interface ProjectContextResponse {
  data?: {
    repository?: {
      issue?: { id: string; projectItems: { nodes: Array<ProjectItem | null> } };
      projectsV2: { nodes: Array<ProjectInfo | null> };
    };
  };
}

interface AddItemResponse {
  data?: { addProjectV2ItemById?: { item?: { id: string } } };
}

interface UpdateStatusResponse {
  data?: { updateProjectV2ItemFieldValue?: { projectV2Item?: { id: string } } };
}

const PROJECT_FIELDS = `
  id
  title
  fields(first: 100) {
    nodes {
      ... on ProjectV2SingleSelectField {
        id
        name
        options { id name }
      }
    }
  }
`;

const PROJECT_CONTEXT_QUERY = `
query ProjectContext($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      projectItems(first: 100) {
        nodes {
          id
          project { ${PROJECT_FIELDS} }
        }
      }
    }
    projectsV2(first: 100) {
      nodes { ${PROJECT_FIELDS} }
    }
  }
}`;

const ADD_ITEM_MUTATION = `
mutation AddProjectItem($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
    item { id }
  }
}`;

const UPDATE_STATUS_MUTATION = `
mutation UpdateProjectStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project
    itemId: $item
    fieldId: $field
    value: { singleSelectOptionId: $option }
  }) {
    projectV2Item { id }
  }
}`;
