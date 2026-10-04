import React from "react";
import { createRoot } from "react-dom/client";
import {
  MantineProvider,
  createTheme,
  Button,
  ActionIcon,
} from "@mantine/core";
import { App } from "./App";
import "@mantine/core/styles.css";
import "./styles.css";

const theme = createTheme({
  primaryColor: "blue",
  primaryShade: 6,
  colors: {
    blue: [
      "#edf5ff",
      "#dceaff",
      "#b8d5ff",
      "#8cbbff",
      "#609fff",
      "#3885f5",
      "#1769e0",
      "#1258c2",
      "#124a9e",
      "#143f80",
    ],
  },
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: "inherit", fontWeight: "650" },
  defaultRadius: "md",
  respectReducedMotion: true,
  components: {
    Button: Button.extend({ defaultProps: { size: "md" } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { size: 44 } }),
  },
});
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} forceColorScheme="light">
    <App />
  </MantineProvider>,
);
