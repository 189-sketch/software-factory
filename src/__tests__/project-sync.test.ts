import test from "node:test";
import assert from "node:assert/strict";
import {
  projectStatusForLabel,
  projectStatusForStage,
  syncIssueProjectStatus,
  type GitHubCommandRunner,
} from "../github/project.js";

test("factory lifecycle maps to the five canonical Project statuses", () => {
  assert.equal(projectStatusForLabel("needs-info"), "Backlog");
  assert.equal(projectStatusForLabel("wait-to-implement"), "Backlog");
  assert.equal(projectStatusForLabel("ready-to-spec"), "Ready");
  assert.equal(projectStatusForLabel("ready-to-implement"), "Ready");
  assert.equal(projectStatusForLabel("changes-requested"), "In progress");
  assert.equal(projectStatusForLabel("review-needed"), "In review");
  assert.equal(projectStatusForLabel("verified"), "In review");
  assert.equal(projectStatusForStage("spec"), "In progress");
  assert.equal(projectStatusForStage("review-spec"), "In review");
  assert.equal(projectStatusForStage("implementation"), "In progress");
  assert.equal(projectStatusForStage("merge"), "In progress");
});

test("Project with a null field node is tolerated and skipped", async () => {
  // Regression: GitHub ProjectV2 can return `null` entries in
  // `ProjectV2SingleSelectField.fields.nodes` (e.g. when a field is being
  // deleted). The previous code crashed on `field?.name.toLowerCase()`
  // because the optional chain only covered `field`, not `name`.
  let crashed: unknown = null;
  const run: GitHubCommandRunner = async (_command, args) => {
    const query = valueAfter(args, "query=");
    if (query.includes("query ProjectContext")) {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: { id: "ISSUE", projectItems: { nodes: [] } },
              projectsV2: {
                nodes: [
                  {
                    id: "PROJECT",
                    title: "Factory",
                    // Mixed array: real field, null, real field. None of the
                    // non-null entries is a Status field, so the sync should
                    // record a warning and skip — not throw.
                    fields: {
                      nodes: [
                        null,
                        { id: "ASSIGNEE", name: "Assignees", options: [] },
                        null,
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
        stderr: "",
      };
    }
    throw new Error("unexpected GraphQL call");
  };

  try {
    const result = await syncIssueProjectStatus({
      repo: "acme/widget",
      issueNumber: 7,
      status: "In progress",
      token: "token",
    }, run);
    assert.equal(result.projectsFound, 1);
    assert.equal(result.itemsAdded, 0);
    assert.equal(result.itemsUpdated, 0);
    assert.deepEqual(result.warnings, [
      "Project Factory has no Status option named In progress",
    ]);
  } catch (error) {
    crashed = error;
  }
  assert.equal(crashed, null, `sync should not throw on null field nodes`);
});

test("linked Project receives the issue and requested Status", async () => {
  const calls: string[] = [];
  const run: GitHubCommandRunner = async (_command, args) => {
    const query = valueAfter(args, "query=");
    calls.push(query);
    if (query.includes("query ProjectContext")) {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: { id: "ISSUE", projectItems: { nodes: [] } },
              projectsV2: { nodes: [project("PROJECT")] },
            },
          },
        }),
        stderr: "",
      };
    }
    if (query.includes("mutation AddProjectItem")) {
      return { stdout: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "ITEM" } } } }), stderr: "" };
    }
    if (query.includes("mutation UpdateProjectStatus")) {
      return { stdout: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM" } } } }), stderr: "" };
    }
    throw new Error("unexpected GraphQL call");
  };

  const result = await syncIssueProjectStatus({
    repo: "acme/widget",
    issueNumber: 7,
    status: "In progress",
    token: "token",
  }, run);

  assert.equal(result.projectsFound, 1);
  assert.equal(result.itemsAdded, 1);
  assert.equal(result.itemsUpdated, 1);
  assert.ok(calls.some((query) => query.includes("mutation AddProjectItem")));
  assert.ok(calls.some((query) => query.includes("mutation UpdateProjectStatus")));
});

test("repository without an enabled Project performs no mutation", async () => {
  let mutations = 0;
  const run: GitHubCommandRunner = async (_command, args) => {
    const query = valueAfter(args, "query=");
    if (query.includes("mutation")) mutations += 1;
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: { id: "ISSUE", projectItems: { nodes: [] } },
            projectsV2: { nodes: [] },
          },
        },
      }),
      stderr: "",
    };
  };

  const result = await syncIssueProjectStatus({
    repo: "acme/widget",
    issueNumber: 7,
    status: "Ready",
    token: "token",
  }, run);

  assert.equal(result.projectsFound, 0);
  assert.equal(result.itemsAdded, 0);
  assert.equal(result.itemsUpdated, 0);
  assert.equal(mutations, 0);
});

function project(id: string) {
  return {
    id,
    title: "Factory",
    fields: {
      nodes: [{
        id: "STATUS_FIELD",
        name: "Status",
        options: [
          { id: "BACKLOG", name: "Backlog" },
          { id: "READY", name: "Ready" },
          { id: "PROGRESS", name: "In progress" },
          { id: "REVIEW", name: "In review" },
          { id: "DONE", name: "Done" },
        ],
      }],
    },
  };
}

function valueAfter(args: string[], prefix: string): string {
  const value = args.find((arg) => arg.startsWith(prefix));
  return value?.slice(prefix.length) ?? "";
}
