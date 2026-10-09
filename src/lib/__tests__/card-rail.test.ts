import { describe, expect, it } from 'vitest';
import {
  CARD_RAIL_UNAVAILABLE_MESSAGE,
  CREATOR_NO_CARD_RAIL_MESSAGE,
  NO_CARD_RAIL_MESSAGE,
  cardRailFailure,
  payErrorCode,
} from '../card-rail';

describe('cardRailFailure (#2773)', () => {
  it('maps SELLER_NO_CARD_RAIL to a plain 400', () => {
    expect(cardRailFailure('SELLER_NO_CARD_RAIL')).toEqual({
      message: NO_CARD_RAIL_MESSAGE,
      status: 400,
      code: 'SELLER_NO_CARD_RAIL',
    });
  });

  it.each(['CARD_RAIL_KEY_MISSING', 'CARD_RAIL_KEY_REJECTED', 'CARD_RAIL_UNAVAILABLE', 'CARD_RAIL_REQUEST_REJECTED'])(
    'maps %s to a plain 502 and keeps the code',
    (code) => {
      expect(cardRailFailure(code)).toEqual({ message: CARD_RAIL_UNAVAILABLE_MESSAGE, status: 502, code });
    },
  );

  it.each([undefined, null, '', 'SUBSCRIPTION_NOT_SUPPORTED', 'CARD_RAIL_SOMETHING_NEW', 502, {}])(
    'returns null for %j so the caller keeps its own handling',
    (code) => {
      expect(cardRailFailure(code)).toBeNull();
    },
  );

  it('never uses the generic checkout failure wording', () => {
    for (const message of [NO_CARD_RAIL_MESSAGE, CREATOR_NO_CARD_RAIL_MESSAGE, CARD_RAIL_UNAVAILABLE_MESSAGE]) {
      expect(message).not.toMatch(/unable to start checkout|payment initiation failed/i);
    }
  });
});

describe('payErrorCode', () => {
  it('reads the code from a JSON error body', () => {
    expect(payErrorCode('{"error":"x","code":"SELLER_NO_CARD_RAIL"}')).toBe('SELLER_NO_CARD_RAIL');
  });

  it.each(['', 'boom', '<html>bad gateway</html>', '{}', '{"code":42}', 'null', '"text"', '[]'])(
    'returns undefined for %j',
    (body) => {
      expect(payErrorCode(body)).toBeUndefined();
    },
  );
});
