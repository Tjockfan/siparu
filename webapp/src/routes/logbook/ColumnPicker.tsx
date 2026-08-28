/**
 * Which of this book's columns the table draws.
 *
 * A panel rather than a popover: on a phone the choice is the whole screen's business for a
 * moment, and a floating layer over a table that scrolls sideways is a fight nobody wins.
 *
 * It used to hold both books and the presets that moved between them. The page is one book
 * now, so the choice inside it is one list: a reader on the engineer's page is not choosing
 * between logs, he is already in one.
 *
 * Nothing here touches the table until "Show these columns" is pressed. That is the point of
 * the draft: the reader filling in a watch does not want columns appearing and vanishing under
 * the cursor while he makes up his mind, and a picker that applied on every tap would reflow
 * the rows he is reading. Cancel throws the draft away.
 */
import { useState } from "react";
import type { LogColumn } from "./columns";
import {
  isOn,
  offerable,
  same,
  withAll,
  withToggled,
  type ColumnSelection,
} from "./columnSelection";

export default function ColumnPicker({
  cols,
  applied,
  onApply,
  onCancel,
}: {
  cols: LogColumn[];
  applied: ColumnSelection;
  onApply: (sel: ColumnSelection) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ColumnSelection>(applied);
  const unchanged = same(draft, applied);
  const mine = offerable(cols);
  const on = mine.filter((c) => isOn(c, draft)).length;

  return (
    <div className="lb-pick">
      <div className="lbp-book">
        <div className="lbp-h">
          <span className="lbp-n">Columns</span>
          <span className="lbp-s">
            {on} of {mine.length}
          </span>
          <span className="lbp-all">
            <button onClick={() => setDraft(withAll(cols, true))}>All</button>
            <button onClick={() => setDraft(withAll(cols, false))}>None</button>
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

      <div className="lbp-act">
        <button onClick={onCancel}>Cancel</button>
        <button className="lbp-go" disabled={unchanged} onClick={() => onApply(draft)}>
          Show these columns
        </button>
      </div>
    </div>
  );
}
