import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import AuthGate from "./components/AuthGate";
import { BoatLoader } from "siparu-ui/shell";
import { ApiProvider } from "siparu-ui/data";
import Layout from "./components/Layout";
import Bridge from "./routes/Bridge";
import { api, AUTH_REQUIRED_EVENT } from "./lib/api";

// Code-splitting: heavy tabs get their own chunk (Map -> MapLibre). Telemetry is
// eager - it's the entry screen and should appear instantly.
const Logbook = lazy(() => import("./routes/Logbook"));
const Voyage = lazy(() => import("./routes/Voyage"));
const MapView = lazy(() => import("./routes/Map"));
const Remote = lazy(() => import("./routes/Remote"));
// Reached from the open-door notice and from the mark it leaves behind, never from the nav:
// it is a page about a condition, and a boat whose server is secured has no use for it.
const SecurityHelp = lazy(() => import("./routes/SecurityHelp"));

export default function App() {
  // On a Signal K security 401, the whole tree is swapped out for AuthGate - as the
  // screens unmount their polls stop too, and AuthGate becomes the owner of the probe.
  const [authRequired, setAuthRequired] = useState(false);
  useEffect(() => {
    const on = () => setAuthRequired(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, on);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, on);
  }, []);

  if (authRequired) return <AuthGate />;
  // The screens are shared with the shore and read the boat through this provider: here she
  // is the plugin's own routes, same-origin. The screens sit at the root, so no route base.
  return (
    <ApiProvider api={api}>
    <ErrorBoundary>
      <Suspense fallback={<BoatLoader full />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Bridge />} />
            {/* The door and the two books it opens. Each book is its own route with its own
                element rather than one route reading a param: the page then depends on nothing
                but the element the router matched. */}
            <Route path="/logbook" element={<Logbook />} />
            <Route path="/logbook/bridge" element={<Logbook book="bridge" />} />
            <Route path="/logbook/engine" element={<Logbook book="engine" />} />
            <Route path="/voyage" element={<Voyage />} />
            <Route path="/map" element={<MapView />} />
            <Route path="/remote" element={<Remote />} />
            <Route path="/security" element={<SecurityHelp />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
    </ApiProvider>
  );
}
