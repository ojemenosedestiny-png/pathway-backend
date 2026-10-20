# Application acceptance email

Saving an application as ACCEPTED now queues an encrypted acceptance notification in the same transaction as the status and audit update. It includes the programme, application reference, admissions contact link and a clear explanation that registration and Student ID issuance remain separate. Internal review comments are excluded.

The durable outbox key is `admission-accepted:<application id>`. Repeated approval does not create another email job. An application accepted before this release can be saved as ACCEPTED again to queue its first notification. No historical applicants are emailed automatically during deployment.

Delivery uses the existing email worker, configured Resend API key and sender, including its existing retry behaviour. A queued notification does not mean delivery has completed. The regression test simulates Resend; no live applicant email is sent during testing.

No Student ID, password or portal account is created by this action. Existing confirmed-registration flows remain responsible for those.
