// Startup environment validation.
//
// db.js and the token-encryption layer throw at import time when a required
// var is missing or malformed. Under Electron that surfaces as a white screen
// with nothing in the UI and nothing obvious in the logs. Run checkEnv()
// FIRST — before importing anything that reads process.env — so the operator
// gets one readable list of what is wrong and how to fix each item.

const RULES = [
  {
    name: 'TOKEN_ENCRYPTION_KEY',
    required: true,
    validate: (v) => /^[0-9a-fA-F]{64}$/.test(v),
    hint: 'must be 64 hex chars (32 bytes). Generate one with:\n' +
          '        node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
          '        then add it to .env as TOKEN_ENCRYPTION_KEY=<value>\n' +
          '        (packaged builds generate this automatically under userData).',
  },
  {
    name: 'NODE_ENV',
    required: false,
    validate: (v) => ['development', 'production', 'test'].includes(v),
    hint: "expected 'development', 'production', or 'test'.",
  },
  {
    name: 'PORT',
    required: false,
    validate: (v) => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536,
    hint: 'must be a valid TCP port number (1-65535).',
  },
];

/**
 * @param {object} [opts]
 * @param {boolean} [opts.exit=true]   process.exit(1) on failure
 * @returns {string[]} list of problem messages (empty === all good)
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
