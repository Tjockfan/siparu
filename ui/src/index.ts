/* Single entry of the shared design system. Every consumer imports primitives
 * from here (and the theme from ./swiss.css), so the screens cannot fork. */
export { default as Sheet } from "./Sheet";
export { default as Sparkline } from "./Sparkline";
export * from "./icons";
export * from "./motion";
