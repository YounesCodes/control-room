import { parseReleaseNotes } from "../lib/release-notes";

export function ReleaseNotes({ notes, label }: { notes: string | null; label?: string }) {
  const blocks = parseReleaseNotes(notes);
  if (!blocks.length) return null;

  return (
    <div className="release-notes" aria-label={label}>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h4 className="release-notes-heading" key={index}>
              {block.text}
            </h4>
          );
        }
        if (block.kind === "bullets") {
          return (
            <ul className="release-notes-list" key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          );
        }
        return (
          <p className="release-notes-paragraph" key={index}>
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
