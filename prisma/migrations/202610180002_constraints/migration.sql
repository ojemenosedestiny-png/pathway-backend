CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "HostelBooking" ADD CONSTRAINT "HostelBooking_no_bed_overlap" EXCLUDE USING gist
 ("roomId" WITH =, "bed" WITH =, tsrange("arrival", "departure", '[)') WITH &&)
 WHERE ("status" IN ('HELD','CONFIRMED','CHECKED_IN'));
ALTER TABLE "ConsultationSlot" ADD CONSTRAINT "ConsultationSlot_no_advisor_overlap" EXCLUDE USING gist
 ("advisorId" WITH =, tsrange("startsAt", "endsAt", '[)') WITH &&) WHERE ("active" = true);
ALTER TABLE "HostelBooking" ADD CONSTRAINT "HostelBooking_valid_dates" CHECK ("arrival" < "departure" AND "bed" > 0 AND "amountMinor" >= 0);
ALTER TABLE "ConsultationSlot" ADD CONSTRAINT "ConsultationSlot_valid_dates" CHECK ("startsAt" < "endsAt");
ALTER TABLE "Room" ADD CONSTRAINT "Room_valid_capacity_price" CHECK ("capacity" > 0 AND "priceMinor" >= 0 AND "depositMinor" >= 0);
ALTER TABLE "Exam" ADD CONSTRAINT "Exam_valid_window_capacity_fee" CHECK ("opensAt" < "closesAt" AND "capacity" > 0 AND "feeMinor" >= 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_positive_amount" CHECK ("amountMinor" > 0);
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_percent_range" CHECK ("percent" > 0 AND "percent" < 100);
CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit logs are append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE FUNCTION prevent_id_reuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Student ID reservations are permanent'; END $$;
CREATE TRIGGER id_reservation_permanent BEFORE UPDATE OR DELETE ON "IdReservation" FOR EACH ROW EXECUTE FUNCTION prevent_id_reuse();
