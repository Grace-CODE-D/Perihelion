# Perihelion Solver Economics & Fill-Race Incentive Analysis

**Status:** Economic analysis for mainnet design decisions
**Last Updated:** 2026-07-25
**Audience:** Protocol designers, game theory reviewers, solver operators, governance

---

## Executive Summary

Perihelion's solver market is built on **open, first-come, first-served competition** for intent fills. This design is simple and credibly neutral but exposes solvers to **priority-gas-auction (PGA) griefing**, where unsuccessful fill attempts incur sunk transaction costs, reducing profitability and equilibrium solver participation.

This document analyzes:

1. **Current incentive structure** — how solvers profit, what costs they bear
2. **Gas-griefing exposure** — quantified per blockchain with worked examples
3. **PGA risk at scale** — conditions under which griefing becomes uneconomical
4. **preferredSolver role** — how reservation windows could mitigate griefing at the cost of centralization
5. **Allocation mechanism alternatives** — sealed-bid auctions, commit-reveal, off-chain auctions
6. **Recommendations** — concrete reservation window and mempool-API designs for mainnet

The analysis concludes that **first-come wins is viable on Ethereum and Base** (due to high throughput and low gas variability) but **requires careful SLA and reservation design on Soroban** (lower throughput, higher latency). An **off-chain mempool with sealed-bid auction** is the recommended path forward for longer-term protocol evolution.

---

## Part I: Current Incentive Structure

### Solver Economics (First-Come, First-Served Model)

#### Revenue

A solver earns the **spread** between what the user offered and what the solver actually sourced:

```
Solver Profit = (User-Offered Rate) - (Actual Spot Rate) - (Solver Costs)
              = Spread - Gas Cost - Slippage on Fill - Opportunity Cost
```

**Example (Ethereum):**
- User intent: 100 USDC on Ethereum → 90 USDT on Stellar (2.5 min deadline)
- Solver sources 90 USDT at 1 USDC/USDT spot, paying 89.9 USDC
- Solver profit: 100 - 89.9 = 0.1 USDC (before gas)
- Gas cost (lock + verify): ~100K gas at 50 Gwei = 0.005 USDC
- Net profit: 0.1 - 0.005 = 0.095 USDC (95 bps spread, 100% execution)

#### Costs

Solvers incur costs whether they win or lose:

| Cost | Source | Amount | Impact |
| ---- | ------ | ------ | ------ |
| **Successful fill** | Gas (lock) | ~100-150K gas | Sunk cost if they win |
| **Failed fill (reverted)** | Gas (failed lock/fill) | ~50-200K gas | Total loss if they lose |
| **Sourcing slippage** | DEX/liquidity | ~0.5-2% per chain | Only if they fill |
| **Stale rate risk** | Market movement | 0.1-1% | If rate moves while sourcing |
| **Inventory lock** | Opportunity cost | ~0.01-0.1% | If destination liquidity tied up |

**Key Insight:** Unsuccessful fill attempts cost 50-200K gas (~0.002-0.01 USDC at current rates), which is **significant against typical 0.1-0.5 USDC spreads**.

### Solver Competition Model

In an open solver market, solvers bid with **transaction inclusion speed and gas price**, not explicit bids.

```
Competition Mechanism:
1. User broadcasts intent with minDestAmount and deadline
2. Solvers watch mempool and evaluate opportunity
3. Solvers with profitable spreads submit lock() transaction
4. First lock() included on-chain wins
5. Other solvers' lock() calls revert (intent already locked)
6. Unsuccessful solvers burn gas
```

**Equilibrium:**
- With `N` solvers and `P(win) = 1/N` win probability:
  - Each solver submits gas price `gp` to maximize `E[profit] = P(win) × Spread - Gas Cost(gp)`
  - At equilibrium, `E[profit] = 0` ⇒ `Spread = Gas Cost / P(win) = Gas Cost × N`
  - Solvers need spreads `N×` larger to stay profitable as competition increases

