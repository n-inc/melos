import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getPromptsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, '..', '..', 'prompts');
}

export function getDefaultPromptsDir(): string {
  return getPromptsDir();
}

export async function loadPromptFromPath(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  return await readFile(filePath, 'utf-8');
}
