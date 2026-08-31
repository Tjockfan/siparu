/** How to close the server's door, read at the boat: the admin pages are on this same server. */
import SecurityHelp, { ADMIN_SECURITY } from "siparu-ui/screens/security";

export default function SecurityHelpAboard() {
  return <SecurityHelp admin={ADMIN_SECURITY} />;
}
