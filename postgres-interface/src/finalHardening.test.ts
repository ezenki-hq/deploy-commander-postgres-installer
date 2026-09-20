import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : productionFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

function productionSource(): string {
  const sourceRoot = join(process.cwd(), 'src');
  return productionFiles(sourceRoot)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

it('contains no manager database, latest-run, or recovery implementation', () => {
  const source = productionSource();
  expect(source).not.toMatch(/databaseQuery|getLatestRun|object_hooks/i);
  expect(source).not.toMatch(/recovery required|recovery state|PostgresRecovery/i);
});

it('centralizes caller.start in the event tracker', () => {
  const files = productionFiles(join(process.cwd(), 'src'));
  const starts = files.filter((file) => readFileSync(file, 'utf8').includes('caller.start'));
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatch(/platform[\\/]runTracker\.ts$/);
});

it('keeps approval no-start assertions in both connection workflow tests', () => {
  const root = join(process.cwd(), 'src');
  for (const name of ['workflows/createConnection.test.ts', 'workflows/deleteConnection.test.ts']) {
    const source = readFileSync(join(root, name), 'utf8');
    expect(source).toMatch(/startAndWait\)\.not\.toHaveBeenCalled/);
  }
});

it('contains no browser alert or confirmation APIs', () => {
  expect(productionSource()).not.toMatch(/window\.(alert|confirm)\s*\(/);
});

it('keeps Tailwind wired through Vite and the application stylesheet', () => {
  const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
  const vite = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  expect(packageJson).toContain('@tailwindcss/vite');
  expect(vite).toContain('tailwindcss()');
  expect(css).toContain("@import 'tailwindcss'");
});

it('has App integration coverage for lifecycle transitions and both approvals', () => {
  const appTest = readFileSync(join(process.cwd(), 'src/app/App.test.tsx'), 'utf8');
  expect(appTest).toMatch(/transitions from Install to Teardown/i);
  expect(appTest).toMatch(/create approval before progress/i);
  expect(appTest).toMatch(/delete.*approval/i);
});
