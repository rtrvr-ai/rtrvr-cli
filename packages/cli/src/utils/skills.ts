import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

import type { RunMode, UnifiedRunRequest } from '@rtrvr-ai/sdk';

import { getSkillsDir } from './config.js';

export interface CliSkill {
  schemaVersion: '1';
  name: string;
  description?: string;
  defaultTarget?: RunMode;
  requiresLocalSession?: boolean;
  mcpTools?: string[];
  promptTemplate: string;
}

export interface BuiltinSkillTemplate extends CliSkill {
  id: string;
}

const BUILTIN_SKILL_TEMPLATES: BuiltinSkillTemplate[] = [
  {
    id: 'agent-web',
    schemaVersion: '1',
    name: 'agent-web',
    description: 'General-purpose planner-driven web agent skill for cloud or extension (CLI streams by default).',
    defaultTarget: 'auto',
    requiresLocalSession: false,
    mcpTools: ['planner', 'act_on_tab', 'extract_from_tab', 'crawl_and_extract_from_tab'],
    promptTemplate: [
      'You are rtrvr.ai agent. Complete this task end-to-end with robust planning.',
      'Task: {{input}}',
      'Return concise final result plus any key assumptions.',
    ].join('\n'),
  },
  {
    id: 'extension-session',
    schemaVersion: '1',
    name: 'extension-session',
    description: 'Force extension/browser-session execution for logged-in workflows.',
    defaultTarget: 'extension',
    requiresLocalSession: true,
    mcpTools: ['planner', 'act_on_tab', 'extract_from_tab'],
    promptTemplate: [
      'Use local browser session and execute in extension mode.',
      'Task: {{input}}',
      'If authentication is required on target sites, stay in local session and proceed.',
    ].join('\n'),
  },
  {
    id: 'bulk-scrape',
    schemaVersion: '1',
    name: 'bulk-scrape',
    description: 'Batch scrape/extract skill for multi-URL jobs (CLI streams by default).',
    defaultTarget: 'auto',
    requiresLocalSession: false,
    mcpTools: ['cloud_scrape', 'scrape', 'extract_from_tab', 'crawl_and_extract_from_tab'],
    promptTemplate: [
      'Gather structured data from the provided URLs with high recall.',
      'Task: {{input}}',
      'Prefer deterministic extraction and return machine-friendly JSON.',
    ].join('\n'),
  },
  {
    id: 'agent-api-first',
    schemaVersion: '1',
    name: 'agent-api-first',
    description: 'Force cloud /agent-first behavior for deterministic API execution (CLI streams by default).',
    defaultTarget: 'cloud',
    requiresLocalSession: false,
    mcpTools: ['cloud_agent'],
    promptTemplate: [
      'Use cloud API-first execution and complete task deterministically.',
      'Task: {{input}}',
      'Prefer structured machine-readable outputs when possible.',
    ].join('\n'),
  },
];

const TOOL_COMPATIBILITY_ALIASES: Record<string, string[]> = {
  scrape: ['scrape', 'cloud_scrape', 'get_page_data'],
  cloud_scrape: ['cloud_scrape', 'scrape'],
  get_page_data: ['get_page_data', 'scrape'],
  cloud_agent: ['cloud_agent', 'agent'],
  agent: ['agent', 'cloud_agent'],
};

