/** Logbook screen - one book per page.
 *
 * The book arrives as a prop from the route rather than being read out of the params here.
 * Read from the params it came from a context the animated outlet can hand over one render
 * late, and the engineer's table stayed on screen under the officer's heading; a prop is
 * carried by the element the route matched, so it cannot be a render behind the address.
 */
import LogbookMarine, { LogbookChooser, type LogBook } from "siparu-ui/screens/logbook";

export default function Logbook({ book }: { book?: LogBook }) {
  return book ? <LogbookMarine book={book} /> : <LogbookChooser />;
}
