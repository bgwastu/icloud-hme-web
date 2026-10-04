import { spawn } from "node:child_process";

const children = [
  spawn("npx", ["wrangler", "dev", "--ip", "127.0.0.1", "--port", "8787"], {
    stdio: "inherit",
  }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];
function stop() {
  for (const child of children) child.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children)
  child.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 1;
  });