export async function ensureSkillsDir(): Promise<string> {
  const dir = getSkillsDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function listSkills(): Promise<CliSkill[]> {
  const dir = await ensureSkillsDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });

  const skills: CliSkill[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliSkill>;
    skills.push(normalizeSkill(parsed));
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function addSkillFromFile(sourcePath: string): Promise<CliSkill> {
  const fileContent = await fs.readFile(sourcePath, 'utf8');
  const extension = path.extname(sourcePath).toLowerCase();

  let skill: CliSkill;

  if (extension === '.md' || extension === '.markdown') {
    skill = skillFromMarkdown(fileContent);
  } else if (extension === '.json') {
    skill = normalizeSkill(JSON.parse(fileContent) as Partial<CliSkill>);
  } else {
    throw new Error('Unsupported skill file. Use .md or .json.');
  }

  return saveSkill(skill);
}

export async function loadSkillByName(name: string): Promise<CliSkill> {
  const dir = await ensureSkillsDir();
  const targetPath = path.join(dir, `${sanitizeName(name)}.json`);

  const raw = await fs.readFile(targetPath, 'utf8');
  return normalizeSkill(JSON.parse(raw) as Partial<CliSkill>);
}

export function buildRunRequestFromSkill(skill: CliSkill, userInput: string, urls?: string[]): UnifiedRunRequest {
  const rendered = renderTemplate(skill.promptTemplate, userInput);
  const target = skill.defaultTarget ?? 'auto';

  return {
    input: rendered,
    urls,
    target,
    requireLocalSession: skill.requiresLocalSession ?? false,
  };
}

export async function saveSkill(skill: CliSkill): Promise<CliSkill> {
  const validated = normalizeSkill(skill);
  const dir = await ensureSkillsDir();
  const targetPath = path.join(dir, `${sanitizeName(validated.name)}.json`);
  await fs.writeFile(targetPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return validated;
}

export async function removeSkillByName(name: string): Promise<boolean> {
  const dir = await ensureSkillsDir();
  const targetPath = path.join(dir, `${sanitizeName(name)}.json`);

  try {
    await fs.unlink(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function listBuiltinSkillTemplates(): BuiltinSkillTemplate[] {
  return BUILTIN_SKILL_TEMPLATES.map((template) => ({ ...template }));
}

export function getBuiltinSkillTemplate(id: string): BuiltinSkillTemplate {
  const normalized = sanitizeName(id);
  const found = BUILTIN_SKILL_TEMPLATES.find((template) => template.id === normalized);
  if (!found) {
    const available = BUILTIN_SKILL_TEMPLATES.map((template) => template.id).join(', ');
    throw new Error(`Unknown skill template '${id}'. Available templates: ${available}`);
  }
  return { ...found };
}

export async function installBuiltinSkillTemplate(id: string, nameOverride?: string): Promise<CliSkill> {
  const template = getBuiltinSkillTemplate(id);
  const skill: CliSkill = {
    ...template,
    name: nameOverride?.trim() || template.name,
  };
  return saveSkill(skill);
}

export function renderSkillAsMarkdown(skill: CliSkill): string {
  const lines: string[] = ['---'];
  lines.push(`schemaVersion: ${JSON.stringify(skill.schemaVersion)}`);
  lines.push(`name: ${JSON.stringify(skill.name)}`);

  if (skill.description) {
    lines.push(`description: ${JSON.stringify(skill.description)}`);
  }
  if (skill.defaultTarget) {
    lines.push(`defaultTarget: ${skill.defaultTarget}`);
  }
  lines.push(`requiresLocalSession: ${String(skill.requiresLocalSession ?? false)}`);
  if (skill.mcpTools && skill.mcpTools.length > 0) {
    lines.push(`mcpTools: [${skill.mcpTools.map((item) => JSON.stringify(item)).join(', ')}]`);
  }
  lines.push('---', '', skill.promptTemplate.trim(), '');
  return lines.join('\n');
}

function skillFromMarkdown(content: string): CliSkill {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;

  return normalizeSkill({
    schemaVersion: toSchemaVersion(data.schemaVersion),
    name: toStringRequired(data.name, 'frontmatter.name'),
    description: toStringOptional(data.description),
    defaultTarget: toModeOptional(data.defaultTarget),
    requiresLocalSession: toBooleanOptional(data.requiresLocalSession),
    mcpTools: toStringArrayOptional(data.mcpTools),
    promptTemplate: parsed.content.trim(),
  });
}

export function validateSkillContent(skill: Partial<CliSkill>): CliSkill {
  return normalizeSkill(skill);
}

export function validateSkillToolCompatibility(skill: CliSkill, availableTools: string[]): {
  valid: boolean;
  missingTools: string[];
} {
  const required = skill.mcpTools ?? [];
  if (required.length === 0) {
    return { valid: true, missingTools: [] };
  }

  const supported = new Set(availableTools.map((tool) => tool.trim()).filter(Boolean));
  const missingTools = required.filter((tool) => !isToolSupported(tool, supported));
  return {
    valid: missingTools.length === 0,
    missingTools,
  };
}

function isToolSupported(tool: string, supported: Set<string>): boolean {
  const normalized = tool.trim();
  if (!normalized) {
    return true;
  }

  if (supported.has(normalized)) {
    return true;
  }

  const aliases = TOOL_COMPATIBILITY_ALIASES[normalized] ?? [];
  return aliases.some((alias) => supported.has(alias));
}

function normalizeSkill(skill: Partial<CliSkill>): CliSkill {
  if (!skill.name || skill.name.trim().length === 0) {
    throw new Error('Skill name is required.');
  }

  if (!skill.promptTemplate || skill.promptTemplate.trim().length === 0) {
    throw new Error('Skill promptTemplate/body is required.');
  }

  if (skill.defaultTarget && !['auto', 'cloud', 'extension'].includes(skill.defaultTarget)) {
    throw new Error(`Invalid skill defaultTarget '${skill.defaultTarget}'.`);
  }

  return {
    schemaVersion: skill.schemaVersion === '1' ? '1' : '1',
    name: skill.name.trim(),
    description: skill.description?.trim(),
    defaultTarget: skill.defaultTarget,
    requiresLocalSession: skill.requiresLocalSession ?? false,
    mcpTools: skill.mcpTools,
    promptTemplate: skill.promptTemplate.trim(),
  };
}

function renderTemplate(template: string, userInput: string): string {
  return template.replaceAll('{{input}}', userInput).replaceAll('{{user_input}}', userInput);
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'skill';
}

function toStringRequired(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required ${field}.`);
  }

  return value;
}

function toStringOptional(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toBooleanOptional(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toStringArrayOptional(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function toModeOptional(value: unknown): RunMode | undefined {
  if (value === 'auto' || value === 'cloud' || value === 'extension') {
    return value;
  }

  return undefined;
}

function toSchemaVersion(value: unknown): '1' | undefined {
  if (value === '1') {
    return '1';
  }
  return undefined;
}
