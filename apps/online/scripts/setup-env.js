#!/usr/bin/env node
// Interactive .env generator for both Atba3li apps.
//
//   node apps/online/scripts/setup-env.js            # asks about both apps
//   node apps/online/scripts/setup-env.js --online   # cloud app only
//   node apps/online/scripts/setup-env.js --desktop  # desktop app only
//   node apps/online/scripts/setup-env.js --print    # show, don't write
//
// Unlike the old copy-.env.example-and-guess flow, this asks one question per
// variable, explains what it is and where to find it, validates the answer
// before accepting it, and can generate the random/derived values itself
// (admin password hash, bearer tokens, encryption keys).
//
// Existing .env values are read first and offered as the default, so re-running
// this to add one missing variable does not make you retype the rest. Secrets
// are never echoed back in full.
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { hashPassword } from '../auth/adminAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONLINE_DIR = path.join(__dirname, '..');
const DESKTOP_DIR = path.join(__dirname, '..', '..', 'desktop');

const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const onlyOnline = args.includes('--online');
const onlyDesktop = args.includes('--desktop');

// ── tiny prompt helpers ───────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY,
});

// A line queue rather than rl.question(): when stdin is a pipe (a scripted
// run) the whole input arrives in one chunk, and every line that lands while
// no question happens to be pending would otherwise be dropped on the floor.
const waiting = [];
const buffered = [];
rl.on('line', (line) => {
  const resolve = waiting.shift();
  if (resolve) resolve(line);
  else buffered.push(line);
});
rl.on('close', () => { while (waiting.length) waiting.shift()(''); });

const readLine = () => new Promise((resolve) => {
  if (buffered.length) resolve(buffered.shift());
  else waiting.push(resolve);
});

const ask = async (q) => {
  process.stdout.write(q);
  return readLine();
};

// Reads a line without echoing it, so a pasted service_role key or password
// does not end up in the terminal scrollback.
const askHidden = async (q) => {
  process.stdout.write(q);
  const origWrite = rl._writeToOutput;
  rl._writeToOutput = () => {};
  try {
    return await readLine();
  } finally {
    rl._writeToOutput = origWrite;
    process.stdout.write('\n');
  }
};

const mask = (v) => {
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
};

const yesNo = async (question, def = true) => {
  const hint = def ? 'Y/n' : 'y/N';
  const a = (await ask(`${question} [${hint}] `)).trim().toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
};

/**
 * Ask for one variable until the answer validates.
 * @param {object} field
 * @param {string} [current] value already present in the .env
 */
async function askField(field, current) {
  const { name, help, secret, validate, generate, optional, default: fallback } = field;

  console.log(`\n  ${name}`);
  help.split('\n').forEach((line) => console.log(`    ${line}`));

  const shown = current ? (secret ? mask(current) : current) : fallback;
  if (current) {
    if (await yesNo(`    Keep current value (${shown})?`)) return current;
  }

  for (;;) {
    let answer;
    if (generate) {
      const how = (await ask(`    [g] generate  [t] type it${optional ? '  [s] skip' : ''} > `))
        .trim().toLowerCase() || 'g';
      if (how === 's' && optional) return '';
      if (how === 'g') {
        const value = await generate();
        console.log(`    → generated ${secret ? mask(value) : value}`);
        return value;
      }
    }

    answer = secret
      ? (await askHidden(`    value (hidden): `)).trim()
      : (await ask(`    value${fallback ? ` [${fallback}]` : ''}: `)).trim();

    if (!answer && fallback) answer = fallback;
    if (!answer) {
      if (optional) return '';
      console.log('    ✖ required — try again.');
      continue;
    }
    const problem = validate ? validate(answer) : null;
    if (problem) {
      console.log(`    ✖ ${problem}`);
      continue;
    }
    return answer;
  }
}

// ── .env read/write ───────────────────────────────────────────────────────

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// Rewrites values in place so comments and ordering survive, and appends
// anything new at the end. Never drops keys the user added by hand.
function mergeEnvFile(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    if (value === '') continue;
    const line = `${key}=${value}`;
    // Only horizontal whitespace around the key: `\s` would swallow the
    // preceding newline and glue this line onto the one before it. And
    // `[^\r\n]*` rather than `.*$`, so a CRLF file does not keep a stray \r.
    const re = new RegExp(`^[ \\t]*#?[ \\t]*${key}[ \\t]*=[^\\r\\n]*`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  }
  return text.replace(/^\n+/, '');
}

// ── field definitions ─────────────────────────────────────────────────────

const hex32 = () => randomBytes(32).toString('hex');

