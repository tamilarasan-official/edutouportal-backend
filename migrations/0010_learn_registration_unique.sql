-- 0010_learn_registration_unique.sql
-- One registration per person per course on learn.edutou.in.
--
-- `course` records which course/batch the sign-up was for (the "Course name"
-- set in Admin -> Learn Page). The same email, or the same WhatsApp number,
-- may register once per course; a new course name opens registration again.
--
-- Rows from before this migration get the default course name. Any duplicates
-- among them are reduced to the earliest sign-up so the unique indexes can be
-- built (production had no rows when this was written).

ALTER TABLE learn_registrations
  ADD COLUMN course text NOT NULL DEFAULT 'Free AI Webinar';

DELETE FROM learn_registrations r
 USING learn_registrations keep
 WHERE r.course = keep.course
   AND (lower(r.email) = lower(keep.email) OR r.whatsapp = keep.whatsapp)
   AND (keep.created_at, keep.id) < (r.created_at, r.id);

CREATE UNIQUE INDEX learn_registrations_course_email_key
  ON learn_registrations (course, lower(email));

CREATE UNIQUE INDEX learn_registrations_course_whatsapp_key
  ON learn_registrations (course, whatsapp);
