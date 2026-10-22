import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Vendor external relative dependencies inside this override. Different ejected
// adapters can then retain different baselines without sharing mutable helpers.
export function ejectAdapter(builtinRoot: string, userRoot: string, site: string, baselineVersion?: string): void {
  if (!/^[\w-]+$/.test(site)) throw new Error('Invalid adapter site');
  const source = resolve(builtinRoot, site), target = resolve(userRoot, site);
  if (existsSync(target)) throw new Error('Adapter override already exists');
  const files = new Map<string, string>();
  const destination = (file: string) => file.startsWith(source + sep)
    ? join(target, relative(source, file))
    : join(target, '_vendor', relative(resolve(builtinRoot), file));
  const visit = (file: string) => {
    if (files.has(file)) return;
    if (!file.startsWith(resolve(builtinRoot) + sep)) throw new Error('Adapter dependency escapes built-in directory');
    let text = readFileSync(file, 'utf8');
    files.set(file, text);
    if (/\.[cm]?js$/.test(file)) {
      text = text.replace(/((?:\bfrom\s*|\bimport\s*\(?\s*)['"])(\.[^'"]+)(['"])/g, (match, prefix, specifier, suffix) => {
        const dependency = resolve(dirname(file), specifier);
        if (!/\.[cm]?js$/.test(dependency)) throw new Error(`Unsupported adapter dependency: ${specifier}`);
        visit(dependency);
        let rewritten = relative(dirname(destination(file)), destination(dependency)).split(sep).join('/');
        if (!rewritten.startsWith('.')) rewritten = './' + rewritten;
        return prefix + rewritten + suffix;
      });
      files.set(file, text);
    }
  };
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && /\.[cm]?js$/.test(item.name)) visit(file);
    }
  };
  walk(source); // Resolve everything before writing an override.
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  for (const [file, text] of files) {
    mkdirSync(dirname(destination(file)), { recursive: true });
    writeFileSync(destination(file), text);
  }
  writeFileSync(join(target, 'bycli-eject.json'), JSON.stringify({ site, baselineVersion, dependencies: [...files.keys()].map(file => relative(builtinRoot, file)) }, null, 2));
}
