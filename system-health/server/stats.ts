import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const GiB = 1024 ** 3;

type CpuTimes = { idle: number; total: number };

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let previous: CpuTimes | null = null;

/** CPU busy share since the previous call (first call samples 500 ms). */
async function cpu() {
  if (!previous) {
    previous = cpuTimes();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const now = cpuTimes();
  const total = now.total - previous.total;
  const idle = now.idle - previous.idle;
  previous = now;
  const percent = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  const load = os.loadavg()[0].toFixed(1);
  return { percent, detail: `load ${load} · ${os.cpus().length} cores` };
}

/** macOS counts file cache as used; memory_pressure reports what is really available. */
async function ram() {
  const totalGb = os.totalmem() / GiB;
  let freePercent: number | null = null;
  try {
    const { stdout } = await run("/usr/bin/memory_pressure", ["-Q"], { timeout: 5000 });
    const match = stdout.match(/free percentage:\s*(\d+)%/);
    if (match) freePercent = Number(match[1]);
  } catch {
    // fall back to os.freemem below
  }
  const percent = freePercent !== null ? 100 - freePercent : Math.round((1 - os.freemem() / os.totalmem()) * 100);
  const usedGb = (totalGb * percent) / 100;
  return { percent, detail: `${usedGb.toFixed(1)} / ${totalGb.toFixed(0)} GB` };
}

/** Same numbers as `df` on the data volume: used / (used + available). */
async function disk() {
  const path = process.platform === "darwin" ? "/System/Volumes/Data" : "/";
  const s = await statfs(path);
  const used = (s.blocks - s.bfree) * s.bsize;
  const avail = s.bavail * s.bsize;
  const percent = Math.round((used / (used + avail)) * 100);
  return { percent, detail: `${(avail / GiB).toFixed(0)} GB free` };
}

export async function readStats() {
  const [c, r, d] = await Promise.all([cpu(), ram(), disk()]);
  return { cpu: c, ram: r, disk: d };
}