**Example:**
- 10 competing solvers, 0.1 USDC spread, 0.01 USDC gas cost
- Expected profit per solver: 0.1 / 10 - 0.01 = 0 (break-even)
- If spreads shrink to 0.05 USDC: all solvers operate at -50% expected ROI (rational exit)

---

## Part II: Gas-Griefing & Priority-Gas-Auction Exposure

### Definition

**Gas griefing** occurs when unsuccessful solvers submit high-gas-price transactions that revert, paying gas costs without earning profit. This creates a **priority-gas-auction (PGA)** where:

1. All solvers spend on gas to compete for inclusion
2. Only the winner recoups gas from spread
3. Losers suffer total gas loss
4. Spreads must be large enough to cover losing solvers' gas costs in expectation

### Quantified Exposure by Blockchain

#### Ethereum Mainnet

**Parameters:**
- Base gas cost (lock): 100K gas
- Gas price volatility: 20-200 Gwei (8x range)
- Block time: ~12 seconds
- Mempool competition: medium to high (many bots, MEV infrastructure)

**Example (10 USDC intent, 5 competing solvers):**

| Solver | Gas Price | Tx Cost (ETH) | Tx Cost (USD) | Spread | Result |
| ------ | --------- | ------------ | ------------- | ------ | ------ |
| Solver A (fastest) | 100 Gwei | 0.01 | $40 | $100 | WIN |
| Solver B | 90 Gwei | 0.009 | $36 | $100 | LOSE |
| Solver C | 80 Gwei | 0.008 | $32 | $100 | LOSE |
| Solver D | 70 Gwei | 0.007 | $28 | $100 | LOSE |
| Solver E | 60 Gwei | 0.006 | $24 | $100 | LOSE |

**Aggregate costs:** 40 + 36 + 32 + 28 + 24 = $160 in gas to compete for $100 spread. Solvers collectively lose $60. This is sustainable only if solvers have 5 intents per winner on average (1:1 win:loss ratio) or if spreads are much higher.

**Griefing Risk at Scale:**
- At 100 USDC intents with 10 competing solvers, gas costs can be $50-100
- Spread must be > $500-1000 per 100 USDC to break even
- This creates a **1-1.5% minimum spread requirement**, limiting user value

#### Base Mainnet

**Parameters:**
- Base gas cost (lock): ~100K gas (same as Ethereum)
- Gas price volatility: 2-20 Gwei (10x range, but lower baseline)
- Block time: ~2 seconds
- Mempool competition: medium (fewer bots than Ethereum, but growing)

**Cost Reduction:** Base's lower gas prices (~10x cheaper than Ethereum) significantly reduce griefing exposure.

**Example (same 10 USDC intent, 5 solvers):**

| Solver | Gas Price | Tx Cost (Gwei) | Tx Cost (USD) | Spread | Result |
| ------ | --------- | -------------- | ------------- | ------ | ------ |
| Solver A | 10 Gwei | 0.001 | $0.4 | $100 | WIN |
| Solver B | 9 Gwei | 0.0009 | $0.36 | $100 | LOSE |
| Solver C | 8 Gwei | 0.0008 | $0.32 | $100 | LOSE |
| Solver D | 7 Gwei | 0.0007 | $0.28 | $100 | LOSE |
| Solver E | 6 Gwei | 0.0006 | $0.24 | $100 | LOSE |

**Aggregate costs:** $1.60 to compete for $100 spread (1.6% fee), much more sustainable than Ethereum.

#### Soroban (Stellar)

**Parameters:**
- Base "gas" cost (lock + fill): ~1-2M Operations (Soroban fee model)
- Resource pricing: Flat fee (~0.001 XLM per operation, ~$0.0001 per op)
- Settlement latency: 5-30 seconds per transaction + 30 second confirmation
- Mempool: Single slot per sequence number (strict ordering)
- Throughput: ~4,000 transactions per ledger, ~1 ledger per 5 seconds = ~800 tx/sec max

