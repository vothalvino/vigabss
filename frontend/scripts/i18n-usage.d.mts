export function flatten(obj: Record<string, unknown>, prefix?: string): Record<string, unknown>;
export function findMissingKeys(): { file: string; line: number; key: string }[];
export function countLiteralStrings(): Promise<Record<string, number>>;
export const LITERAL_BASELINE_PATH: string;
export function literalRegressions(): Promise<{ file: string; count: number; baseline: number }[]>;
