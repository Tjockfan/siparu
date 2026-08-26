/**
 * The two books, and which of their columns this table draws.
 *
 * A panel rather than a popover: on a phone the choice is the whole screen's business for a
 * moment, and a floating layer over a table that scrolls sideways is a fight nobody wins.
 *
 * Nothing here touches the table until "Show these columns" is pressed. That is the point of
 * the draft: the reader filling in a watch does not want columns appearing and vanishing under
 * the cursor while he makes up his mind, and a picker that applied on every tap would reflow
 * the rows he is reading. Cancel throws the draft away.
 */
import { useState, type CSSProperties } from "react";
import type { LogBook, LogColumn } from "./columns";
import {
  bookColumns,
  isOn,
  preset,
  presetOf,
  same,
  withBook,
  withToggled,
  type ColumnSelection,
  type Preset,
} from "./columnSelection";

const BOOKS: { key: LogBook; name: string; keeper: string }[] = [
  { key: "bridge", name: "Bridge", keeper: "Chief officer" },
  { key: "engine", name: "Engine", keeper: "Chief engineer" },
];

const PRESETS: { key: Preset; name: string }[] = [
  { key: "deck", name: "Deck log" },
  { key: "engine", name: "Engine log" },
  { key: "both", name: "Both" },
];

export default function ColumnPicker({
  cols,
  applied,
  onApply,
  onCancel,
  style,
}: {
  cols: LogColumn[];
  applied: ColumnSelection;
  onApply: (sel: ColumnSelection) => void;
  onCancel: () => void;
  /** The lane count, so this panel is as wide as the windows it sits between. */
  style?: CSSProperties;
}) {
  const [draft, setDraft] = useState<ColumnSelection>(applied);
  const now = presetOf(draft, cols);
  const unchanged = same(draft, applied);
  // A boat with no engine gauges has no engineer's book, and the presets that name one are not
  // offered either: the same rule as everywhere else, one level up.
  const books = BOOKS.filter((b) => bookColumns(cols, b.key).length > 0);
  const presets = books.length > 1 ? PRESETS : PRESETS.slice(0, 1);

  return (
    <div className="lb-pick" style={style}>
      {presets.length > 1 && (
        <div className="lbp-presets">
          <span className="lbp-k">Book</span>
          {presets.map((p) => (
            <button
              key={p.key}
              className={now === p.key ? "on" : ""}
              onClick={() => setDraft(preset(p.key, cols))}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="lbp-books">
        {books.map((b) => {
          const mine = bookColumns(cols, b.key);
          const on = mine.filter((c) => isOn(c, draft)).length;
          return (
            <div className="lbp-book" key={b.key}>
              <div className="lbp-h">
                <span className="lbp-n">{b.name}</span>
                <span className="lbp-s">
                  {b.keeper} · {on} of {mine.length}
                </span>
                <span className="lbp-all">
                  <button onClick={() => setDraft(withBook(draft, cols, b.key, true))}>All</button>
                  <button onClick={() => setDraft(withBook(draft, cols, b.key, false))}>None</button>
                </span>
              </div>
              <div className="lbp-chips">
                {mine.map((c) => (
                  <button
                    key={c.key}
                    className={`lbp-c${isOn(c, draft) ? " on" : ""}`}
                    aria-pressed={isOn(c, draft)}
                    onClick={() => setDraft(withToggled(draft, c))}
                  >
                    {c.head}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="lbp-act">
        <button onClick={onCancel}>Cancel</button>
        <button className="lbp-go" disabled={unchanged} onClick={() => onApply(draft)}>
          Show these columns
        </button>
      </div>
    </div>
  );
}
