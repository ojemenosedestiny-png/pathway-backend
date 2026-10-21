# Student portal on application acceptance

The owner authorised issuing a Student ID when admissions accepts a guest application, before fee payment. Submission alone still creates no account. Saving ACCEPTED creates the student account and ID, queues a one-use 24-hour password-setup email, and records the ID in the review audit transaction. Students choose their own password through the link and sign in to continue registration. Passwords are never emailed or returned to administrators.

The durable outbox key is `admission-portal:<application id>`. Repeated approval creates no duplicate account, ID or email and does not invalidate the setup link. Previously accepted applications can be saved as ACCEPTED again to trigger this flow. Deployment sends no historical emails automatically. For expired links use the existing student credentials resend action.

Delivery uses the existing email worker, configured Resend API key and sender, including its existing retry behaviour. A queued notification does not mean delivery has completed. The regression test simulates Resend; no live applicant email is sent during testing.

Students begin at Registration in progress. Approval does not create a payment, receipt, paid invoice or official exam registration. Existing active students retain their account and password. Verified applicant accounts are promoted in place; staff/inactive accounts and unverified existing applicant emails cause a clear conflict. Deploy backend before the companion frontend copy. No schema migration is added.