**Cost Profile:**
- Lock operation cost: ~1.5M ops × 0.0001 = $0.15 per attempt
- Fill operation cost: ~1M ops × 0.0001 = $0.10 per attempt
- Total per solver attempt: ~$0.25

**Unique Risk (Sequence Number Lock):**
Soroban's single sequence number per account means:
- Only one transaction per solver account can be pending per ledger
- If solver submits lock attempt and it reverts, the sequence advances
- Solver must wait for next ledger (~5 sec) to retry with new sequence
- **With 10 competing solvers, 50 sec to place 10 attempts** (vs. ~2 sec on Ethereum)

**Griefing at Scale:**
- For a 1000 USDT intent with 10 competing solvers:
  - Total gas cost: 10 × $0.25 = $2.50
  - Typical spread: $10-50 (1-5%)
  - PGA overhead: ~5-25% of typical spread
- **Verdict:** Manageable on Soroban if spreads are healthy; brittle if spreads compress below 1%

### Gas-Griefing Scenarios

#### Scenario A: Spam Attack
**Attack:** Attacker submits many dummy intents with high spreads to trigger solver PGA

**Impact:**
- Real solvers waste gas competing for fake intents
- Solver margins compress
- Real intent volume declines

**Mitigation:** Require users to lock collateral or minimum reputation; monitor intent-to-fill ratio

#### Scenario B: MEV Griefing
**Attack:** MEV bot detects upcoming high-value intent and front-runs with its own high-gas transaction to block solvers

**Impact:**
- Legitimate solver pays gas to compete but loses to MEV bot
- MEV bot extracts solver surplus as profit
- Solvers exit if margins too thin

**Mitigation:**
- Use threshold encryption or time-locked intents to prevent detection
- Implement off-chain auction (sealed-bid) to eliminate front-running

#### Scenario C: Competitive Saturation
**Attack:** Market becomes so competitive that spreads are no longer profitable after PGA costs

**Impact:**
- Solver exit reduces liquidity
- Users face larger slippage
- Bridge TVL declines
- Eventually, no solvers remain

**Mitigation:**
- Implement reservation mechanism (preferredSolver) to give leader safe lane
- Transition to off-chain auction for long-term health

---

## Part III: preferredSolver Mechanism

### Design

A **preferredSolver** reservation allows a single solver to execute a fill without competition for a short window (e.g., 3 seconds), reducing griefing exposure.

**Flow:**
```
1. User creates intent with optional preferredSolver field
2. Solver monitors mempool; if preferredSolver matches, immediately fills
3. If preferredSolver doesn't fill within 3 seconds, any solver can compete
4. First fill wins (same as current model)
```

### Benefits

| Benefit | Magnitude | Note |
| ------- | --------- | ---- |
| Reduces griefing | -80-90% | Solver avoids competition during window |
| Lowers gas costs | ~10x | No need for high gas prices |
| Improves UX | — | Faster, more predictable fills |
| Enables LP relationships | — | Solver can guarantee fills to partner |

### Risks

#### Risk 1: Centralization
- Power concentrates on preferred solver
- If preferredSolver is unavailable, users face delays or poor rates
- Creates a **single point of failure**

**Mitigation:**
- Rotate preferredSolver regularly
- Require preferredSolver to meet SLA (e.g., 95% uptime)
- Allow users to specify backups

#### Risk 2: Collusion
- Preferred solver could collude with other solvers to extract MEV
- Example: Solver A is preferred, delays fill; Solver B front-runs at high rate

**Mitigation:**
- Make reservation window short (3-5 seconds, non-extendable)
- Monitor for abnormal delays or collusion patterns
- Automatic escalation to open competition if SLA missed

#### Risk 3: Reservation Griefing
- Preferred solver could intentionally fail fills to block competition
- Example: Solver deliberately submits `lock()` that reverts, blocking other solvers

**Mitigation:**
- Slash preferred solver on SLA miss (e.g., forfeit 1% of spreads)
- Remove from preferred set if SLA misses > 5%
- Use escrow/reputation system to gate access

