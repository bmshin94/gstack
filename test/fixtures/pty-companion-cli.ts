import fs from 'node:fs'; import path from 'node:path';
const config = process.env.CLAUDE_CONFIG_DIR;
console.log('COMPANION_SETTINGS ' + JSON.stringify({ settings: JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8')), args: process.argv.slice(2) }));
setTimeout(() => process.exit(0), 3000);
