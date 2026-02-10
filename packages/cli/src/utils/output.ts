export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printSection(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

export function printLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function printKeyValue(key: string, value: string): void {
  process.stdout.write(`${key.padEnd(22)} ${value}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`Error: ${message}\n`);
}

export function printHuman(value: unknown): void {
  if (value === undefined || value === null) {
    printLine('No output.');
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    printLine(String(value));
    return;
  }

  if (Array.isArray(value)) {
    printKeyValue('Count', String(value.length));
    printSection('Items');
    printJson(value);
    return;
  }

  const root = { ...(value as Record<string, unknown>) };
  const metadata = asRecord(root.metadata);
  const warnings = collectWarnings(root);
  const errorMessage = extractErrorMessage(root.error);
  const data = root.data;

  if (typeof root.success === 'boolean') {
    printKeyValue('Success', String(root.success));
    delete root.success;
  }
  if (typeof root.authenticated === 'boolean') {
    printKeyValue('Authenticated', String(root.authenticated));
    delete root.authenticated;
  }
  if (typeof root.source === 'string') {
    printKeyValue('Source', root.source);
    delete root.source;
  }
  if (typeof root.degraded === 'boolean') {
    printKeyValue('Degraded', String(root.degraded));
    delete root.degraded;
  }
  if (typeof root.defaultTarget === 'string') {
    printKeyValue('Default target', root.defaultTarget);
    delete root.defaultTarget;
  }

  if (metadata) {
    if (typeof metadata.selectedMode === 'string') {
      printKeyValue('Selected target', metadata.selectedMode);
    }
    if (typeof metadata.requestedMode === 'string') {
      printKeyValue('Requested target', metadata.requestedMode);
    }
    if (typeof metadata.fallbackApplied === 'boolean') {
      printKeyValue('Fallback', metadata.fallbackApplied ? 'yes' : 'no');
    }
    if (typeof metadata.fallbackReason === 'string') {
      printKeyValue('Fallback reason', metadata.fallbackReason);
    }
    if (typeof metadata.deviceId === 'string') {
      printKeyValue('Device', metadata.deviceId);
    }
    if (typeof metadata.requestId === 'string') {
      printKeyValue('Request ID', metadata.requestId);
    }
    if (typeof metadata.attempt === 'number') {
      printKeyValue('Attempt', String(metadata.attempt));
    }
    delete root.metadata;
  }

  if (errorMessage) {
    printSection('Error');
    printLine(errorMessage);
    delete root.error;
  }

  if (warnings.length > 0) {
    printSection('Warnings');
    for (const warning of warnings) {
      printLine(`- ${warning}`);
    }
  }

  if (data !== undefined) {
    printSection('Result');
    if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
      printLine(String(data));
    } else {
      printJson(data);
    }
    delete root.data;
  }

  if (Object.keys(root).length > 0) {
    printSection('Details');
    printJson(root);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function collectWarnings(record: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (typeof record.warning === 'string') {
    warnings.push(record.warning);
    delete record.warning;
  }

  if (Array.isArray(record.warnings)) {
    for (const item of record.warnings) {
      if (typeof item === 'string' && item.trim().length > 0) {
        warnings.push(item.trim());
      }
    }
    delete record.warnings;
  }

  return warnings;
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const asErr = value as Record<string, unknown>;
  if (typeof asErr.message === 'string') {
    return asErr.message;
  }
  if (typeof asErr.error === 'string') {
    return asErr.error;
  }
  if (typeof asErr.error === 'object' && asErr.error !== null && typeof (asErr.error as Record<string, unknown>).message === 'string') {
    return (asErr.error as Record<string, string>).message;
  }
  return undefined;
}