### Trade-Offs

| Dimension | First-Come (Status Quo) | preferredSolver Reservation |
| --------- | ---------------------- | ----------------------------- |
| **Decentralization** | High (permissionless) | Lower (gated by selection process) |
| **PGA Exposure** | High (~1-5% on Ethereum) | Low (~0.1-0.5%) |
| **Fairness** | Lottery (based on gas price) | Predetermined (preferredSolver chosen ahead of time) |
| **UX Predictability** | Low (uncertain fill rate) | High (committed solver) |
| **Griefing Risk** | Can't entirely prevent | Adds reservation griefing vector |
| **Governance Burden** | None | Moderate (select & rotate preferred solvers) |

**Verdict:** preferredSolver is a **pragmatic short-term solution** but introduces centralization. For protocols with small solver base (<10), it may be necessary. For decentralized growth, plan to transition to off-chain auction.

---

## Part IV: Allocation Mechanism Alternatives

### Option A: Sealed-Bid Auction (Off-Chain)

**Design:**
1. User commits intent hash + min bid to bridge
2. Solvers submit sealed bids off-chain (encrypted) to centralized bid server
3. Server opens bids after deadline; highest bidder wins
4. Winner calls `lock()` on-chain and proves they won auction

**Advantages:**
- ✅ Eliminates PGA (no gas bidding)
- ✅ Maximizes user value (highest real bid wins)
- ✅ Transparent (audit trail of bids)
- ✅ Flexible (can include conditions, e.g., delivery rate, collateral)

**Disadvantages:**
- ❌ Requires trusted bid server (centralization)
- ❌ Requires off-chain infrastructure coordination
- ❌ Adds latency (bid collection + opening)
- ❌ Complexity (encrypted bids, proof verification)

**Suitability for Perihelion:** Medium. Works well for large intents (>$10k) where auction overhead is justified. Less suitable for small intents (<$1k) due to latency.

### Option B: Commit-Reveal (On-Chain)

**Design:**
1. User publishes intent on-chain
2. Solvers submit commitments (keccak256(bid, nonce)) in Phase 1 (~5 seconds)
3. All bids revealed in Phase 2 (~5 seconds)
4. Highest bidder is declared winner
5. Winner submits `lock()` transaction

**Advantages:**
- ✅ Fully on-chain (no trusted third party)
- ✅ No gas bidding (fixed per submission)
- ✅ Immutable (on-chain audit trail)
- ✅ Decentralized (no single coordinator)

**Disadvantages:**
- ❌ High latency (2 phases, ~10 seconds minimum)
- ❌ Requires 2-3 transactions per intent (commit + reveal + lock)
- ❌ Complexity (bit-commitment scheme, reveal proofs)
- ❌ Gas costs higher (multiple on-chain calls)

**Suitability for Perihelion:** Low. Latency incompatible with Perihelion's goal of <5 minute deadlines and fast Soroban finality. Better suited for longer-timeframe asset bridges.

### Option C: Designated Solver Rotation

**Design:**
1. Governance selects a pool of `K` approved solvers
2. Each solver gets exclusive fill right for duration `T` (e.g., 1 hour)
3. After `T`, selection rotates to next solver
4. If selected solver misses SLA, bridge automatically escalates to next in queue

**Advantages:**
- ✅ Predictable (users know who fills their intents)
- ✅ Simple (no complex auction logic)
- ✅ SLA enforceable (slash bad performers)
- ✅ Stable (regulated supply)

**Disadvantages:**
- ❌ Highly centralized (only K solvers can ever fill)
- ❌ No competition (solvers have no incentive to improve rates)
- ❌ Vulnerable to collusion (selected solvers fix rates)
- ❌ Governance overhead (selecting and rotating solvers)

**Suitability for Perihelion:** Low. Contradicts Perihelion's permissionless design. Only suitable as temporary emergency measure.

### Option D: Fee-Based Supply Allocation

