// Startup environment validation.
//
// db.js throws at import time when SUPABASE_URL / SUPABASE_SERVICE_KEY are
// missing, which on a host like Railway/Nixpacks shows up as an opaque crash
// loop. Run checkEnv() FIRST so the operator gets one readable list of what is
// wrong and how to fix each item.

const RULES = [
  {
    name: 'SUPABASE_URL',
    required: true,
    validate: (v) => /^https:\/\/.+\.supabase\.(co|in)/.test(v),
    hint: 'the project URL from Supabase → Project Settings → API (e.g. https://xxxx.supabase.co).',
  },
  {
    name: 'SUPABASE_SERVICE_KEY',
    required: true,
    validate: (v) => v.length > 30,
    hint: 'the service_role key from Supabase → Project Settings → API. Keep it server-side only.',
  },
  {
    name: 'PLATFORM_ADMIN_TOKEN',
    required: false,
    validate: (v) => v.length >= 16,
    hint: 'a long random string; machine bearer for the shop-provisioning endpoints (scripts/curl).',
  },
  {
    name: 'PLATFORM_ADMIN_USERNAME',
    required: false,
    validate: (v) => v.length >= 3,
    hint: 'the super-admin login name for /platform-admin (defaults to "admin").',
  },
  {
    name: 'PLATFORM_ADMIN_PASSWORD_HASH',
    required: false,
    validate: (v) => v.startsWith('scrypt:'),
    hint: 'generate with: node scripts/admin-password.js "<password>" — never store the plaintext.',
  },
  {
    name: 'PLATFORM_ADMIN_PASSWORD',
    required: false,
    validate: (v) => v.length >= 10,
    hint: 'plaintext dev-only fallback; prefer PLATFORM_ADMIN_PASSWORD_HASH in production.',
  },
  {
    name: 'NODE_ENV',
    required: false,
    validate: (v) => ['development', 'production', 'test'].includes(v),
    hint: "expected 'development', 'production', or 'test'.",
  },
];

/**
 * @param {object} [opts]
 * @param {boolean} [opts.exit=true]
 * @returns {string[]} problem messages (empty === all good)
 */
export function checkEnv({ exit = true } = {}) {
  const problems = [];
  for (const rule of RULES) {
    const val = process.env[rule.name];
    if (val === undefined || val === '') {
      if (rule.required) problems.push(`${rule.name} is not set — ${rule.hint}`);
      continue;
    }
    if (rule.validate && !rule.validate(val)) {
      problems.push(`${rule.name} is invalid — ${rule.hint}`);
    }
  }

  if (problems.length && exit) {
    console.error('\n✖ Cannot start — environment problems:\n');
    problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
    console.error('Fix the items above and start again.\n');
    process.exit(1);
  }

  return problems;
}
