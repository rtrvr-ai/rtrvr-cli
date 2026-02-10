import fs from 'node:fs/promises';

export async function maybeReadJsonFile(pathValue: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!pathValue) {
    return undefined;
  }

  const raw = await fs.readFile(pathValue, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

export function parseKeyValuePairs(values: string[] | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const value of values ?? []) {
    const index = value.indexOf('=');
    if (index === -1) {
      throw new Error(`Invalid --param '${value}'. Expected key=value.`);
    }

    const key = value.slice(0, index).trim();
    const raw = value.slice(index + 1).trim();

    if (!key) {
      throw new Error(`Invalid --param '${value}'. Key cannot be empty.`);
    }

    output[key] = parsePrimitive(raw);
  }

  return output;
}

export function parseJsonText(value: string | undefined, flagName: string): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse ${flagName} as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePrimitive(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;

  if (!Number.isNaN(Number(value)) && value.trim() !== '') {
    return Number(value);
  }

  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}
