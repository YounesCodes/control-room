import { Modal } from "./Modal";
import { ReleaseNotes } from "./ReleaseNotes";
import { releaseNotesAreEmpty } from "../lib/release-notes";
import type { PendingUpdateNotice } from "../types";

/**
 * Shown once, after an update has actually been installed.
 *
 * Informational only. It reuses `Modal`, so it inherits the focus trap, initial
 * focus, Escape handling, and focus restoration every other dialog already has,
 * rather than reimplementing any of that for an announcement.
 */
export function WhatsNewDialog({
  notice,
  onDismiss,
}: {
  notice: PendingUpdateNotice;
  onDismiss: () => void;
}) {
  const empty = releaseNotesAreEmpty(notice.notes);

  return (
    <Modal title={`What's new in v${notice.version}`} onClose={onDismiss}>
      <div className="form-stack whats-new">
        {empty ? (
          // Saying nothing changed would be a claim about a release Control
          // Room cannot read. Stating the fact it does know is enough.
          <p className="modal-copy">Control Room was updated to v{notice.version}.</p>
        ) : (
          <ReleaseNotes notes={notice.notes} label={`Changes in version ${notice.version}`} />
        )}
        <footer className="modal-actions">
          <button className="primary-button" type="button" onClick={onDismiss}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}
