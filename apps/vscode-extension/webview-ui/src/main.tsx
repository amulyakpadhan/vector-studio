import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// The studio's real stylesheet, reused verbatim.
import "@/app/globals.css";

// VS Code webviews don't implement window.confirm/alert (they no-op). A couple
// of destructive actions in the reused UI gate on confirm(); make it proceed so
// those actions work. (A native VS Code confirmation dialog is a follow-up.)
window.confirm = () => true;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
