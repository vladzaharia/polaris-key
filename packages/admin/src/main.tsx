import React from "react";
import { createRoot } from "react-dom/client";
import { applyStoredMotionPreference } from "./components/motionPreference.js";
import { App } from "./App.js";
import "./styles.css";
import "./motion.css";

// The reduce-motion preference (MO-12) lands on <html data-motion> before the first render.
applyStoredMotionPreference();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
