/** Motion tokens.
 *  Springs are for physical interactions only (drag-release); use tweens for opacity/color.
 *  No overshoot/bounce. Exits are ALWAYS shorter than enters (M3 asymmetry rule).
 *  Bridge values use ≤200ms tweens, never springs (at sea, overshoot looks broken). */
export const ease = {
  out: [0.16, 1, 0.3, 1] as const, // entrances, workhorse
  in: [0.4, 0, 1, 1] as const, // exits (legacy)
  exit: [0.3, 0, 0.8, 0.15] as const, // M3 emphasizedAccelerate - fast exit
  sheet: [0.32, 0.72, 0, 1] as const, // iOS sheet curve (Vaul/Ionic)
  snap: [0.12, 0, 0.08, 1] as const, // toggles/tabs
};

export const spring = {
  press: { type: "spring", stiffness: 400, damping: 28 } as const,
  sheet: { type: "spring", stiffness: 300, damping: 30 } as const,
  list: { type: "spring", stiffness: 200, damping: 26 } as const,
};

export const dur = { micro: 0.14, exit: 0.14, base: 0.22, lg: 0.36, sheet: 0.5 };

/** Vaul VELOCITY_THRESHOLD (0.4 px/ms) - Motion reports velocity in px/s. */
export const SHEET_DISMISS_VELOCITY = 400;
