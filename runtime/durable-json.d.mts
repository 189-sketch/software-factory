export function issueFile(root: string, directory: string, number: number): string;
export function readOptionalJson(file: string): Promise<Record<string, unknown> | null>;
export function writeDurableJson(file: string, value: unknown): Promise<void>;
export function removeOptionalFile(file: string): Promise<void>;
