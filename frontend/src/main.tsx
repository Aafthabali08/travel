import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App, { ErrorBoundary } from "./App";
import { AuthProvider } from "./auth";
import "./styles.css";

const Support = lazy(() => import("./Support"));
const Admin = lazy(() => import("./Admin"));

// Hash routes (#/support, #/admin/...) work on the dev server and the static backend alike.
function useHashRoute() {
  const read = () =>
    location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const onHash = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return parts;
}

function Root() {
  const [page, ...rest] = useHashRoute();
  const other = page === "support" || page === "admin";
  return (
    <>
      {/* The planner stays mounted so a journey in progress survives a trip to Help. */}
      <div hidden={other}>
        <App />
      </div>
      {other && (
        <Suspense fallback={<div className="page-loading">Loading…</div>}>
          {page === "support" ? (
            <Support ticketId={rest[0]} />
          ) : (
            <Admin tab={rest[0]} itemId={rest[1]} />
          )}
        </Suspense>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </ErrorBoundary>,
);