**Design:**
1. User specifies `maxSolverFee` in intent (e.g., 0.2%)
2. Solvers submit bids off-chain; highest fee offer wins
3. Winning solver calls `lock()` and receives the full declared fee

**Advantages:**
- ✅ Simple (just specify fee in intent)
- ✅ User control (explicit fee agreement)
- ✅ Fair (highest bidder wins)
- ✅ No PGA (winner determined before on-chain call)

**Disadvantages:**
- ❌ Requires off-chain bid aggregation
- ❌ Requires users to estimate fair fee (may overpay/underpay)
- ❌ Fee structure may be novel to users

**Suitability for Perihelion:** Medium-High. This is a variant of sealed-bid auction but simpler to implement. Could be phased in for large intents first.

---

## Part V: Recommendations for Mainnet

### Phase 1: Immediate (Pre-Mainnet Launch)

**For Ethereum & Base:**
- Keep **first-come, first-served** model
- **Justification:** Gas costs are low enough (~0.2-0.5% on Base) that PGA is manageable; MEV infrastructure will prevent sustained griefing; higher spreads compensate solvers
- **Monitoring:** Track solver participation and spreads; if spreads compress below 0.5%, escalate to Phase 2

**For Soroban:**
- Implement **preferredSolver reservation** (3-5 second window, configurable)
- **Justification:** Soroban's sequence number lock and lower throughput make first-come very risky; preferredSolver reduces griefing significantly
- **Design Details:**
  - Preference specified by user in intent (optional)
  - Reservation only active if preferredSolver matches; auto-escalates to open competition after grace period
  - No mandatory preferred solver (permissionless fallback always available)

**Rationale for Different Approaches:**
- Ethereum/Base have high throughput (25k+ tx/sec) and competitive MEV markets; solvers must accept gas bidding
- Soroban has lower throughput (~800 tx/sec) and lacks robust MEV infrastructure; preferredSolver gives leader safe lane

### Phase 2: Short-Term (Months 1-3 Post-Launch)

**Monitor and Tune:**
- Track griefing incidents and solver participation rates
- If Ethereum spreads drop below 0.3% USDC: prepare for auction transition
- If Soroban prefers one solver > 80% of time: governance review (potential centralization)

**Preparation:**
- Design sealed-bid auction spec for future phases
- Develop off-chain bid aggregation infrastructure
- Build off-chain reputation/collateral system for bid participants

### Phase 3: Medium-Term (Months 3-12 Post-Launch)

**Conditional Transition:**
- If large intents (>$100k) show consistent 1-2% PGA overhead:
  - Launch **sealed-bid auction for large intents** (>$50k threshold)
  - Keep first-come for small intents (<$50k)
- If Soroban prefers small set of solvers:
  - Implement **rotation of preferredSolver** to prevent centralization

### Phase 4: Long-Term (Year 1+)

**Mature Design:**
- Generalize to **fee-based allocation** across all chains
- Transition off-chain auction to decentralized protocol (e.g., MEV-Burn equivalent)
- Monitor for MEV and include in protocol design (e.g., threshold encryption, time-locks)

---

## Part VI: Mempool and API Design

### EVM Mempool Design

**Solvers need visibility into:**
1. **Live intents** — publicly broadcast intent hashes and amounts
2. **Mempool pending** — which other solvers have submitted lock() calls
3. **Gas prices** — current base fee, priority fee bands

**API Endpoints:**

```typescript
// REST API
GET /api/v1/intents
  Returns: [{ hash, user, amount, minDestAmount, deadline, solver }]

GET /api/v1/mempool
  Returns: { pendingLocks: [{ hash, solver, gasPrice }], baseFee, priority: [] }

GET /api/v1/price-feed
  Returns: { ethGasPrice, priorityFee, blockTime }

// WebSocket (optional, for real-time updates)
WS /api/v1/stream/intents
  Emits: { type: 'IntentCreated' | 'IntentLocked', data: {...} }
```

