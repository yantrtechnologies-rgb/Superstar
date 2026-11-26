// Prints a GitHub error annotation with the useful part of a CI log, so failures can be read without the job log
// (which needs a GitHub sign-in). For node --test output that is each failing test's block; otherwise the log's end.
// Usage: node scripts/ci-annotate.mjs <log file> <title>
import { existsSync, readFileSync } from 'node:fs';

const [file, title = 'CI output'] = process.argv.slice(2);
if (!file || !existsSync(file)) process.exit(0);
const lines = readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n|\r/);
const blocks = [];
lines.forEach((line, index) => {
  if (!/^\s*not ok \d+/.test(line)) return;
  const end = lines.findIndex((next, at) => at > index && /^\s*\.\.\.\s*$/.test(next));
  blocks.push(lines.slice(Math.max(0, index - 3), end === -1 ? index + 40 : end + 1).join('\n'));
});
const text = (blocks.length ? blocks.join('\n\n') : lines.filter((line) => line.trim()).slice(-80).join('\n')).slice(0, 12_000);
console.log(`::error title=${title}::` + text.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A'));
