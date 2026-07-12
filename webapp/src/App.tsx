import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import AuthGate from "./components/AuthGate";
import BoatLoader from "./components/BoatLoader";
import Layout from "./components/Layout";
import Bridge from "./routes/Bridge";
import { AUTH_REQUIRED_EVENT } from "./lib/api";

// Code-splitting: heavy tabs get their own chunk (Map -> MapLibre). Telemetry is
// eager - it's the entry screen and should appear instantly.
const Logbook = lazy(() => import("./routes/Logbook"));
const Voyage = lazy(() => import("./routes/Voyage"));
const MapView = lazy(() => import("./routes/Map"));

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
  return (
    <ErrorBoundary>
      <Suspense fallback={<BoatLoader full />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Bridge />} />
            <Route path="/logbook" element={<Logbook />} />
            <Route path="/voyage" element={<Voyage />} />
            <Route path="/map" element={<MapView />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
