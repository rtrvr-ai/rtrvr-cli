import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export type SecureStoreBackend = 'keychain' | 'secret-service' | 'none';

export interface SecureLookupResult {
  value?: string;
  backend: SecureStoreBackend;
}

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = process.env.RTRVR_KEYCHAIN_SERVICE ?? 'rtrvr-cli';
const KEYCHAIN_ACCOUNT = process.env.RTRVR_KEYCHAIN_ACCOUNT ?? 'default';

export async function getSecureApiKey(): Promise<SecureLookupResult> {
  const backend = await detectSecureStoreBackend();
  if (backend === 'none') {
    return { backend };
  }

  if (backend === 'keychain') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
      ]);
      const value = stdout.trim();
      return value ? { value, backend } : { backend };
    } catch {
      return { backend };
    }
  }

  try {
    const result = await runWithOptionalInput('secret-tool', [
      'lookup',
      'service',
      KEYCHAIN_SERVICE,
      'account',
      KEYCHAIN_ACCOUNT,
    ]);
    const value = result.stdout.trim();
    return value ? { value, backend } : { backend };
  } catch {
    return { backend };
  }
}

export async function setSecureApiKey(value: string): Promise<{ stored: boolean; backend: SecureStoreBackend }> {
  const backend = await detectSecureStoreBackend();
  if (backend === 'none') {
    return { stored: false, backend };
  }

  if (backend === 'keychain') {
    await execFileAsync('security', [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
      value,
    ]);
    return { stored: true, backend };
  }

  await runWithOptionalInput(
    'secret-tool',
    [
      'store',
      '--label',
      'RTRVR CLI API Key',
      'service',
      KEYCHAIN_SERVICE,
      'account',
      KEYCHAIN_ACCOUNT,
    ],
    value,
  );

  return { stored: true, backend };
}

export async function clearSecureApiKey(): Promise<{ cleared: boolean; backend: SecureStoreBackend }> {
  const backend = await detectSecureStoreBackend();
  if (backend === 'none') {
    return { cleared: false, backend };
  }

  if (backend === 'keychain') {
    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
      ]);
    } catch {
      // Nothing to clear; treat as success.
    }
    return { cleared: true, backend };
  }

  try {
    await runWithOptionalInput('secret-tool', [
      'clear',
      'service',
      KEYCHAIN_SERVICE,
      'account',
      KEYCHAIN_ACCOUNT,
    ]);
  } catch {
    // Nothing to clear; treat as success.
  }

  return { cleared: true, backend };
}

export async function detectSecureStoreBackend(): Promise<SecureStoreBackend> {
  if (process.platform === 'darwin') {
    return 'keychain';
  }

  if (process.platform === 'linux') {
    const hasSecretTool = await commandExists('secret-tool');
    return hasSecretTool ? 'secret-service' : 'none';
  }

  return 'none';
}

async function commandExists(commandName: string): Promise<boolean> {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(command, [commandName]);
    return true;
  } catch {
    return false;
  }
}

async function runWithOptionalInput(
  command: string,
  args: string[],
  inputText?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `${command} exited with code ${code ?? 'unknown'}`));
    });

    if (inputText !== undefined) {
      child.stdin.write(inputText);
    }
    child.stdin.end();
  });
}
