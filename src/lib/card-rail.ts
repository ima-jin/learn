/**
 * Card-rail outcomes from pay's `POST /api/checkout` (ima-jin/imajin-ai#2757, #2773).
 *
 * Stripe Connect is gone: a paid enrollment is charged on the COURSE CREATOR'S OWN Stripe
 * account through their BYO connector. A creator with no connected key gets a 400 with the
 * stable `code: "SELLER_NO_CARD_RAIL"`; a creator whose Stripe account would not take the
 * charge gets a 502 with a `CARD_RAIL_*` code. Neither is a server fault, so neither may
 * surface as a generic "Payment initiation failed".
 *
 * Learn has no e-Transfer path, so the message offers none.
 */

/** Pay's stable code when the course creator has no card rail (no connected Stripe key). */
export const SELLER_NO_CARD_RAIL = 'SELLER_NO_CARD_RAIL';

/** What a student is told when the creator has not set up card payments. */
export const NO_CARD_RAIL_MESSAGE =
  "Card payments aren't set up for this course yet. Please contact the course creator about another way to pay.";

/** What the creator sees on their own course when they have no card rail. */
export const CREATOR_NO_CARD_RAIL_MESSAGE =
  "Card payments aren't set up. Students can't pay by card until you connect your Stripe key under Connectors.";

/** What a student is told when the creator's Stripe account could not start the charge. */
export const CARD_RAIL_UNAVAILABLE_MESSAGE =
  "Card payment couldn't be started on the course creator's Stripe account. Please try again later or contact the course creator.";

/** Pay's `CARD_RAIL_*` codes: the creator has a key, but their Stripe account would not take the charge. */
const CARD_RAIL_FAILURE_CODES = new Set([
  'CARD_RAIL_KEY_MISSING',
  'CARD_RAIL_KEY_REJECTED',
  'CARD_RAIL_UNAVAILABLE',
  'CARD_RAIL_REQUEST_REJECTED',
]);

export interface CardRailFailure {
  /** Plain, student-facing sentence. */
  message: string;
  status: number;
  /** The pay code, passed through so the page can react to it. */
  code: string;
}

/**
 * Map a pay checkout error `code` to a plain student-facing failure, or `null` when the code is
 * not a card-rail outcome (the caller then keeps its own handling).
 */
export function cardRailFailure(code: unknown): CardRailFailure | null {
  if (code === SELLER_NO_CARD_RAIL) {
    return { message: NO_CARD_RAIL_MESSAGE, status: 400, code: SELLER_NO_CARD_RAIL };
  }
  if (typeof code === 'string' && CARD_RAIL_FAILURE_CODES.has(code)) {
    return { message: CARD_RAIL_UNAVAILABLE_MESSAGE, status: 502, code };
  }
  return null;
}

/** The `code` of a pay error body, or `undefined` when the body is not JSON or carries none. */
export function payErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      const { code } = parsed as { code?: unknown };
      return typeof code === 'string' ? code : undefined;
    }
  } catch {
    // Not JSON — no code.
  }
  return undefined;
}
