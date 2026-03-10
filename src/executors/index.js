/**
 * Executor factory — loads the right executor based on VAP_EXECUTOR env var.
 *
 * Supported executors:
 *   local-llm  (default) — Current Kimi/template behavior
 *   webhook    — POST to external URL (n8n, REST services)
 */

const EXECUTOR_TYPE = (process.env.VAP_EXECUTOR || 'local-llm').toLowerCase();

function createExecutor() {
  switch (EXECUTOR_TYPE) {
    case 'local-llm':
      const { LocalLLMExecutor } = require('./local-llm.js');
      return new LocalLLMExecutor();

    case 'webhook':
      const { WebhookExecutor } = require('./webhook.js');
      return new WebhookExecutor();

    default:
      throw new Error(`Unknown executor type: ${EXECUTOR_TYPE}. Supported: local-llm, webhook`);
  }
}

module.exports = { createExecutor, EXECUTOR_TYPE };
