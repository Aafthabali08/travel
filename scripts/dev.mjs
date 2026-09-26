import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";

async function checkPort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `Port ${port} is already in use. Stop the existing RouteWise terminal with Ctrl+C before restarting. No existing process was stopped.`
            : `Cannot use port ${port}: ${error.message}`,
        ),
      );
    });
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
try {
  await checkPort(5178);
  await checkPort(8018);
} catch (error) {
  console.error(`[STARTUP ERROR] ${error.message}`);
  process.exit(1);
}
mkdirSync("logs", { recursive: true });
const output = createWriteStream("logs/development.log", { flags: "a" });
const children = new Set();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  if (!children.size) output.end();
}
function start(label, command, args) {
  const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      const line = `[${label}] ${chunk}`;
      process.stdout.write(line);
      if (!output.writableEnded) output.write(line);
    });
  child.on("error", (error) => {
    console.error(`[${label} ERROR] ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  child.on("close", (code) => {
    children.delete(child);
    if (!stopping) {
      process.exitCode = code || 1;
      stop();
    }
    if (!children.size && !output.writableEnded) output.end();
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
start("API", ".venv/bin/python", [
  "-m",
  "uvicorn",
  "backend.app.main:app",
  "--host",
  "127.0.0.1",
  "--port",
  "8018",
  "--no-access-log",
]);
start("WEB", "node", ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]);
console.log(
  "Starting RouteWise: http://127.0.0.1:5178 • API: http://127.0.0.1:8018/docs • logs/development.log",
);
