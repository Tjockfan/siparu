/* Siparu - centered dialog primitive (Swiss). Scrim + centered panel.
 * Rendered inside a .sp-screen (position:relative) so it anchors to the screen.
 *
 * The previous bottom-sheet (slid up from the bottom, drag-to-dismiss) pushed
 * the screen upward when the keyboard opened on iOS, and swipe-down was
 * unreliable. It is now a CENTERED dialog that does not cover the full screen;
 * clicking the scrim (outside the panel) dismisses it. Enter is opacity+scale
 * (no overshoot), exit is shorter (M3 asymmetry). Drag physics removed.
 * The parent API is unchanged: closeRef runs the exit animation for dismissals
 * triggered from within (onClose fires once the animation completes). */
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { dur, ease } from "./motion";
import { Close } from "./icons";

type Props = {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  /** optional tab strip (Manual / Scan) rendered under the head. */
  tabs?: ReactNode;
  /** optional footer action row. */
  footer?: ReactNode;
  /** body gets default padding+gap; pass false for full-bleed lists. */
  padded?: boolean;
  /** imperative close channel: dismissals triggered from within (e.g. on a
   *  successful submit) should call closeRef.current?.() instead of calling
   *  onClose DIRECTLY, so the exit animation runs (onClose fires once the
   *  animation completes). */
  closeRef?: { current: (() => void) | null };
};

export default function Sheet({ title, eyebrow, onClose, children, tabs, footer, padded = true, closeRef }: Props) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => setOpen(false);

  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = close;
    return () => {
      closeRef.current = null;
    };
  }, [closeRef]);

  return (
    <AnimatePresence onExitComplete={onClose}>
      {open && (
        <motion.div
          key="scrim"
          className="scrim"
          onClick={close}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.18 } }}
          exit={{ opacity: 0, transition: { duration: dur.exit } }}
        >
          <motion.div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            // Prevent clicks inside the panel from reaching the scrim and closing it.
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: dur.base, ease: ease.out } }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: dur.exit, ease: ease.exit } }}
          >
            <div className="sheet-head">
              <div>
                {eyebrow && <div className="sheet-eyebrow">{eyebrow}</div>}
                <span className="sheet-title">{title}</span>
              </div>
              <button type="button" className="sheet-x" onClick={close} aria-label="Close">
                <Close size={16} />
              </button>
            </div>
            {tabs}
            {padded ? <div className="sheet-body">{children}</div> : children}
            {footer && <div className="sheet-foot">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