**Solver Workflow:**
```
1. Connect to /stream/intents
2. Wait for IntentCreated event with favorable spread
3. Query /mempool to see if other solvers already submitting
4. If not: prepare lock() transaction
5. If others are: calculate gas price needed to win (based on pending, baseFee, priority)
6. Submit transaction at optimal gas price
7. Either win (included in block) or lose (reverted)
```

### Soroban Mempool Design

**Solvers need visibility into:**
1. **Live intents** — published on bridge contract with hash and deadline
2. **Reservation status** — who (if anyone) has preferredSolver right
3. **Pending transactions** — which solvers have submitted lock/fill calls (limited visibility due to sequence number lock)

**API Endpoints:**

```typescript
// REST API
GET /api/v1/intents
  Returns: [{ hash, user, amount, minDestAmount, deadline, preferredSolver, registered }]

GET /api/v1/reservation-status
  Returns: { hash, preferredSolver, windowExpiry, isEscalated }

GET /api/v1/ledger-info
  Returns: { ledgerNumber, closeTime, transactionsThisLedger }

// WebSocket
WS /api/v1/stream/intents
  Emits: { type: 'IntentCreated' | 'IntentLocked' | 'ReservationExpired', data: {...} }
```

**Solver Workflow:**
```
1. Connect to /stream/intents
2. Wait for IntentCreated event
3. Check /reservation-status
4. If preferredSolver !== self:
   - Wait for ReservationExpired or escalation signal
5. If no preferredSolver or window expired:
   - Prepare lock transaction
   - Submit with sequence number for next available ledger
6. If transaction includes in block: declare win
7. If transaction reverts: wait for next ledger and retry or abandon
```

---

## Part VII: Risk Assessment Summary

### High-Risk Scenarios

| Scenario | Probability | Impact | Mitigation |
| -------- | ----------- | ------ | ---------- |
| Solver exit due to thin margins | Medium | Liquidity dries up | Monitor spreads, adjust fees or reservation policy |
| Griefing attack on Soroban | Low | Operational disruption | preferredSolver + SLA enforcement |
| Collusion between solvers | Low | Users overpay on spreads | Monitoring + rotation of preferred solvers |
| MEV bot extraction | Medium (on Ethereum) | Solver profit erosion | Sealed-bid auction design (future) |

### Maintenance Burden

| Approach | Ops Overhead | Technical Debt | Governance Cost |
| --------- | ------------ | -------------- | --------------- |
| **First-come (Ethereum/Base)** | Low | Low | Low |
| **preferredSolver (Soroban)** | Medium | Medium | Medium |
| **Sealed-bid auction** | High | High | High |
| **Designated rotation** | Very high | Very high | Very high |

---

## References

