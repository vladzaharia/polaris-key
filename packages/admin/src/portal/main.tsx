import React from "react";
import { createRoot } from "react-dom/client";
import { PortalApp } from "./App.js";
import "../styles.css";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <PortalApp />
    </React.StrictMode>,
  );
