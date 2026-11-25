-- 0013_razorpay.sql
-- Online payment for paid programmes through Razorpay.
--
-- An enrolment for a programme that collects payment online is saved as
-- payment_status 'pending' with the Razorpay order created for it, and
-- becomes 'paid' (payment_reference = Razorpay payment id) once the checkout
-- signature or the payment webhook is verified. Confirmation and team emails
-- for these enrolments are sent only after payment.

ALTER TABLE enrolments ADD COLUMN razorpay_order_id text;

CREATE UNIQUE INDEX enrolments_razorpay_order_key ON enrolments (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL;