- **Solver Architecture:** [solver/README.md](../solver/README.md)
- **Intent Spec:** [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md#intent-hash-and-lifecycle)
- **Monitoring & Alerts:** [MONITORING.md](./MONITORING.md)
- **Security Model:** [TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix](./TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix)

---

## Appendix: Worked Example — 1000 USDC Intent on Ethereum

**Parameters:**
- Intent: 1000 USDC on Ethereum → 950 USDT on Stellar (3 min deadline)
- Solvers: 10 competing Uniswap-integrated solvers
- Current ETH price: $2000
- Gas price: 50 Gwei (typical)
- USDC/USDT spread: 0.1% (1 USDC per 1000)

**Solver Analysis:**

| Solver | Strategy | Gas Price | Lock Gas | Cost (USD) | Spread | Outcome |
| ------ | -------- | --------- | -------- | ---------- | ------ | ------- |
| Solver A (MEV bot) | Max speed | 200 Gwei | 100K | $0.04 | 10 USDC | WIN |
| Solver B | Aggressive | 150 Gwei | 100K | $0.03 | 10 USDC | LOSE |
| Solver C | Moderate | 100 Gwei | 100K | $0.02 | 10 USDC | LOSE |
| Solver D-J | Passive | 50-80 Gwei | 100K | $0.01-0.016 | 10 USDC | LOSE ×6 |

**Aggregate Analysis:**
- Total gas cost: 0.04 + 0.03 + 0.02 + 0.01 + 0.012 + 0.013 + 0.014 + 0.015 + 0.016 = **$0.171**
- Spread available: 10 USDC = **$10**
- PGA overhead: 0.171 / 10 = **1.7%**

**Verdict:** 1.7% PGA overhead is high for tight-margin operations but manageable if solvers have other intents to fill and if spreads scale with intent size.

---

## Appendix: Worked Example — 10 XLM Intent on Soroban

**Parameters:**
- Intent: 10 XLM on Soroban → 9.95 XLM on Ethereum (1 min deadline, after fill latency)
- Solvers: 4 competing solvers
- XLM price: $0.15
- Operation cost: 0.0001 XLM (~$0.000015)
- Spread requirement: 1% of 10 XLM = 0.1 XLM = $0.015

**Scenario A: No Reservation (First-Come)**

| Solver | Ops Cost | Attempts | Total Cost | Spread | Win Chance | Expected P&L |
| ------ | -------- | -------- | ---------- | ------ | ---------- | ------------ |
| Solver A | 0.1 XLM | 1 (fast) | $0.0015 | 0.1 XLM | 25% | $0.0015 |
| Solver B | 0.1 XLM | 2 (slower) | $0.003 | 0.1 XLM | 25% | $0 |
| Solver C | 0.1 XLM | 3 (slowest) | $0.0045 | 0.1 XLM | 25% | -$0.0015 |
| Solver D | 0.1 XLM | 1 (wait) | $0.0015 | 0.1 XLM | 25% | $0.0015 |

**Verdict:** Without reservation, slower solvers are unprofitable (Solver C loses money).

**Scenario B: With preferredSolver Reservation (Solver A)**

| Solver | Ops Cost | Reservation | Total Cost | Spread | Expected P&L |
| ------ | -------- | ----------- | ---------- | ------ | ------------ |
| Solver A (preferred) | 0.1 XLM | Yes (3 sec) | $0.0015 | 0.1 XLM | $0.0135 |
| Solver B, C, D | — | No (if A fills) | $0 | — | $0 |

**Verdict:** Reservation makes Solver A consistently profitable while allowing backup solvers to only pay gas if needed. Much healthier equilibrium.

---

## Dispatch Keeper Reward

`dispatch_confirmation` is permissionless, but the dispatch keeper reward
(`dispatch_keeper_reward`, set by `set_dispatch_keeper_reward`) is paid only
when the dispatch is a genuine rescue of a stalled confirmation:

- **The solver never earns it.** A solver dispatching its own fill receives no
  reward. Paying it would turn a fixed reserve into a per-fill subsidy that
  drains at the fill rate.
- **Third parties wait for a grace period.** The reward is paid only once the
  fill has been unconfirmed for `DISPATCH_REWARD_GRACE_LEDGERS` (360 ledgers,
  about 30 minutes), so the solver has its own window to dispatch first.

The reward is a fixed amount, so it can over-pay when the LayerZero fee is low
and under-pay when it is high. Operators should compare it with the quoted fee
(`quote_fill_confirmed_fee`) before relying on third-party keepers. The
`KeeperReward` for `cancel_expired_intent` has the same farming exposure: small
intents cancelled for the reward are profitable whenever the reward exceeds the
cost of creating them. That reward is not yet bounded and is tracked separately.

---

## Conclusion

For mainnet deployment, **recommend a hybrid approach:**

1. **Ethereum & Base:** Keep first-come, monitor for PGA > 1%, escalate if compressed
2. **Soroban:** Implement optional preferredSolver reservation with 3-5 second window
3. **Monitoring:** Track solver participation, spreads, and PGA costs; prepare for sealed-bid auction transition if metrics deteriorate
4. **Long-term:** Evolve to fee-based allocation and off-chain auction for large intents

This balances **permissionless protocol design** with **practical solver economics** and sets foundation for more sophisticated allocation mechanisms post-launch.
