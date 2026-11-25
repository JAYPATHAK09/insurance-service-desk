/**
 * Notices and errors travel in redirect URLs as short codes and are mapped to fixed text here, so a
 * crafted link can never put its own wording (or document text) on a page.
 */
export const NOTICES: Record<string, string> = {
  uploaded: 'Document uploaded.',
  duplicate: 'This exact file is already attached to the case; nothing was added.',
  status_updated: 'Status updated.',
  reopened: 'Case reopened and recorded in the audit trail.',
  review_complete: 'Review complete.',
  review_reused: 'Same documents and model: the existing review was reused.',
  review_running: 'A review is already running.',
  decision_recorded: 'Decision recorded.',
  dc_complete: 'Comparison complete. Nothing was submitted or changed in the proposal.',
  dc_reused: 'Same documents and model: the existing comparison was reused.',
  dc_escalated: 'Escalated to a supervisor. The finding stays open.',
  dc_resolved: 'Resolution recorded. The proposal itself was not changed.',
  dc_approved: 'Reconciliation approved. This is an advisor record, not an underwriting decision.',
  cr_verified: 'Verification decision recorded.',
  cr_corrected: 'Classification corrected; the earlier value is kept in the history.',
  cr_draft_ready: 'Draft marked ready by the handler. It has not been sent anywhere.',
  cr_supervisor_approved: 'Supervisor approval recorded. Nothing has been sent.',
  ra_corrected: 'Classification corrected; the previous value is kept in the history.',
  ra_approved: 'Explanation approved by supervisor. The platform does not send it: the advisor sends it outside the platform.',
  ra_acknowledged: 'Customer acknowledgement recorded.',
};

export const ERRORS: Record<string, string> = {
  choose_file: 'Choose a file to upload.',
  file_type: 'Only PDF, TXT and CSV files are accepted.',
  file_empty: 'The file is empty.',
  file_too_large: 'The file is too large.',
  not_pdf: 'The file content is not a PDF.',
  too_many_pages: 'The PDF has too many pages.',
  too_many_files: 'This case has reached the maximum number of files for the demo.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  ingest_failed: 'The file could not be stored.',
  workflow_refused: 'That status change is not allowed for this case right now.',
  review_failed: 'The review could not be run. Check that the documents are uploaded and try again.',
  finding_refused: 'That decision could not be recorded for this finding.',
  model_failed: 'The model step could not be completed. Nothing was changed.',
  claim_refused: 'That action is not allowed on this draft right now.',
  renewal_refused: 'That action is not allowed on this renewal right now.',
  invalid_form: 'Please check the form fields and try again.',
};

/** Own-property lookup only: `?error=constructor` or `__proto__` must not resolve to anything. */
export function messageFor(map: Record<string, string>, code: string | undefined): string | undefined {
  return code && Object.hasOwn(map, code) ? map[code] : undefined;
}
