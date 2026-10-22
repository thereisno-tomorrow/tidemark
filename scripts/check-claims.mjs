import fs from 'node:fs';
import path from 'node:path';

// Read-only checks. This checks references and wording, not the truth of a claim.
const root = path.resolve(process.argv[2] || process.cwd());
const docs = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE'];
const errors = [];
let rows = 0;
let references = 0;
let links = 0;
let requiredNegations = 0;
const forbidden = /\b(?:secure|prevents|tamper-proof|zero-trust|human-approved|cannot be bypassed|first|unique|audited|the only)\b/gi;
const slug = s => s.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
for (const doc of docs) {
  const text = fs.readFileSync(path.join(root, doc), 'utf8');
  if (doc === 'README.md' || doc === 'SECURITY.md') {
    // A5 explicitly requires this negative threat-model sentence. No positive use is allowed.
    const negative = 'It is not tamper-proof.';
    const checked = doc === 'SECURITY.md' ? text.replace(negative, () => { requiredNegations++; return ''; }) : text;
    for (const hit of checked.matchAll(forbidden)) errors.push(`${doc}: forbidden wording: ${hit[0]}`);
    const lines = text.split(/\r?\n/);
    let inClaims = false;
    let docRows = 0;
    for (const line of lines) {
      if (line.startsWith('| Behavior |')) { inClaims = true; continue; }
      if (!inClaims) continue;
      if (!line.startsWith('|')) { inClaims = false; continue; }
      if (/^\|\s*-/.test(line)) continue;
      rows++; docRows++;
      const cells = line.split('|').slice(1, -1);
      if (cells.length !== 3 || !cells[2].trim()) errors.push(`${doc}: missing adjacent limits: ${line}`);
      const evidence = cells[1] || '';
      const fileMatches = [...evidence.matchAll(/\]\((tests\/[^)#]+)(?:#[^)]*)?\)/g)];
      const testFiles = fileMatches.map(m => m[1]);
      if (!testFiles.length) errors.push(`${doc}: claim row lacks a linked test file`);
      const titles = [...evidence.matchAll(/`([^`]+)`/g)].map(m => m[1]);
      let named = 0;
      for (const title of titles) {
        if (title === 'provider.codex-config') {
          const found = testFiles.some(file => {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            return source.includes("'provider.codex-config'") && /t\.test\(id,/.test(source);
          });
          if (!found) errors.push(`${doc}: subtest title absent: ${title}`);
          references++;
          continue;
        }
        const found = testFiles.some(file => {
          if (!fs.existsSync(path.join(root, file))) return false;
          const source = fs.readFileSync(path.join(root, file), 'utf8');
          return [...source.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1\s*,/g)]
            .some(match => match[2] === title);
        });
        if (!found) errors.push(`${doc}: test title absent from linked files: ${title}`);
        else named++;
        references++;
      }
      if (!named) errors.push(`${doc}: claim row has no existing named test`);
    }
    const expected = doc === 'README.md' ? 13 : 5;
    if (docRows !== expected) errors.push(`${doc}: expected ${expected} claim rows; found ${docRows}`);
  }
  // Inline Markdown links used by these four documents; external links are not fetched.
  for (const match of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    links++;
    const [file, fragment] = target.split('#');
    const resolved = path.resolve(root, file || doc);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolved)) {
      errors.push(`${doc}: unresolved relative link: ${target}`);
      continue;
    }
    if (fragment) {
      const headings = [...fs.readFileSync(resolved, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => slug(m[1].trim()));
      if (!headings.includes(decodeURIComponent(fragment))) errors.push(`${doc}: unresolved heading: ${target}`);
    }
  }
}
console.log(`Claims lint: ${errors.length ? 'FAIL' : 'PASS'}`);
console.log(`Claim rows: ${rows}; test-title references: ${references}; relative links: ${links}`);
console.log(`Required negative threat-model sentence: ${requiredNegations}; positive forbidden terms allowed: 0`);
for (const error of errors) console.log(`ERROR: ${error}`);
console.log(`Errors: ${errors.length}`);
process.exitCode = errors.length ? 1 : 0;
