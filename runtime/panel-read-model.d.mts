export interface PanelReadModel {
  projects(): Promise<{ projects: Array<Record<string, unknown>>; metrics: Record<string, unknown> }>;
  issues(projectId: string): Promise<Array<Record<string, any>>>;
  events(): Promise<Array<Record<string, any>>>;
  agents(): Promise<Array<Record<string, any>>>;
  settings(): Promise<Record<string, any>>;
  project(projectId: string): Record<string, unknown>;
}

export function createPanelReadModel(
  root: string,
  options?: { includeGitHub?: boolean; skillsRoot?: string },
): Promise<PanelReadModel>;
