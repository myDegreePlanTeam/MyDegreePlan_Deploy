const int = (v, d) => { const n = Number.parseInt(v ?? '', 10); return Number.isSafeInteger(n) ? n : d }

// Names default to the production stack; the overrides exist so a test copy of the
// stack (different volumes/project) can be updated without touching the real one.
export function loadConfig(env = process.env) {
  return {
    stateDir: env.STATE_DIR || '/state',
    updatesOff: (env.MDP_UPDATES || '').toLowerCase() === 'off',   // opt-out: MDP_UPDATES=off in .env
    updateUrl: (env.MDP_UPDATE_URL || '').replace(/\/+$/, ''),
    allowHttp: env.MDP_ALLOW_HTTP === '1',       // dev/test only; signatures are still required
    version: env.MDP_VERSION || 'dev',
    sequence: int(env.MDP_SEQUENCE, 0),
    project: env.MDP_PROJECT || 'mydegreeplan',
    dbVolume: env.MDP_DB_VOLUME || 'mdp_db_data',
    stateVolume: env.MDP_STATE_VOLUME || 'mdp_update_state',
    helperName: env.MDP_HELPER_NAME || 'mdp-updater-apply',
    helperImage: env.MDP_HELPER_IMAGE || '',
    jwtSecret: env.JWT_SECRET || '',
    port: int(env.MDP_PORT, 8080),
    listenPort: int(env.MDP_UPDATER_PORT, 8090),
    cliPort: int(env.MDP_UPDATER_CLI_PORT, 8091),
    pubKeyPath: env.MDP_RELEASE_PUBKEY || '/app/release-signing.pub.pem',
    checkEveryMs: int(env.MDP_CHECK_HOURS, 6) * 3600 * 1000,
    firstCheckMs: int(env.MDP_FIRST_CHECK_SECONDS, 20) * 1000,
    healthTimeoutMs: int(env.MDP_HEALTH_TIMEOUT_SECONDS, 360) * 1000,
  }
}

// Environment handed on to the apply helper. `docker run -e NAME` copies the value
// from this process, so secrets never appear on a command line.
export const PASS_ENV = [
  'STATE_DIR', 'MDP_PROJECT', 'MDP_DB_VOLUME', 'MDP_STATE_VOLUME', 'MDP_HELPER_NAME',
  'MDP_VERSION', 'MDP_SEQUENCE', 'MDP_PORT', 'MDP_ALLOW_HTTP', 'MDP_HEALTH_TIMEOUT_SECONDS',
  'MDP_RELEASE_PUBKEY', 'MDP_UPDATES', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY',
]
