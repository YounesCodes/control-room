import { Modal } from "./Modal";
import { ReleaseNotes } from "./ReleaseNotes";
import { releaseNotesAreEmpty } from "../lib/release-notes";
import type { PendingUpdateNotice } from "../types";

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
