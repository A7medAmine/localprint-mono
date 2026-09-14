// Generates the super-admin password hash for the /platform-admin console.
//
// Usage:
//   node scripts/admin-password.js "my super secret password"
//   node scripts/admin-password.js "my password" --username ahmed
//   node scripts/admin-password.js "my password" --write       (appends to .env)
//
// The plaintext password is never stored — only the scrypt hash goes in the
// environment, so a leaked .env does not hand over the console.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from '../auth/adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

const args = process.argv.slice(2);
const write = args.includes('--write');
const userIdx = args.indexOf('--username');
const username = userIdx !== -1 ? args[userIdx + 1] : 'admin';
const password = args.filter((a, i) => !a.startsWith('--') && i !== userIdx + 1)[0];

if (!password) {
  console.error('Usage: node scripts/admin-password.js "<password>" [--username admin] [--write]');
  process.exit(1);
}
if (password.length < 10) {
  console.error('✖ Use at least 10 characters — this password is the whole platform.');
  process.exit(1);
}

const hash = hashPassword(password);
const lines = [
  `PLATFORM_ADMIN_USERNAME=${username}`,
  `PLATFORM_ADMIN_PASSWORD_HASH=${hash}`,
];

if (write) {
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  // Replace existing keys in place so repeated runs do not stack duplicates.
  for (const line of lines) {
    const key = line.slice(0, line.indexOf('='));
    const re = new RegExp(`^${key}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, line) : `${env.replace(/\s*$/, '')}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, env.startsWith('\n') ? env.slice(1) : env);
  console.log(`✅ Written to ${ENV_PATH}`);
  console.log(`   Username: ${username}`);
  console.log('   Restart the server, then open /platform-admin.\n');
} else {
  console.log('\nAdd these to your .env (or the host\'s environment variables):\n');
  console.log(lines.join('\n'));
  console.log('\nThen restart the server and open /platform-admin.\n');
}
