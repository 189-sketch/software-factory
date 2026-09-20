export interface PanelApiResult {
  status: number;
  body: unknown;
}

export function handlePanelApi(
  root: string,
  request: { method?: string; pathname?: string },
  options?: { includeGitHub?: boolean; skillsRoot?: string },
): Promise<PanelApiResult>;
