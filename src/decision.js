// Decision engine for the Proof Gatekeeper track (zkVerify Agent Games).
// Pure field checks over the task input. No I/O, no secrets.
// Source: event page "Trap encyclopedia" + "Agent build checklist"
// (see ../docs/protocol-spec.md §4).

// Trap precedence when several traps apply: sources never state an order.
// Chosen fixed order (documented; confirm via practice mode):
//   reuse -> VK -> threshold -> expiry -> recipient -> amount
// Rationale: reuse is the only trap with no proof to submit, so it must be
// decided before proving; the rest follow the trap-table order.

export const REASON = {
  VALID: "VALID_CONDITION",
  VK: "VK_SUBSTITUTION",
  THRESHOLD: "THRESHOLD_MISMATCH",
  REUSED: "PROOF_REUSED",
  EXPIRED: "EXPIRED_CONDITION",
  RECIPIENT: "RECIPIENT_MISMATCH",
  AMOUNT: "AMOUNT_OVERFLOW",
};

function normHex(v) {
  return String(v ?? "").trim().toLowerCase();
}

function toBig(v) {
  // Amounts/balances are decimal strings; never compare as float.
  return BigInt(String(v).trim());
}

/**
 * Evaluate a gatekeeper task.
 * @param {object} input - task.input from the platform envelope
 * @param {function} isSeen - async (proofTx) => boolean, checks the seen-set
 * @returns {{decision: "APPROVE"|"REJECT", reason_code: string, traps: string[]}}
 *   traps lists EVERY trap detected (for logging); reason_code is the first
 *   in precedence order.
 */
export async function decide(input, isSeen) {
  const traps = [];

  // 1. Reuse — proof_tx already accepted in a previous task.
  const proofTx = normHex(input.proof_tx);
  if (proofTx && (await isSeen(proofTx))) traps.push(REASON.REUSED);

  // 2. VK substitution — proof VK must equal the registered condition VK.
  if (normHex(input.proof_vk) !== normHex(input.registered_vk)) traps.push(REASON.VK);

  // 3. Threshold — public_balance must meet or exceed minimum.
  // Boundary: balance == minimum is VALID ("meets or exceeds").
  if (toBig(input.public_balance) < toBig(input.minimum)) traps.push(REASON.THRESHOLD);

  // 4. Expiry — expired when current_block >= expiry_block.
  // Boundary PROVEN by the circuit probe (T7/T8): current == expiry with
  // decision=1 FAILS the circuit; decision=0 verifies. So equality counts
  // as expired (the condition is only valid strictly before expiry).
  if (Number(input.current_block) >= Number(input.expiry_block)) traps.push(REASON.EXPIRED);

  // 5. Recipient mismatch.
  if (normHex(input.recipient) !== normHex(input.condition_recipient)) traps.push(REASON.RECIPIENT);

  // 6. Amount overflow — amount must be within the single-transfer cap.
  // Boundary: amount == max_transfer is VALID ("approve only up to the cap").
  if (toBig(input.amount) > toBig(input.max_transfer)) traps.push(REASON.AMOUNT);

  if (traps.length === 0) {
    return { decision: "APPROVE", reason_code: REASON.VALID, traps: [] };
  }
  return { decision: "REJECT", reason_code: traps[0], traps };
}
