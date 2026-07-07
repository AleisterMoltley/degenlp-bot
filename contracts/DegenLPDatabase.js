/**
 * DegenLP Bot Database Contract
 * Persistent position tracking + telemetry store for the degen LP bot,
 * replacing the standalone Postgres server. Writes are gated to the bot
 * wallet (time-bound signature); reads are public view functions.
 */

// REQUIRED: All contracts must start with const state
const state = {
  // REQUIRED: metadata must be inside state
  metadata: {
    name: "DegenLPDatabase",
    description: "Position tracking and telemetry store for the degen LP bot",
    version: "1.0.0",
    author: "degenlpbot"
  },

  deployer: null,
  positionSeq: 0,
  positions: {},          // id -> ACTIVE position record
  closedPositions: [],    // newest last, capped at 300
  alerts: [],             // newest last, capped at 200
  opportunityChecks: [],  // newest last, capped at 500
  systemHealth: []        // newest last, capped at 200
};

/**
 * onDeploy - Initialize the contract
 * @param {Object} inputs - Deployment inputs
 * @param {string} inputs.deployer - Wallet address that deployed
 * @returns {Object} Deployment result
 */
function onDeploy(inputs) {
  state.deployer = inputs.deployer;
  return { success: true, message: "DegenLP database contract deployed" };
}

/**
 * _assertOwner - Verify a time-bound owner signature on a write call
 * @internal
 * @param {Object} inputs - Call inputs carrying from/message/signature
 * @returns {boolean} true when authorized (throws otherwise)
 */
function _assertOwner(inputs) {
  // Purpose-bind the message so a signature minted for anything else
  // (e.g. an API-key challenge) can never be replayed against this contract
  if (!inputs.message || typeof inputs.message !== "string" || inputs.message.indexOf("degenlp-db:") !== 0) {
    throw new Error("Invalid challenge message");
  }
  const verification = verify.verifyTimeBoundSignature(inputs.message, inputs.signature, inputs.from, 5);
  if (!verification || !verification.success) {
    throw new Error((verification && verification.error) || "Signature verification failed");
  }
  if (inputs.from !== state.deployer) {
    throw new Error("Not authorized: owner only");
  }
  return true;
}

/**
 * recordPositionEntry - Store a new active position (owner only)
 * @param {Object} inputs - Call inputs
 * @param {string} inputs.from - Owner wallet address
 * @param {string} inputs.message - Time-bound challenge starting with "degenlp-db:"
 * @param {string} inputs.signature - Owner signature of the message (base58)
 * @param {Object} inputs.position - Position record fields
 * @returns {Object} { success, id }
 */
function recordPositionEntry(inputs) {
  _assertOwner(inputs);
  const p = inputs.position || {};
  if (!p.position_address || !p.pool_address) {
    throw new Error("position_address and pool_address are required");
  }

  state.positionSeq += 1;
  const id = "pos_" + state.positionSeq;

  state.positions[id] = {
    id: id,
    pool_address: String(p.pool_address),
    pool_name: String(p.pool_name || "UNKNOWN"),
    base_token_symbol: String(p.base_token_symbol || "UNKNOWN"),
    quote_token_symbol: String(p.quote_token_symbol || "SOL"),
    bin_step: Number(p.bin_step) || 100,
    position_address: String(p.position_address),
    min_bin_id: Number(p.min_bin_id) || 0,
    max_bin_id: Number(p.max_bin_id) || 0,
    sol_deployed: Number(p.sol_deployed) || 0,
    entry_price: Number(p.entry_price) || 0,
    fee_tvl_ratio_at_entry: Number(p.fee_tvl_ratio_at_entry) || 0,
    liquidity_at_entry: Number(p.liquidity_at_entry) || 0,
    opportunity_score_at_entry: Number(p.opportunity_score_at_entry) || 0,
    market_cap_at_entry: Number(p.market_cap_at_entry) || 0,
    jupiter_score_at_entry: Number(p.jupiter_score_at_entry) || 0,
    entry_signature: String(p.entry_signature || ""),
    status: "active",
    entered_at: Date.now()
  };

  return { success: true, id: id };
}

