import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { digest } from './allowlist.js';
import type { FormKind } from './types.js';

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const VERSION = /^[0-9][A-Za-z0-9._+-]{0,40}$/;

export type ComponentRef = { id: string; sha256: string };
export type ToolRef = { name: string; version: string | null };
export type McpRef = { id: string; version: string | null };

export type EnvironmentSnapshot = {
  id: string;
  captured_at: string;
  fingerprint: string;
  cursor_version: string | null;
  cli_version: string | null;
  model_id: string | null;
  os_family: 'linux' | 'darwin' | 'windows' | 'unknown';
  tools: ToolRef[];
  rules: ComponentRef[];
  skills: ComponentRef[];
  mcp_components: McpRef[];
  task_family: string;
  context: { form: FormKind; configuration_family: string | null };
};

function osFamily(platform: NodeJS.Platform): EnvironmentSnapshot['os_family'] {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

function safeVersion(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && VERSION.test(value) ? value : null;
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(dir: string, suffix: string, found: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!SAFE_ID.test(entry)) {
      continue;
    }
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      walk(full, suffix, found);
    } else if (entry.endsWith(suffix) && found.length < 200) {
      found.push(full);
    }
  }
}

function components(root: string, relative: string, suffix: string, idFrom: (file: string) => string): ComponentRef[] {
  const files: string[] = [];
  walk(path.join(root, relative), suffix, files);
  const items: ComponentRef[] = [];
  for (const file of files) {
    const id = idFrom(file);
    if (!SAFE_ID.test(id)) {
      continue;
    }
    items.push({ id, sha256: hashFile(file) });
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  return items;
}

export function captureSnapshot(input: {
  id: string;
  capturedAt: string;
  root: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  cursorVersion: string | null;
  cliVersion: string | null;
  modelId: string | null;
  family: string;
  form: FormKind;
  configurationFamily: string | null;
  mcpIds: readonly string[];
}): EnvironmentSnapshot {
  const rules = components(input.root, path.join('.cursor', 'rules'), '.mdc', (file) => path.basename(file));
  const skills = [
    ...components(input.root, path.join('.agents', 'skills'), 'SKILL.md', (file) => path.basename(path.dirname(file))),
    ...components(input.root, 'skill', 'SKILL.md', () => 'skill'),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const snapshot: EnvironmentSnapshot = {
    id: input.id,
    captured_at: input.capturedAt,
    fingerprint: '',
    cursor_version: safeVersion(input.cursorVersion),
    cli_version: safeVersion(input.cliVersion),
    model_id: input.modelId !== null && SAFE_ID.test(input.modelId) ? input.modelId : null,
    os_family: osFamily(input.platform),
    tools: [{ name: 'node', version: safeVersion(input.nodeVersion) }],
    rules,
    skills,
    mcp_components: input.mcpIds
      .filter((id) => SAFE_ID.test(id))
      .map((id) => ({ id, version: null })),
    task_family: input.family,
    context: {
      form: input.form,
      configuration_family: input.configurationFamily !== null && SAFE_ID.test(input.configurationFamily)
        ? input.configurationFamily
        : null,
    },
  };
  snapshot.fingerprint = digest(JSON.stringify({
    cursor_version: snapshot.cursor_version,
    cli_version: snapshot.cli_version,
    model_id: snapshot.model_id,
    os_family: snapshot.os_family,
    tools: snapshot.tools,
    rules: snapshot.rules,
    skills: snapshot.skills,
    mcp_components: snapshot.mcp_components,
    task_family: snapshot.task_family,
    context: snapshot.context,
  }));
  return snapshot;
}