const ONLINE_FIELDS = [
  {
    name: 'SUPABASE_URL',
    help: 'Supabase project URL.\nSupabase dashboard → Project Settings → API → Project URL.',
    validate: (v) => /^https:\/\/.+\.supabase\.(co|in)\/?$/.test(v)
      ? null : 'expected something like https://xxxx.supabase.co',
  },
  {
    name: 'SUPABASE_SERVICE_KEY',
    help: 'Supabase service_role key (Project Settings → API).\nNOT the anon/publishable key — this one bypasses RLS, so it stays server-side.',
    secret: true,
    validate: (v) => v.length > 30 ? null : 'that looks too short for a service_role key',
  },
  {
    name: 'PLATFORM_ADMIN_USERNAME',
    help: 'Login name for the /platform-admin console (create shops, rotate tokens).',
    default: 'admin',
    validate: (v) => v.length >= 3 ? null : 'at least 3 characters',
  },
  {
    name: 'PLATFORM_ADMIN_PASSWORD_HASH',
    help: 'Super-admin password. Only its scrypt hash is stored — the plaintext\nnever touches .env, so a leaked file does not hand over the console.',
    secret: true,
    generate: async () => {
      for (;;) {
        const pw = (await askHidden('    new password (hidden, min 10 chars): ')).trim();
        if (pw.length < 10) { console.log('    ✖ at least 10 characters — this password is the whole platform.'); continue; }
        const again = (await askHidden('    confirm: ')).trim();
        if (pw !== again) { console.log('    ✖ they do not match.'); continue; }
        return hashPassword(pw);
      }
    },
    validate: (v) => v.startsWith('scrypt:')
      ? null : 'must be a scrypt hash — pick [g] and let this script make one',
  },
  {
    name: 'PLATFORM_ADMIN_TOKEN',
    help: 'Optional. Machine bearer for /api/admin/* (scripts, curl, CI).\nThe browser console does not need it — skip unless you automate provisioning.',
    secret: true,
    optional: true,
    generate: async () => hex32(),
    validate: (v) => v.length >= 16 ? null : 'at least 16 characters',
  },
  {
    name: 'VITE_SUPABASE_URL',
    help: 'Optional — enables customer accounts (login, saved profile, order history).\nSame project URL as above. Read at BUILD time by Vite, not at runtime.\nSkip to run guest-upload only.',
    optional: true,
    validate: (v) => /^https:\/\/.+\.supabase\.(co|in)\/?$/.test(v)
      ? null : 'expected something like https://xxxx.supabase.co',
  },
  {
    name: 'VITE_SUPABASE_ANON_KEY',
    help: 'Optional — the anon/publishable key (Project Settings → API).\nThis one ships to every browser, so it must NOT be the service_role key.',
    secret: true,
    optional: true,
    validate: (v) => v.length > 30 ? null : 'that looks too short for an anon key',
  },
  {
    name: 'PUBLIC_URL',
    help: 'Optional. Public origin of this deployment, e.g. https://cloud.example.com.\nUsed by scripts/create-shop.js to print each shop\'s upload link.',
    optional: true,
    validate: (v) => /^https?:\/\/.+/.test(v) ? null : 'expected a full URL with scheme',
  },
];

const DESKTOP_FIELDS = [
  {
    name: 'TOKEN_ENCRYPTION_KEY',
    help: '32 random bytes, hex-encoded. Encrypts the stored Gmail OAuth tokens.\nChanging it later invalidates any token already saved.',
    secret: true,
    generate: async () => hex32(),
    validate: (v) => /^[0-9a-f]{64}$/i.test(v) ? null : 'expected 64 hex characters (32 bytes)',
  },
  {
    name: 'GOOGLE_CLIENT_ID',
    help: 'Optional — only needed for the Gmail integration.\nGoogle Cloud Console → APIs & Services → Credentials → OAuth client ID.',
    optional: true,
    validate: (v) => v.includes('.apps.googleusercontent.com')
      ? null : 'expected an ID ending in .apps.googleusercontent.com',
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    help: 'Optional — the client secret for the OAuth client above.',
    secret: true,
    optional: true,
    validate: (v) => v.length >= 10 ? null : 'that looks too short',
  },
  {
    name: 'GMAIL_REDIRECT_URI',
    help: 'Optional — must match a redirect URI registered on that OAuth client.\nThe packaged Electron build overrides this with its own port at runtime.',
    optional: true,
    default: 'http://localhost:3001/api/gmail/callback',
    validate: (v) => /^https?:\/\/.+/.test(v) ? null : 'expected a full URL with scheme',
  },
];

// ── run ───────────────────────────────────────────────────────────────────

async function configure(label, dir, fields) {
  const file = path.join(dir, '.env');
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`${label}  →  ${file}`);
  console.log('─'.repeat(68));

  const current = readEnvFile(file);
  const values = {};
  for (const field of fields) {
    values[field.name] = await askField(field, current[field.name]);
  }

  const merged = mergeEnvFile(file, values);
  const set = Object.entries(values).filter(([, v]) => v !== '').map(([k]) => k);
  const skipped = Object.entries(values).filter(([, v]) => v === '').map(([k]) => k);

  if (printOnly) {
    console.log(`\n--- ${file} (not written, --print) ---\n`);
    console.log(merged);
    return;
  }

  fs.writeFileSync(file, merged);
  console.log(`\n✅ Wrote ${file}`);
  console.log(`   set:     ${set.join(', ') || '(nothing)'}`);
  if (skipped.length) console.log(`   skipped: ${skipped.join(', ')}`);
}

console.log('\nAtba3li environment setup');
console.log('Answers are validated as you go; press Enter to take the [default].');
if (printOnly) console.log('--print: nothing will be written to disk.');

try {
  if (!onlyDesktop) await configure('Cloud app (apps/online)', ONLINE_DIR, ONLINE_FIELDS);
  if (!onlyOnline && fs.existsSync(DESKTOP_DIR)) {
    if (onlyDesktop || await yesNo('\nAlso configure the desktop app (apps/desktop)?', false)) {
      await configure('Desktop app (apps/desktop)', DESKTOP_DIR, DESKTOP_FIELDS);
    }
  }

  console.log('\nNext:');
  console.log('  1. Apply the schema:  supabase db push');
  console.log('     (or paste apps/online/supabase/migrations/001_initial_schema.sql into the SQL editor)');
  console.log('  2. Create a shop:     node apps/online/scripts/create-shop.js "Shop Name"');
  console.log('  3. Start the server:  npm run dev -w @atba3li/online\n');
} finally {
  rl.close();
}
