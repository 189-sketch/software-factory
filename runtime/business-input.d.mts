export interface BusinessIssueInput {
  number: number;
  title?: string;
  body?: string;
  state?: string;
  labels?: readonly (string | { name: string })[];
  comments?: ReadonlyArray<{ author?: string; body?: string; createdAt?: string }>;
}
export const FACTORY_COMMENT_MARKERS: readonly string[];
export function isFactoryComment(comment: { body?: string } | null | undefined): boolean;
export function businessInputHash(issue: BusinessIssueInput): string;
