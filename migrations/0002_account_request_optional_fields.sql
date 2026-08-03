-- Make optional applicant profile fields nullable without rebuilding the table.
-- The temporary-column approach preserves row ids and all related foreign keys.
ALTER TABLE account_requests ADD COLUMN company_optional TEXT;
UPDATE account_requests SET company_optional = NULLIF(TRIM(company), '');
ALTER TABLE account_requests DROP COLUMN company;
ALTER TABLE account_requests RENAME COLUMN company_optional TO company;

ALTER TABLE account_requests ADD COLUMN department_optional TEXT;
UPDATE account_requests SET department_optional = NULLIF(TRIM(department), '');
ALTER TABLE account_requests DROP COLUMN department;
ALTER TABLE account_requests RENAME COLUMN department_optional TO department;

ALTER TABLE account_requests ADD COLUMN job_title_optional TEXT;
UPDATE account_requests SET job_title_optional = NULLIF(TRIM(job_title), '');
ALTER TABLE account_requests DROP COLUMN job_title;
ALTER TABLE account_requests RENAME COLUMN job_title_optional TO job_title;

ALTER TABLE account_requests ADD COLUMN admin_message TEXT;
