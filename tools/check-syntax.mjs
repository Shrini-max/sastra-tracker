import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const file of ['app.js']) {
  const source = readFileSync(file, 'utf8');
  new vm.Script(source, { filename: file });
}

console.log('Syntax check passed.');
