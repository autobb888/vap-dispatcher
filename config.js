/**
 * Dispatcher Configuration
 * 
 * All settings in one place. Override via env vars.
 */

var config = {
  // VAP API
  vapApi: process.env.VAP_API || 'https://api.autobb.app',
  vapIdentity: process.env.VAP_IDENTITY || 'ari2.agentplatform@',
  vapIAddress: process.env.VAP_I_ADDRESS || 'i42xpRB2gAvt8PWpQ5FLw4Q1eG3bUMVLbK',
  vapKeysFile: process.env.VAP_KEYS_FILE || '.vap-keys.json',

  // Polling
  pollInterval: parseInt(process.env.POLL_INTERVAL || '30000', 10),

  // Docker
  dockerImage: process.env.DOCKER_IMAGE || 'ari2-agent:latest',
  containerMemory: process.env.CONTAINER_MEMORY || '512m',
  containerCpus: process.env.CONTAINER_CPUS || '1',
  containerMaxLifetime: parseInt(process.env.CONTAINER_MAX_LIFETIME || '3600000', 10), // 1 hour
  portRangeStart: parseInt(process.env.PORT_RANGE_START || '19001', 10),
  portRangeEnd: parseInt(process.env.PORT_RANGE_END || '19010', 10),
  portCooldown: parseInt(process.env.PORT_COOLDOWN || '5000', 10), // 5s

  // Paths (on host)
  wikiPath: process.env.WIKI_PATH || '/home/bb/verus-wiki/docs',
  memoryIndexPath: process.env.MEMORY_INDEX_PATH || '',  // optional pre-built SQLite
  jobsPath: process.env.JOBS_PATH || '/mnt/jobs',
  tmpConfigBase: process.env.TMP_CONFIG_BASE || '/tmp/ari2-configs',

  // API Proxy
  proxyPort: parseInt(process.env.PROXY_PORT || '19100', 10),
  nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  proxyRateLimit: parseInt(process.env.PROXY_RATE_LIMIT || '60', 10), // req/min per container
  model: process.env.OPENCLAW_MODEL || 'moonshotai/kimi-k2.5',

  // Rate limiting
  maxAcceptsPerMinute: parseInt(process.env.MAX_ACCEPTS_PER_MIN || '2', 10),
  maxQueuedJobs: parseInt(process.env.MAX_QUEUED_JOBS || '20', 10),
  ghostTimeout: parseInt(process.env.GHOST_TIMEOUT || '600000', 10), // 10 min

  // OpenClaw (for containers)
  openclawModel: process.env.OPENCLAW_MODEL || 'proxy/moonshotai/kimi-k2.5',
};

module.exports = config;
