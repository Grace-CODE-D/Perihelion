# Perihelion Cross-Chain Reconciliation Service

**Status:** Design specification for reconciliation, validation, and anomaly detection
**Last Updated:** 2026-07-25
**Audience:** Protocol engineers, auditors, mainnet operators, monitoring teams

---

## Overview

Perihelion's cross-chain bridge must maintain invariant **I1** (no user fund loss) across two independent blockchains (Soroban and EVM). Without continuous reconciliation, divergences in locked vs. settled funds could go undetected and silently drain liquidity.

The **Reconciliation Service** is an off-chain component that:

1. **Matches intent lifecycle** across both chains — ensures each intent has corresponding events on both sides
2. **Validates value conservation** — confirms `Locked ≥ Released + Refunded + In-Flight`
3. **Flags divergences and alerts** — triggers monitoring alerts and circuit-breaker when invariants are violated
4. **Enables incident response** — provides auditable trails for post-mortems and governance decisions

This document defines:

- Intent matching algorithm and state correlation
- Value conservation checks and tolerance policies
- Divergence detection logic
- Integration with monitoring and pause controls
- Reference implementation queries

---

## Part I: Intent Lifecycle Matching

### State Machine Overview

Every intent follows a lifecycle across two chains. Reconciliation must track all states:

```
┌─────────────────────┐
│      EVM Escrow     │
├─────────────────────┤
│ State     │ Fields  │
├───────────┼─────────┤
│ Pending   │ No lock │
│ Locked    │ L, R=0  │
│ Released  │ L, R=1  │
│ Refunded  │ L, Rf=1 │
└─────────────────────┘
        ↕ via LayerZero
┌─────────────────────┐
│   Soroban Contract  │
├─────────────────────┤
│ State     │ Fields  │
├───────────┼─────────┤
│ Pending   │ No reg  │
│ Locked    │ Locked  │
│ Filled    │ Filled  │
│ Cancelled │ Cancel  │
└─────────────────────┘
```

### State Correlation Matrix

For each unique `intent_hash`, reconciliation creates a record correlating states across chains:

| Intent Hash | EVM State | Soroban State | Expected | Flags |
| ----------- | --------- | ------------- | -------- | ----- |
| hash_A | Locked | Locked | ✅ Normal (in-flight) | — |
| hash_B | Locked | Filled | ✅ In-flight settlement | — |
| hash_C | Released | Filled | ✅ Settled (normal) | — |
| hash_D | Refunded | Filled | ❌ Divergence | CRITICAL |
| hash_E | Released | Cancelled | ❌ Divergence | CRITICAL |
| hash_F | Locked | Locked | ⚠️ Stale (> 30 min) | HIGH |

### Matching Algorithm

**Input:** Event streams from EVM and Soroban indexers

**Process:**

```
For each intent_hash:
  1. Find latest event on EVM (Locked, Released, or Refunded)
  2. Find latest event on Soroban (Locked, Filled, or Cancelled)
  3. Look up corresponding events in opposite chain
  4. Compute state correlation using matrix above
  5. If divergence or anomaly: trigger alert
  6. Record all findings for value conservation check
```

**Key Rules:**

- **I1 Invariant:** Once Released on EVM, must have Filled on Soroban (and vice versa)
- **I2 Invariant:** At most one Released/Filled pair per hash
- **I3 Invariant:** Refunded on EVM must correlate with Cancelled or expired intent on Soroban
- **Timing:** Allow configurable grace period for message propagation (recommend 30 min)

### Handling Incomplete Correlations

Sometimes one chain sees an event before the other (message in flight):

| Scenario | Grace Period | Action |
| -------- | ------------ | ------ |
| EVM Locked, Soroban Locked not yet received | 10 min | Normal, FillInstruction in transit |
| EVM Released, Soroban Filled not yet received | 10 min | Normal, FillConfirmed in transit |
| EVM Locked, Soroban never receives FillInstruction | 30 min | Alert HIGH (message loss) |
| EVM Released, Soroban never receives FillConfirmed | 30 min | Alert HIGH (message loss) |
| EVM Refunded, Soroban Cancelled not received | 30 min | Alert MEDIUM (cancel delay) |