/**
 * recordPositionExit - Close an active position (owner only)
 * @param {Object} inputs - Call inputs
 * @param {string} inputs.from - Owner wallet address
 * @param {string} inputs.message - Time-bound challenge starting with "degenlp-db:"
 * @param {string} inputs.signature - Owner signature of the message (base58)
 * @param {string} inputs.positionId - Id returned by recordPositionEntry
 * @param {number} inputs.exitPrice - Exit price
 * @param {number} inputs.feesCollected - SOL returned attribution
 * @param {string} inputs.exitReason - Why the position closed
 * @param {string} inputs.txSignature - Exit transaction signature
 * @returns {Object} { success }
 */
function recordPositionExit(inputs) {
  _assertOwner(inputs);
  const pos = state.positions[inputs.positionId];
  if (!pos) {
    throw new Error("Position not found: " + inputs.positionId);
  }

  const exitedAt = Date.now();
  const feesCollected = Number(inputs.feesCollected) || 0;
  pos.status = "closed";
  pos.exit_price = Number(inputs.exitPrice) || 0;
  pos.fees_collected = feesCollected;
  pos.exit_reason = String(inputs.exitReason || "");
  pos.exit_signature = String(inputs.txSignature || "");
  pos.exited_at = exitedAt;
  pos.duration_hours = Math.round((exitedAt - pos.entered_at) / 3600000);
  pos.roi_percentage = pos.sol_deployed > 0 ? (feesCollected / pos.sol_deployed) * 100 : 0;

  delete state.positions[inputs.positionId];
  state.closedPositions.push(pos);
  if (state.closedPositions.length > 300) {
    state.closedPositions.splice(0, state.closedPositions.length - 300);
  }

  return { success: true };
}

/**
 * recordOpportunityCheck - Log one rotation-scan result (owner only)
 * @param {Object} inputs - Call inputs
 * @param {string} inputs.from - Owner wallet address
 * @param {string} inputs.message - Time-bound challenge starting with "degenlp-db:"
 * @param {string} inputs.signature - Owner signature of the message (base58)
 * @param {Object} inputs.check - Opportunity check fields
 * @returns {Object} { success }
 */
function recordOpportunityCheck(inputs) {
  _assertOwner(inputs);
  const c = inputs.check || {};
  state.opportunityChecks.push({
    pool_address: String(c.pool_address || "none"),
    pool_name: String(c.pool_name || ""),
    token_symbol: String(c.token_symbol || ""),
    token_mint: String(c.token_mint || ""),
    opportunity_score: Number(c.opportunity_score) || 0,
    volume_to_tvl_ratio: Number(c.volume_to_tvl_ratio) || 0,
    volume_to_mcap_ratio: Number(c.volume_to_mcap_ratio) || 0,
    fee_to_tvl_ratio: Number(c.fee_to_tvl_ratio) || 0,
    market_cap: Number(c.market_cap) || 0,
    pool_tvl: Number(c.pool_tvl) || 0,
    volume_5m: Number(c.volume_5m) || 0,
    jupiter_score: Number(c.jupiter_score) || 0,
    decision: String(c.decision || ""),
    current_position_pool: String(c.current_position_pool || ""),
    met_threshold: Boolean(c.met_threshold),
    checked_at: Date.now()
  });
  if (state.opportunityChecks.length > 500) {
    state.opportunityChecks.splice(0, state.opportunityChecks.length - 500);
  }
  return { success: true };
}

/**
 * recordSystemHealth - Log a health sample (owner only)
 * @param {Object} inputs - Call inputs
 * @param {string} inputs.from - Owner wallet address
 * @param {string} inputs.message - Time-bound challenge starting with "degenlp-db:"
 * @param {string} inputs.signature - Owner signature of the message (base58)
 * @param {number} inputs.rpcLatencyMs - RPC latency in milliseconds
 * @param {boolean} inputs.rpcHealthy - RPC health flag
 * @param {number} inputs.activePositions - Number of active positions
 * @returns {Object} { success }
 */
function recordSystemHealth(inputs) {
  _assertOwner(inputs);
  state.systemHealth.push({
    rpc_latency_ms: Number(inputs.rpcLatencyMs) || 0,
    rpc_healthy: Boolean(inputs.rpcHealthy),
    active_positions_count: Number(inputs.activePositions) || 0,
    checked_at: Date.now()
  });
  if (state.systemHealth.length > 200) {
    state.systemHealth.splice(0, state.systemHealth.length - 200);
  }
  return { success: true };
}

