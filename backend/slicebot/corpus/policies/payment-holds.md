# Payment Holds and Duplicate-Looking Charges

Policy owner: Payments. Version 2.0, effective 2026-05-12.

## Why customers see two charges
When an order is placed, SliceBot places a temporary authorization hold for the order total. When the order is delivered, the final amount is captured as a separate transaction. For a short time the customer's bank may show both the hold and the final charge, which looks like a double charge.

## When the hold disappears
The authorization hold is released automatically by SliceBot at delivery. Most banks remove the pending hold within 3 to 5 business days. The customer is only ever billed once.

## How to confirm a real duplicate
A real duplicate charge shows two captured (settled) transactions for the same order. A pending authorization plus one settled capture is not a duplicate and must not be refunded. Real duplicates are refunded in full and flagged to the Payments team.
