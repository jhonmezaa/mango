/**
 * Seconds between checks of a runtime's `live` endpoint in the agent and pack provisioners.
 *
 * The provisioner gives up after 60 checks (`MAX_WAIT_ATTEMPTS`). AgentCore can take several
 * minutes to move `live` to a new version (about 4 min seen in a customer account), so 3 s
 * (3 min in all) failed publications that were about to succeed; 10 s gives about 10 min,
 * inside both executions' timeouts (25 and 40 min).
 */
export const LIVE_WAIT_SECONDS = 10;
