import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { projects } from '../content/projects.js';
for (const file of ['index.html','assets/js/portal.js','assets/js/auth.js','server/auth.mjs','.gitmodules']) assert.ok(existsSync(file),file);
for (const project of projects) {
  if(project.href.startsWith('./')) assert.ok(existsSync(project.href),project.href);
}
assert.ok(!readFileSync('index.html','utf8').includes('content/users.js'));
const result=spawnSync(process.execPath,['scripts/validate.mjs'],{cwd:'projects/agent-learning',stdio:'inherit'});
process.exitCode=result.status??1;