/**
 * createAlert - Log an operator alert (owner only)
 * @param {Object} inputs - Call inputs
 * @param {string} inputs.from - Owner wallet address
 * @param {string} inputs.message - Time-bound challenge starting with "degenlp-db:"
 * @param {string} inputs.signature - Owner signature of the message (base58)
 * @param {string} inputs.alertType - Alert type slug
 * @param {string} inputs.severity - info | warning | error | critical
 * @param {string} inputs.title - Short title
 * @param {string} inputs.body - Alert body text
 * @param {Object} inputs.meta - Free-form metadata
 * @returns {Object} { success }
 */
function createAlert(inputs) {
  _assertOwner(inputs);
  state.alerts.push({
    type: String(inputs.alertType || "generic"),
    severity: String(inputs.severity || "info"),
    title: String(inputs.title || ""),
    message: String(inputs.body || ""),
    metadata: inputs.meta || null,
    created_at: Date.now()
  });
  if (state.alerts.length > 200) {
    state.alerts.splice(0, state.alerts.length - 200);
  }
  return { success: true };
}

/**
 * getActivePositions - List all active positions
 * @param {Object} inputs - Unused
 * @returns {Object} { positions }
 */
function getActivePositions(inputs) {
  const out = [];
  for (const id in state.positions) {
    out.push(state.positions[id]);
  }
  return { positions: out };
}

/**
 * getClosedPositions - List recent closed positions, newest first
 * @param {Object} inputs - Call inputs
 * @param {number} inputs.limit - Max rows (default 50)
 * @returns {Object} { positions }
 */
function getClosedPositions(inputs) {
  const limit = Math.min(Number(inputs.limit) || 50, 300);
  return { positions: state.closedPositions.slice(-limit).reverse() };
}

/**
 * getAlerts - List recent alerts, newest first
 * @param {Object} inputs - Call inputs
 * @param {number} inputs.limit - Max rows (default 50)
 * @returns {Object} { alerts }
 */
function getAlerts(inputs) {
  const limit = Math.min(Number(inputs.limit) || 50, 200);
  return { alerts: state.alerts.slice(-limit).reverse() };
}

/**
 * getOpportunityChecks - List recent opportunity checks, newest first
 * @param {Object} inputs - Call inputs
 * @param {number} inputs.limit - Max rows (default 50)
 * @returns {Object} { checks }
 */
function getOpportunityChecks(inputs) {
  const limit = Math.min(Number(inputs.limit) || 50, 500);
  return { checks: state.opportunityChecks.slice(-limit).reverse() };
}

/**
 * getSystemHealth - List recent health samples, newest first
 * @param {Object} inputs - Call inputs
 * @param {number} inputs.limit - Max rows (default 50)
 * @returns {Object} { health }
 */
function getSystemHealth(inputs) {
  const limit = Math.min(Number(inputs.limit) || 50, 200);
  return { health: state.systemHealth.slice(-limit).reverse() };
}

/**
 * getBestPools - Aggregate closed-position performance by pool
 * @param {Object} inputs - Call inputs
 * @param {number} inputs.limit - Max rows (default 10)
 * @returns {Object} { pools }
 */
function getBestPools(inputs) {
  const limit = Math.min(Number(inputs.limit) || 10, 100);
  const byPool = {};
  for (const pos of state.closedPositions) {
    if (!byPool[pos.pool_address]) {
      byPool[pos.pool_address] = {
        pool_address: pos.pool_address,
        pool_name: pos.pool_name,
        positions_count: 0,
        total_fees: 0,
        total_deployed: 0
      };
    }
    const agg = byPool[pos.pool_address];
    agg.positions_count += 1;
    agg.total_fees += pos.fees_collected || 0;
    agg.total_deployed += pos.sol_deployed || 0;
  }
  const pools = [];
  for (const addr in byPool) {
    pools.push(byPool[addr]);
  }
  pools.sort(function (a, b) { return b.total_fees - a.total_fees; });
  return { pools: pools.slice(0, limit) };
}