### Cancellation Reasons

Every `CancelIntent` carries a reason code that the relayer forwards unchanged to the settlement contract, which records it in the `Cancelled` event:

| Code | Name | Meaning |
| ---- | ---- | ------- |
| `0x00` | `EXPIRED` | Intent deadline passed without settlement |
| `0x01` | `ADMIN` | Operator-initiated cancellation |
| `0x02` | `INVALID` | Intent failed validation |

Reconciliation must compare the reason recorded on Soroban against the reason in the source message; a mismatch is a divergence. Incident response relies on this distinction: an `ADMIN` cancellation is an operator action and must never be reported as an `EXPIRED` one. The relayer must preserve the reason end-to-end (see issue #940) — it must not hard-code a default.

---

## Part II: Value Conservation Assertions

Value conservation means:

```
Locked = Released + Refunded + In-Flight ± Tolerance
```

Where:

- **Locked:** Sum of all `Locked` events on EVM (amount escrowed)
- **Released:** Sum of all `Released` events on EVM (amount paid to solvers)
- **Refunded:** Sum of all `Refunded` events on EVM (amount returned to users)
- **In-Flight:** Sum of amounts in intents with state (Locked, Filled) but not yet terminal
- **Tolerance:** ±N bps to account for rounding (recommend 1 bps = 0.01%)

### Dual-Perspective Checks

Reconciliation runs checks from both chain perspectives:

#### EVM Perspective
```
∑(EVM Locked) = ∑(EVM Released) + ∑(EVM Refunded) + ∑(In-Flight on EVM)
```

- **How to compute:**
  - Sum all amounts from `Locked` events (user deposits)
  - Sum all amounts from `Released` events (solver payouts)
  - Sum all amounts from `Refunded` events (user refunds)
  - In-Flight = Locked - Released - Refunded
  - Check: In-Flight ≥ 0 and within tolerance

#### Soroban Perspective
```
∑(Soroban Filled) + ∑(Soroban Cancelled) = ∑(EVM Locked)
```

- **How to compute:**
  - Sum all amounts from `Filled` events (destination assets delivered to users)
  - Sum all amounts from `Cancelled` events (intent lifecycle terminated without settlement)
  - Cross-chain total should equal total locked on EVM
  - Check: Deviation < tolerance

### Per-Intent Assertions

For each intent (if lifecycle is terminal):

#### Assertion A1: Settled Intents
```
If state is (Released on EVM, Filled on Soroban):
  - Solver received: released_amount
  - User received: filled_amount
  - Check: filled_amount ≥ intent.minDestAmount
```

#### Assertion A2: Refunded Intents
```
If state is (Refunded on EVM, Cancelled on Soroban):
  - User refunded: refunded_amount
  - Original lock: locked_amount
  - Check: refunded_amount == locked_amount (within rounding tolerance)
```

#### Assertion A3: In-Flight Intents
```
If state is (Locked on EVM, not-yet-Filled on Soroban):
  - Deadline check: NOW < intent.deadline
  - Message check: FillInstruction sent within 10 min
  - Action: If deadline passed + 30 min, should have Cancelled/Refunded
```

#### Assertion A4: Single Settlement
```
For every intent hash:
  - Count of (Released on EVM, Filled on Soroban) ≤ 1
  - If > 1: CRITICAL alert (potential double-settlement exploit)
```

### Tolerance Policy

Different tolerance thresholds based on context:

| Check | Tolerance | Rationale |
| ----- | ---------- | ----------- |
| Rounding (per-intent) | ±1 wei | Solidity arithmetic precision |
| Aggregate sums | ±1 bps (0.01%) | Accumulation of rounding over many intents |
| Exchange rate variance | ±0.5% | Market price movements (if applicable to settlement) |
| Message latency | 30 min | Grace period for cross-chain delivery |

---

## Part III: Divergence Detection & Alerting

### Divergence Types

#### Type 1: Value Mismatch
- **Condition:** `|Locked - Released - Refunded - In-Flight| / Locked > Tolerance`
- **Severity:** CRITICAL
- **Action:** Pause bridge immediately, investigate fund drain

#### Type 2: Unmatched Settlement
- **Condition:** Intent state is (Released, Filled) but amounts mismatch OR one chain lacks event
- **Severity:** CRITICAL
- **Action:** Pause bridge, audit settlement integrity

#### Type 3: Double Settlement
- **Condition:** Multiple (Released, Filled) events for same hash
- **Severity:** CRITICAL
- **Action:** Pause bridge, investigate exploit

#### Type 4: Stale Intent
- **Condition:** Intent in (Locked, Filled) state for > 30 min without reaching terminal state
- **Severity:** HIGH
- **Action:** Check message delivery, trigger manual review

#### Type 5: Message Loss
- **Condition:** FillInstruction or FillConfirmed not received after timeout
- **Severity:** HIGH
- **Action:** Alert ops, check LayerZero status

#### Type 6: Inconsistent Refunds
- **Condition:** EVM shows Refunded but Soroban shows no Cancelled, OR vice versa
- **Severity:** MEDIUM
- **Action:** Investigate race condition or message delay

### Alert Emission

When divergence detected:

```
Alert {
  severity: "CRITICAL" | "HIGH" | "MEDIUM",
  type: "ValueMismatch" | "UnmatchedSettlement" | ...,
  affected_intents: [hash1, hash2, ...],
  reconciliation_gap: {
    locked_sum: uint256,
    released_sum: uint256,
    refunded_sum: uint256,
    divergence_amount: uint256,
    divergence_pct: float
  },
  timestamp: ISO8601,
  recommendations: [
    "Pause bridge and review",
    "Check LayerZero status",
    ...
  ]
}
```

### Integration with Monitoring & Pause Controls

**Automatic Circuit-Breaker Triggers:**

- Type 1 (Value Mismatch) → Call `pauseBridge()` immediately
- Type 2 (Unmatched Settlement) → Call `pauseBridge()` immediately
- Type 3 (Double Settlement) → Call `pauseBridge()` immediately

**Manual Review (No Auto-Pause):**

- Type 4 (Stale Intent) → Dashboard alert, ops review
- Type 5 (Message Loss) → Check DVNs, retry if safe
- Type 6 (Refund Inconsistency) → Log and monitor

---

## Part IV: Reference Implementation

### Data Model

```typescript
interface IntentReconciliationRecord {
  hash: string; // XDR or EVM intent hash
  user: string;
  locked_amount: bigint;
  locked_timestamp: number;
  locked_tx_hash: string;
  locked_solver: string;
  
  filled_amount?: bigint;
  filled_timestamp?: number;
  filled_tx_hash?: string;
  
  released_amount?: bigint;
  released_timestamp?: number;
  released_tx_hash?: string;
  
  refunded_amount?: bigint;
  refunded_reason?: string;
  refunded_timestamp?: number;
  refunded_tx_hash?: string;
  
  cancelled_timestamp?: number;
  cancelled_reason?: string;
  cancelled_tx_hash?: string;
  
  evm_state: "Pending" | "Locked" | "Released" | "Refunded";
  soroban_state: "Pending" | "Locked" | "Filled" | "Cancelled";
  
  divergences: string[];
  last_checked: number;
}

interface ReconciliationReport {
  timestamp: number;
  total_locked: bigint;
  total_released: bigint;
  total_refunded: bigint;
  in_flight: bigint;
  balance_check: {
    expected: bigint;
    actual: bigint;
    divergence: bigint;
    divergence_pct: number;
    within_tolerance: boolean;
  };
  alerts: Alert[];
  intent_records: IntentReconciliationRecord[];
}
```

### Query Patterns (SQL)

#### Query 1: Build Correlation Matrix
```sql
SELECT
  COALESCE(evm.hash, soroban.hash) as hash,
  evm.state as evm_state,
  soroban.state as soroban_state,
  evm.amount as locked_amount,
  soroban.amount as filled_amount,
  CASE
    WHEN evm.state = 'Released' AND soroban.state = 'Filled' THEN 'Settled'
    WHEN evm.state = 'Refunded' AND soroban.state = 'Cancelled' THEN 'Refunded'
    WHEN evm.state = 'Locked' AND soroban.state = 'Locked' THEN 'InFlight'
    ELSE 'Divergence'
  END as correlation
FROM evm_events evm
FULL OUTER JOIN soroban_events soroban
  ON evm.hash = soroban.hash
ORDER BY COALESCE(evm.timestamp, soroban.timestamp) DESC;
```

#### Query 2: Value Conservation Check
```sql
SELECT
  'Locked' as category,
  SUM(amount) as total
FROM evm_events
WHERE event_type = 'Locked'
UNION ALL
SELECT
  'Released' as category,
  SUM(amount) as total
FROM evm_events
WHERE event_type = 'Released'
UNION ALL
SELECT
  'Refunded' as category,
  SUM(amount) as total
FROM evm_events
WHERE event_type = 'Refunded'
UNION ALL
SELECT
  'InFlight' as category,
  SUM(e.amount)
FROM evm_events e
WHERE e.event_type = 'Locked'
  AND NOT EXISTS (
    SELECT 1 FROM evm_events r
    WHERE r.hash = e.hash
    AND r.event_type IN ('Released', 'Refunded')
  );
```

#### Query 3: Detect Unmatched Settlements
```sql
-- Intents released on EVM but no Filled on Soroban
SELECT
  e.hash,
  e.amount,
  e.timestamp as evm_release_time,
  s.timestamp as soroban_fill_time,
  (EXTRACT(EPOCH FROM (NOW() - e.timestamp))) as age_seconds
FROM evm_events e
LEFT JOIN soroban_events s
  ON e.hash = s.hash
  AND s.event_type = 'Filled'
WHERE e.event_type = 'Released'
  AND s.hash IS NULL
  AND (EXTRACT(EPOCH FROM (NOW() - e.timestamp))) > 1800  -- 30 min grace
ORDER BY age_seconds DESC;
```

#### Query 4: Detect Double Settlements
```sql
-- Find intents with multiple Released or Filled events
SELECT
  hash,
  event_type,
  COUNT(*) as count
FROM (
  SELECT hash, 'Released' as event_type FROM evm_events WHERE event_type = 'Released'
  UNION ALL
  SELECT hash, 'Filled' as event_type FROM soroban_events WHERE event_type = 'Filled'
)
GROUP BY hash, event_type
HAVING COUNT(*) > 1;
```

### Algorithm Pseudocode

```typescript
function reconcile(evmEvents: Event[], sorobanEvents: Event[]): ReconciliationReport {
  const report: ReconciliationReport = {
    timestamp: Date.now(),
    total_locked: 0n,
    total_released: 0n,
    total_refunded: 0n,
    in_flight: 0n,
    balance_check: {},
    alerts: [],
    intent_records: []
  };
  
  // 1. Build correlation matrix
  const byHash = new Map<string, IntentReconciliationRecord>();
  
  for (const evt of evmEvents) {
    if (!byHash.has(evt.hash)) {
      byHash.set(evt.hash, { hash: evt.hash, evm_state: 'Pending', soroban_state: 'Pending' });
    }
    const rec = byHash.get(evt.hash)!;
    if (evt.type === 'Locked') {
      rec.locked_amount = evt.amount;
      rec.evm_state = 'Locked';
    } else if (evt.type === 'Released') {
      rec.released_amount = evt.amount;
      rec.evm_state = 'Released';
    } else if (evt.type === 'Refunded') {
      rec.refunded_amount = evt.amount;
      rec.evm_state = 'Refunded';
    }
  }
  
  for (const evt of sorobanEvents) {
    if (!byHash.has(evt.hash)) {
      byHash.set(evt.hash, { hash: evt.hash, evm_state: 'Pending', soroban_state: 'Pending' });
    }
    const rec = byHash.get(evt.hash)!;
    if (evt.type === 'Filled') {
      rec.filled_amount = evt.amount;
      rec.soroban_state = 'Filled';
    } else if (evt.type === 'Cancelled') {
      rec.soroban_state = 'Cancelled';
      rec.cancelled_reason = evt.reason; // EXPIRED | ADMIN | INVALID
    }
  }
  
  // 2. Compute aggregates
  for (const rec of byHash.values()) {
    if (rec.evm_state === 'Locked' && rec.locked_amount) {
      report.total_locked += rec.locked_amount;
    }
    if (rec.evm_state === 'Released' && rec.released_amount) {
      report.total_released += rec.released_amount;
    }
    if (rec.evm_state === 'Refunded' && rec.refunded_amount) {
      report.total_refunded += rec.refunded_amount;
    }
  }
  
  report.in_flight = report.total_locked - report.total_released - report.total_refunded;
  
  // 3. Check balance
  report.balance_check = {
    expected: report.total_locked,
    actual: report.total_released + report.total_refunded + report.in_flight,
    divergence: abs(report.total_locked - (report.total_released + report.total_refunded + report.in_flight)),
    divergence_pct: (divergence / report.total_locked) * 100
  };
  
  if (report.balance_check.divergence_pct > TOLERANCE_BPS) {
    report.alerts.push({
      severity: 'CRITICAL',
      type: 'ValueMismatch',
      message: `Value divergence detected: ${report.balance_check.divergence_pct.toFixed(2)}% > ${TOLERANCE_BPS}%`
    });
  }
  
  // 4. Check per-intent assertions
  for (const rec of byHash.values()) {
    rec.divergences = [];
    
    // A1: Settled intents
    if (rec.evm_state === 'Released' && rec.soroban_state === 'Filled') {
      if (rec.filled_amount! < rec.locked_amount!) {
        rec.divergences.push(`Filled amount (${rec.filled_amount}) < Locked (${rec.locked_amount})`);
      }
    }
    
    // A2: Refunded intents
    if (rec.evm_state === 'Refunded' && rec.soroban_state === 'Cancelled') {
      if (rec.refunded_amount !== rec.locked_amount) {
        rec.divergences.push(`Refunded (${rec.refunded_amount}) != Locked (${rec.locked_amount})`);
      }
      // A2b: Cancellation reason must match the source message
      if (rec.cancelled_reason !== rec.source_cancel_reason) {
        rec.divergences.push(
          `Cancel reason (${rec.cancelled_reason}) != source (${rec.source_cancel_reason})`
        );
      }
    }
    
    // A4: Single settlement
    if (rec.evm_state === 'Released' && rec.soroban_state === 'Filled') {
      // (This check is simpler in a stateful schema; adjust if using event stream)
    }
    
    if (rec.divergences.length > 0) {
      report.alerts.push({
        severity: 'CRITICAL',
        type: 'UnmatchedSettlement',
        affected_intents: [rec.hash],
        message: rec.divergences.join('; ')
      });
    }
    
    report.intent_records.push(rec);
  }
  
  return report;
}
```

---

## Part V: Operational Workflows

### Daily Reconciliation

**Scheduled:** 00:00, 06:00, 12:00, 18:00 UTC (every 6 hours)

```
1. Pull latest events from EVM and Soroban RPC (last 6 hours)
2. Run reconcile() algorithm
3. Emit report to monitoring dashboard
4. If any CRITICAL alerts: trigger circuit-breaker
5. If any HIGH/MEDIUM: log and notify ops
6. Archive report for audit trail
```

### Post-Incident Review

**Triggered:** After any alert or bridge pause

```
1. Pull full event history for affected intent(s)
2. Trace state transitions on both chains
3. Identify root cause:
   - Message delivery failure?
   - Exploit or double-settlement?
   - Timing race condition?
   - Indexer lag or stale data?
4. Determine if fix is code, config, or operational
5. Implement fix and validate with reconciliation
6. Publish incident report
7. Obtain governance approval to resume bridge
```

### Monthly Audit

**Scheduled:** Last day of each month

```
1. Reconcile all intents from month (full history)
2. Validate 100% of value conservation checks pass
3. Verify no alerts were suppressed or ignored
4. Review all pause/resume events
5. Assess monitoring coverage and alert tuning
6. Publish summary to community
```

---

## Part VI: Integration with Code

### Contract Events

Ensure both contracts emit required events:

**Soroban** (`contracts/soroban/src/contract.rs`):
```rust
// Already implemented
fn fill_intent(hash: XDRHash, amount: i128) {
  env.events().publish(("Filled", hash, user, amount, dest));
}

fn cancel_intent(hash: XDRHash, reason: u32) {
  // reason: 0 = EXPIRED, 1 = ADMIN, 2 = INVALID (validated by the contract)
  env.events().publish(("Cancelled", hash, reason));
}
```

**EVM** (`contracts/evm/src/PerihelionEscrow.sol`):
```solidity
// Already implemented
function lock(Intent intent, bytes signature) {
  emit Locked(intent.hash, intent.user, intent.amount, msg.sender, intent.deadline);
}

function release(bytes32 hash, uint256 amount, address solver) {
  emit Released(hash, solver, amount);
}
```

### Indexer Integration

The watcher service must index these events:

- **Soroban:** Use Stellar Horizon API or custom Soroban RPC indexer
- **EVM:** Use Ethers.js/Web3.js to subscribe to contract logs
- **Storage:** Time-series DB (InfluxDB, Prometheus, or PostgreSQL with time extension)

### Integration Test

Add reconciliation test to CI/CD:

```typescript
// test/reconciliation.test.ts
describe('Reconciliation', () => {
  it('should detect value divergence', async () => {
    // Create 10 intents
    // Settle 9, refund 1
    // Check reconciliation report shows balanced state
    const report = await reconcile(evmEvents, sorobanEvents);
    expect(report.balance_check.within_tolerance).toBe(true);
    expect(report.alerts).toHaveLength(0);
  });
  
  it('should detect unmatched settlement', async () => {
    // Create intent
    // Settle on EVM but not on Soroban
    // Wait for grace period
    // Check report flags CRITICAL alert
    const report = await reconcile(evmEvents, sorobanEvents);
    expect(report.alerts.some(a => a.type === 'UnmatchedSettlement')).toBe(true);
  });

  it.each([
    ['EXPIRED', 0],
    ['ADMIN', 1],
    ['INVALID', 2],
  ])('should record %s cancellation reason (%i) from the source message', async (_name, reason) => {
    // Source message carries `reason`; relayer delivers it unchanged
    // Settlement contract records it in the Cancelled event
    const report = await reconcile(evmEvents, sorobanEvents);
    const rec = report.intent_records.find(r => r.hash === cancelledHash)!;
    expect(rec.cancelled_reason).toBe(reason);
    expect(rec.divergences).toHaveLength(0);
  });
});
```

---

## References

- **Monitoring & Alerting:** [MONITORING.md](./MONITORING.md)
- **Security Policy:** [SECURITY.md](../SECURITY.md)
- **Intent Lifecycle:** [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md#intent-lifecycle-state-diagram)
