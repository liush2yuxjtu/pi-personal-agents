import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const OUTPUT_STYLES = ['default', 'concise', 'proactive', 'explanatory', 'learning'] as const;
export type OutputStyle = typeof OUTPUT_STYLES[number];
export interface Preferences { outputStyle: OutputStyle; language: string }

const DEFAULTS: Preferences = { outputStyle: 'proactive', language: '简体中文' };
const STYLE_INSTRUCTIONS: Record<OutputStyle, string> = {
  default: 'Use the standard efficient personal engineering assistant style.',
  concise: 'Lead with the result. Keep explanations short. Expand only when the user asks or missing detail would create risk.',
  proactive: 'Execute immediately when safe. Make reasonable assumptions instead of pausing for routine decisions. Prefer action over planning, but never bypass authorization, consent, payment, security, or irreversible-action boundaries. Lead with the result and stay concise unless detail is needed.',
  explanatory: 'Complete the task and include short educational Insights that explain important implementation choices and codebase patterns. Do not let teaching block progress.',
  learning: 'Use a collaborative learn-by-doing style. Explain important choices and invite the user to contribute small strategic pieces, but do not delegate routine work or machine-checkable verification to the user.',
};

export function isOutputStyle(value: string): value is OutputStyle { return value === 'default' || value === 'concise' || value === 'proactive' || value === 'explanatory' || value === 'learning'; }
export function validateLanguage(value: string): string {
  const language = value.trim();
  if (!language || language.length > 40 || !/^[\p{L}\p{M}0-9 _-]+$/u.test(language)) throw new Error('Language must be a simple language name or code');
  return language;
}
export function buildStyledInstructions(base: string, preferences: Preferences): string {
  return `${base.trim()}\n\nOutput style: ${preferences.outputStyle}\n${STYLE_INSTRUCTIONS[preferences.outputStyle]}\n\nLanguage: Always respond in ${preferences.language}. Keep code, commands, paths, identifiers, and faithful source quotations unchanged when needed.`;
}
export async function loadPreferences(path: string): Promise<Preferences> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const parsed = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
    const outputStyle = 'outputStyle' in parsed && typeof parsed.outputStyle === 'string' && isOutputStyle(parsed.outputStyle) ? parsed.outputStyle : DEFAULTS.outputStyle;
    const language = 'language' in parsed && typeof parsed.language === 'string' ? validateLanguage(parsed.language) : DEFAULTS.language;
    return { outputStyle, language };
  } catch { return { ...DEFAULTS }; }
}
export async function savePreferences(path: string, preferences: Preferences): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
}
